// ACCEPTANCE: a MANUAL INTERRUPT stops the parent turn's sub-agents ("Stop means stop"). This is the
// DELIBERATE counterpart to acceptance-subagent-survival.mjs: a hub RESTART preserves the sub-agent
// subtree (the operator did not ask it to stop); a manual INTERRUPT ends it (the operator did). The two
// differ on purpose, and this guards the interrupt half.
//
// Physical evidence: a chat spawns a general-purpose sub-agent running a bash loop that writes
// step-NN.txt every 2s (30 files, ~60s). We interrupt the PARENT turn mid-flight; the sub-agent's file
// writes must STOP (its bash child was terminated), not keep appearing. Exit 0 when they stop (correct),
// exit 1 if the sub-agent kept running orphaned. Talks to the SANDBOX (7788, worker mode) — never 7777.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'

const PORT = 7788
const PROFILE = process.env.PROBE_PROFILE ?? 'claude-a'
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-int-'))
const SENT = 'INT-' + Math.random().toString(36).slice(2, 8)
const t0 = Date.now()
const step = (m, x) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`, x !== undefined ? JSON.stringify(x) : '')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function req(method, p, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} },
      (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { try { resolve({ status: res.statusCode, json: b ? JSON.parse(b) : null }) } catch { resolve({ status: res.statusCode, raw: b }) } }) })
    r.on('error', () => resolve(null)); if (data) r.write(data); r.end()
  })
}
const sessionOf = async (sid) => { const r = await req('GET', '/api/sessions'); const l = r?.json; return Array.isArray(l) ? l.find((s) => s.id === sid) : null }
const files = () => { try { return fs.readdirSync(WORK).filter((f) => f.startsWith('step-')).sort() } catch { return [] } }

;(async () => {
  step(`work dir ${WORK}`)
  const prompt =
    `You MUST use the Task tool to launch ONE sub-agent (subagent_type "general-purpose"). Do NOT do the work yourself. ` +
    `Give the sub-agent EXACTLY this instruction: "Run this single bash command, then report done: ` +
    `for i in \$(seq -w 1 30); do echo ${SENT}-\$i > step-\$i.txt; sleep 2; done". ` +
    `After it finishes, reply ${SENT}-DONE`
  const create = await req('POST', '/api/sessions', { profileId: PROFILE, cwd: WORK, permissionMode: 'full', prompt })
  const sid = create?.json?.id
  if (!sid) { console.log('create failed', create); process.exit(1) }
  step(`session ${sid}`)

  // Wait for the sub-agent to start writing.
  let began = false
  for (let i = 0; i < 200; i++) { if (files().length >= 2) { began = true; break } const s = await sessionOf(sid); if (s && (s.status === 'error' || s.status === 'stopped')) { console.log('turn failed early', s.status); process.exit(1) } await sleep(500) }
  if (!began) { console.log('no files appeared — sub-agent never started'); process.exit(1) }
  const atInterrupt = files().length
  step(`sub-agent LIVE (${atInterrupt} files) — sending INTERRUPT to the parent`)
  const ir = await req('POST', `/api/sessions/${sid}/interrupt`)
  step(`interrupt -> HTTP ${ir?.status}`)
  const interruptMs = Date.now() - t0

  // Watch whether files keep appearing after the interrupt.
  const samples = []
  for (let i = 0; i < 12; i++) { await sleep(2000); samples.push({ t: +((Date.now() - t0) / 1000).toFixed(1), files: files().length }) }
  const finalCount = files().length
  const grewAfterInterrupt = finalCount > atInterrupt + 1 // +1 tolerance for an already-in-flight write

  const s = await sessionOf(sid)
  const events = (await req('GET', '/api/events?since=0'))?.json ?? []
  const sess = events.filter((e) => e.sessionId === sid)
  // Rough seq of the interrupt: the session/status 'interrupted' or the note.
  const interruptedNote = sess.some((e) => { try { return JSON.stringify(e.payload).toLowerCase().includes('interrupt') } catch { return false } })
  const subAgentEvents = sess.filter((e) => { try { return e.payload && e.payload.parent_tool_use_id != null } catch { return false } })
  const doneInJournal = sess.some((e) => { try { return JSON.stringify(e.payload).includes(SENT + '-DONE') } catch { return false } })

  const verdict = grewAfterInterrupt
    ? (finalCount >= 30 ? 'SURVIVED_TO_COMPLETION' : 'ORPHANED_STILL_RUNNING')
    : 'KILLED_AT_INTERRUPT'
  const stopped = !grewAfterInterrupt // the PROPERTY: interrupt terminated the sub-agent's work
  console.log('\n=== INTERRUPT STOPS SUB-AGENTS ' + (stopped ? 'PASS ✅' : 'FAIL ❌') + ' ===', JSON.stringify({
    verdict, sentinel: SENT, filesAtInterrupt: atInterrupt, filesFinal: finalCount, grewAfterInterrupt,
    interruptMs: +interruptMs.toFixed(0), finalStatus: s?.status ?? '(gone)', interruptedNote,
    subAgentEventCount: subAgentEvents.length,
    // NOTE: doneInJournal is the PROMPT echo (the prompt names the DONE token) — not proof of completion.
    doneTokenInJournal_promptEcho: doneInJournal, samples, workDir: WORK,
  }, null, 2))
  process.exit(stopped ? 0 : 1)
})().catch((e) => { console.error('FATAL', e); process.exit(1) })

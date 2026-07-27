// Drive the SANDBOX hub from the command line: create chats, send turns, answer approvals, interrupt,
// stop, restart, and read back what the journal actually recorded.
//
//   node scripts/sandbox-drive.mjs sessions
//   node scripts/sandbox-drive.mjs chat --profile claude-a "say hello then stop"
//   node scripts/sandbox-drive.mjs send <sessionId> "another turn"
//   node scripts/sandbox-drive.mjs watch [sessionId]        # live event tail
//   node scripts/sandbox-drive.mjs approvals
//   node scripts/sandbox-drive.mjs approve <approvalId> [--deny]
//   node scripts/sandbox-drive.mjs interrupt|stop|reopen|delete <sessionId>
//   node scripts/sandbox-drive.mjs restart                  # blue-green flip
//   node scripts/sandbox-drive.mjs journal <sessionId> [--kinds]
//
// WHY A DRIVER AND NOT JUST THE UI. Most of what has been wrong in this app is not visible on screen: a
// status that never journaled, an error card that should not exist, a queued message spent on the wrong
// boundary, a stopped chat quietly revived. Those are claims about the JOURNAL, and the only honest way to
// check them is to make something happen and then read the durable record back. `journal --kinds` exists
// for exactly that: it prints the event sequence a scenario produced, which is what assertions should be
// written against rather than a screenshot.
//
// It talks to the sandbox (7788) and REFUSES the live hub, for the same reason sandbox.mjs does: a driver
// pointed at 7777 would spawn real agents in the operator's workspace and spend real tokens.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PORT = Number(process.env.SANDBOX_PORT ?? 7788)
if (PORT === 7777) {
  console.error('refusing to drive port 7777: that is the live hub.')
  process.exit(2)
}

const argv = process.argv.slice(2)
const cmd = argv[0]
const REPO = path.resolve(fileURLToPath(import.meta.url), '..', '..')
const SANDBOX_ROOT = process.env.SANDBOX_DIR ?? path.join(REPO, '.sandbox')
const DEVICE_TOKEN = fs.readFileSync(path.join(SANDBOX_ROOT, 'data', 'device-token.txt'), 'utf8').trim()

// Flags that CONSUME the next token. Filtering on `startsWith('--')` alone drops the flag but leaves its
// value in the positional list, so `chat --profile claude-a "prompt"` silently sent "claude-a" as the
// prompt — a wrong-argument bug that looks like a working command, which is the worst kind.
const VALUE_FLAGS = new Set(['--profile', '--timeout'])
const flags = new Set()
const values = new Map()
const args = []
for (let i = 1; i < argv.length; i++) {
  const a = argv[i]
  if (VALUE_FLAGS.has(a)) values.set(a, argv[++i])
  else if (a.startsWith('--')) flags.add(a)
  else args.push(a)
}
const flagValue = (name) => values.get(name)

function req(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null
    const r = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        method,
        path: pathname,
        headers: {
          authorization: `Bearer ${DEVICE_TOKEN}`,
          ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let b = ''
        res.on('data', (c) => (b += c))
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, json: b ? JSON.parse(b) : null })
          } catch {
            resolve({ status: res.statusCode, raw: b })
          }
        })
      }
    )
    r.on('error', reject)
    if (data) r.write(data)
    r.end()
  })
}

const die = (msg) => {
  console.error(msg)
  process.exit(1)
}
async function assertUp() {
  try {
    await req('GET', '/api/health')
  } catch {
    die(`no sandbox hub on ${PORT}. Run 'node scripts/sandbox.mjs up' first.`)
  }
}

/** Stream journal events over the same WebSocket the app uses. Node 22 has a global WebSocket. */
function openStream(onEvent, since = 0) {
  const ws = new WebSocket(
    `ws://127.0.0.1:${PORT}/ws?since=${since}&token=${encodeURIComponent(DEVICE_TOKEN)}`
  )
  ws.addEventListener('message', (m) => {
    for (const line of String(m.data).split('\n')) {
      if (!line.trim()) continue
      try {
        onEvent(JSON.parse(line))
      } catch {
        /* a non-JSON frame is not worth aborting a tail for */
      }
    }
  })
  return ws
}

const fmt = (e) => {
  const p = e.payload ?? {}
  const detail =
    e.kind === 'session/status' ? p.status
    : e.kind === 'session/input' ? JSON.stringify(String(p.text ?? '').slice(0, 60))
    : e.kind === 'session/error' ? JSON.stringify(String(p.message ?? '').slice(0, 80))
    : e.kind === 'claude/assistant' || e.kind === 'claude/result' ? ''
    : ''
  return `${String(e.seq).padStart(5)}  ${(e.sessionId ?? '-').slice(0, 8)}  ${e.kind}${detail ? '  ' + detail : ''}`
}

const commands = {
  async sessions() {
    const { json } = await req('GET', '/api/sessions')
    for (const s of json ?? []) console.log(`${s.id}  ${s.status.padEnd(8)}  ${s.provider}/${s.profileId}  ${s.title ?? ''}`)
  },

  async profiles() {
    const { json } = await req('GET', '/api/profiles')
    for (const p of json ?? []) console.log(`${p.id}  ${p.provider}`)
  },

  /** Spawn a chat, send the first turn, and stream until it settles — the common end-to-end case. */
  async chat() {
    const prompt = args[0] ?? die('usage: chat [--profile <id>] "<prompt>"')
    const profileId = flagValue('--profile') ?? (await req('GET', '/api/profiles')).json?.[0]?.id
    if (!profileId) die('no profiles available')
    const { json, status } = await req('POST', '/api/sessions', { profileId, prompt })
    if (!json?.id) die(`spawn failed (${status}): ${JSON.stringify(json)}`)
    console.log(`session ${json.id}  profile ${profileId}`)
    await commands.watchUntilIdle(json.id)
  },

  async send() {
    const [sid, text] = [args[0] ?? die('usage: send <sessionId> "<text>"'), args[1] ?? die('missing text')]
    const r = await req('POST', `/api/sessions/${sid}/input`, { text })
    console.log(JSON.stringify(r.json))
    await commands.watchUntilIdle(sid)
  },

  /** Tail everything, or one session. Ctrl-C to stop. */
  async watch() {
    const sid = args[0]
    openStream((e) => {
      if (!sid || e.sessionId === sid) console.log(fmt(e))
    })
    await new Promise(() => {}) // until interrupted
  },

  /** Stream one session's events until it reaches a terminal status, then report the outcome. */
  async watchUntilIdle(sessionId = args[0]) {
    const timeoutMs = Number(flagValue('--timeout') ?? 180000)
    await new Promise((resolve) => {
      // A NEW chat is set idle at creation, BEFORE its first turn starts. Treating the first idle as
      // terminal made a healthy turn look like it never ran: the driver reported "settled" while the
      // agent was still thinking, and the journal afterwards showed the full active→result→idle sequence
      // it had simply stopped listening for. So idle only counts once the turn has actually begun;
      // error/stopped are terminal whenever they arrive.
      let started = false
      const ws = openStream((e) => {
        if (e.sessionId !== sessionId) return
        console.log(fmt(e))
        if (e.kind !== 'session/status') return
        const s = e.payload?.status
        if (s === 'active' || s === 'starting') started = true
        const terminal = s === 'error' || s === 'stopped' || (s === 'idle' && started)
        if (terminal) {
          ws.close()
          resolve()
        }
      })
      setTimeout(() => {
        console.log('(timeout waiting for a terminal status)')
        ws.close()
        resolve()
      }, timeoutMs).unref?.()
    })
  },

  /** Set a chat's permission mode, so "does Full actually stop prompting" can be tested rather than argued. */
  async mode() {
    const [sid, mode] = [args[0] ?? die('usage: mode <sessionId> <safe|edits|full>'), args[1] ?? die('need a mode')]
    const r = await req('POST', `/api/sessions/${sid}/mode`, { permissionMode: mode })
    console.log(JSON.stringify(r.json))
  },

  async approvals() {
    const { json } = await req('GET', '/api/approvals')
    for (const a of json ?? []) console.log(`${a.id}  ${a.sessionId?.slice(0, 8)}  ${a.kind}  ${JSON.stringify(a.payload).slice(0, 120)}`)
    if (!json?.length) console.log('(none pending)')
  },

  async approve() {
    const id = args[0] ?? die('usage: approve <approvalId> [--deny]')
    const r = await req('POST', `/api/approvals/${id}`, { approve: !flags.has('--deny') })
    console.log(JSON.stringify(r.json))
  },

  async interrupt() {
    console.log(JSON.stringify((await req('POST', `/api/sessions/${args[0] ?? die('need sessionId')}/interrupt`)).json))
  },
  async stop() {
    console.log(JSON.stringify((await req('POST', `/api/sessions/${args[0] ?? die('need sessionId')}/stop`)).json))
  },
  async reopen() {
    console.log(JSON.stringify((await req('POST', `/api/sessions/${args[0] ?? die('need sessionId')}/reopen`)).json))
  },
  async delete() {
    console.log(JSON.stringify((await req('POST', `/api/sessions/${args[0] ?? die('need sessionId')}/delete`)).json))
  },

  /** Blue-green flip. The sandbox is the only place this should ever be exercised casually. */
  async restart() {
    const before = (await req('GET', '/api/health')).json
    console.log('before', JSON.stringify(before))
    console.log(JSON.stringify((await req('POST', '/api/restart', { reason: 'sandbox-drive' })).json))
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 500))
      const h = await req('GET', '/api/health').catch(() => null)
      if (h?.json && JSON.stringify(h.json) !== JSON.stringify(before)) {
        console.log('after ', JSON.stringify(h.json))
        return
      }
    }
    // Most often this is a DEFERRED flip, not a failure: the hub waits for a turn boundary before
    // swapping. Saying "health never changed" invited exactly the wrong conclusion.
    console.log('(no flip observed — most likely deferred because a turn is live; check `sandbox logs`)')
  },

  /**
   * Read the durable record back. `--kinds` prints just the event sequence, which is the shape most
   * assertions actually want: "did a stopped chat get a session/error", "was there exactly one
   * session/input", "did status go active → idle or straight to error".
   */
  async journal() {
    const sid = args[0] ?? die('usage: journal <sessionId> [--kinds]')
    const events = []
    await new Promise((resolve) => {
      const ws = openStream((e) => {
        if (e.sessionId === sid) events.push(e)
      })
      // The replay is synchronous server-side; give it a beat, then report what arrived.
      setTimeout(() => {
        ws.close()
        resolve()
      }, 1500)
    })
    if (flags.has('--kinds')) {
      const counts = new Map()
      for (const e of events) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1)
      console.log(events.map((e) => e.kind).join('\n'))
      console.log('\n--- counts ---')
      for (const [k, n] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`${String(n).padStart(4)}  ${k}`)
    } else {
      for (const e of events) console.log(fmt(e))
    }
  },
}

const run = commands[cmd]
if (!run) {
  console.error(`unknown command '${cmd ?? ''}'.\nUse: ${Object.keys(commands).filter((k) => k !== 'watchUntilIdle').join(' | ')}`)
  process.exit(2)
}
await assertUp()
await run()
process.exit(0)

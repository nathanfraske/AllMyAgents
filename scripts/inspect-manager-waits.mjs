// Bounded, read-only diagnostics: never instantiate Journal or hydrate blob payloads.
import { createRequire } from 'node:module'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

if (process.argv[2] !== '--child') {
  const [, , file, session, requestedLimit, from = '', to = ''] = process.argv
  if (!file || !session) throw new Error('Usage: node scripts/inspect-manager-waits.mjs <hub.db> <session-id> [limit<=20000] [from-ISO] [to-ISO]')
  const limit = requestedLimit === undefined ? 4000 : Number(requestedLimit)
  if (!Number.isInteger(limit) || limit < 1 || limit > 20_000) throw new Error('limit must be an integer from 1 to 20000')
  const child = fork(fileURLToPath(import.meta.url), ['--child', path.resolve(file), session, String(limit), from, to], {
    windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  })
  const deadline = setTimeout(() => { console.error('Diagnostic exceeded 45 seconds'); child.kill(); process.exitCode = 1 }, 45_000)
  child.on('message', value => console.log(JSON.stringify(value)))
  child.stderr.on('data', bytes => process.stderr.write(bytes))
  child.on('error', error => { console.error(error.message); process.exitCode = 1 })
  child.on('exit', code => { clearTimeout(deadline); if (code !== 0) process.exitCode = 1 })
} else {
  const require = createRequire(new URL('../apps/hub/package.json', import.meta.url))
  const Database = require('better-sqlite3')
  const db = new Database(process.argv[3], { readonly: true, fileMustExist: true, timeout: 1000 })
  const session = process.argv[4]
  const start = performance.now()
  let rows
  let record
  try {
    db.pragma('query_only=ON')
    const stored = db.prepare('SELECT record FROM sessions WHERE id=?').get(session)
    if (stored) {
      const r = JSON.parse(stored.record)
      record = Object.fromEntries(['id','name','profileId','provider','vendorSessionId','status','projectId','isProjectManager','lastActivity'].filter(k => k in r).map(k => [k,r[k]]))
      record.identityKeys = Object.keys(r).filter(k => /thread|vendor|session|goal/i.test(k))
    }
    rows = db.prepare(`SELECT e.seq, e.ts, e.kind,
      CASE WHEN length(e.payload) <= 262144 THEN e.payload ELSE NULL END AS payload
      FROM journal_session_event_index i JOIN events e ON e.seq=i.seq
      WHERE i.session=? ORDER BY i.seq DESC LIMIT ?`).all(session, Number(process.argv[5]))
  } finally { db.close() }
  if (process.argv[6]) rows = rows.filter(row => row.ts >= process.argv[6])
  if (process.argv[7]) rows = rows.filter(row => row.ts <= process.argv[7])
  const kinds = {}, calls = {}, tokens = [], samples = [], lifecycle = [], waits = [], goals = []
  let skippedPayloads = 0
  for (const row of rows.reverse()) {
    kinds[row.kind] = (kinds[row.kind] ?? 0) + 1
    if (!row.payload) { skippedPayloads++; continue }
    let p
    try { p = JSON.parse(row.payload) } catch { continue }
    if (row.kind === 'session/tokens') tokens.push({ seq: row.seq, ts: row.ts, ...p })
    if (/goal\/updated/.test(row.kind)) goals.push({ seq: row.seq, ts: row.ts, keys: Object.keys(p), goal: p.goal })
    if (row.kind === 'codex/item/completed') {
      const item = p.item ?? p
      const key = [item.type, item.tool ?? item.name ?? ''].join(':')
      calls[key] = (calls[key] ?? 0) + 1
      if (item.type === 'commandExecution' && /wait|sleep/i.test(item.command ?? '')) waits.push({ seq: row.seq, ts: row.ts, type: item.type, containsWaitOrSleep: true, durationMs: item.durationMs, exitCode: item.exitCode })
      if (item.type === 'agentMessage' && /\bwait|\byield|\bpoll/i.test(item.text ?? '')) waits.push({ seq: row.seq, ts: row.ts, type: item.type, text: item.text?.slice(0,650), phase: item.phase })
      if (samples.length < 30 || /wait|sleep/i.test(key)) samples.push({ seq: row.seq, ts: row.ts, type: item.type,
        tool: item.tool, name: item.name, keys: Object.keys(item), durationMs: item.durationMs,
        status: item.status, argumentKeys: item.arguments && typeof item.arguments === 'object' ? Object.keys(item.arguments) : undefined,
        ...(/wait/i.test(key) ? { receiverThreadIds: item.receiverThreadIds, toolCallId: item.callId } : {}),
      })
    }
    if (/assistant-pulse|run.*deliver|run.*notifi|continuation|turn-origin|operator-input|bus\/delivered|codex\/turn\/(started|completed)/.test(row.kind)) {
      lifecycle.push({ seq: row.seq, ts: row.ts, kind: row.kind, keys: Object.keys(p), subject: p.subject, origin: p.origin, turnId: p.turn?.id, status: p.turn?.status })
    }
  }
  const first = tokens[0], last = tokens.at(-1)
  const counterKeys = ['input','cachedInput','output','reasoningOutput','total']
  const monotonic = tokens.every((token, i) => counterKeys.every(key => Number.isFinite(token[key]) && (i === 0 || token[key] >= tokens[i-1][key])))
  const delta = first && last && monotonic ? Object.fromEntries(counterKeys.map(key => [key,last[key]-first[key]])) : undefined
  process.send({ session, record, elapsedMs: Math.round(performance.now()-start), rows: rows.length, from: rows[0]?.ts, to: rows.at(-1)?.ts,
    skippedPayloads, kinds, calls, tokenNotifications: tokens.length, firstTokens: first, lastTokens: last, delta,
    ...(!monotonic ? { tokenWarning: 'Counters reset or are incomplete; no endpoint difference is reported.' } : {}),
    samples: samples.filter(s => !['reasoning','agentMessage','userMessage'].includes(s.type)).slice(-10), lifecycle: lifecycle.slice(-50), waits: waits.slice(-30), goals: goals.slice(-2) })
}

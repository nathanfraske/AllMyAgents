// Hold a conversation with an agent running inside the hub, from outside it.
//
//   node scripts/confer.mjs who                          # who is here, and what are they doing
//   node scripts/confer.mjs ask <idPrefix> "question"    # send, WAIT for the reply, print it
//   node scripts/confer.mjs ask <idPrefix> --file p.txt  # same, body from a file (long prompts)
//   node scripts/confer.mjs last <idPrefix>              # print their most recent reply, send nothing
//   node scripts/confer.mjs wait <idPrefix>              # block until they finish, then print
//
//   --port 7788    talk to the sandbox instead of the live hub
//
// WHY THIS EXISTS. Agents inside the hub reach each other over the bus (send_message / read_messages),
// and the hub pushes a teammate's message into the recipient's next turn. A Claude Code instance running
// in the operator's terminal is NOT one of those sessions: it has no hub identity, so nothing can be
// delivered to it and it has no inbox to read. The asymmetry is real and worth naming — an agent in the
// hub can be collaborated with; an agent outside it could only fire and forget.
//
// So this is the outside half of the channel. Sending is easy (the hub already accepts operator input on
// any session). The part that makes it a CONVERSATION rather than a broadcast is waiting for the reply and
// reading it back, which is what `ask` does: it records where the transcript ends, sends, waits for the
// session to leave `active`, and prints only what was added.
//
// This is a stopgap. The right long-term answer is docs/external-access.md §B — an outward-facing MCP
// endpoint would let an outside agent use the real bus tools instead of poll-and-diff over HTTP.

import fs from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const argv = process.argv.slice(2)
const portIdx = argv.indexOf('--port')
const PORT = portIdx >= 0 ? argv[portIdx + 1] : '7777'
const fileIdx = argv.indexOf('--file')
const FILE = fileIdx >= 0 ? argv[fileIdx + 1] : null
const positional = argv.filter((a, i) => {
  if (a === '--port' || a === '--file') return false
  if (portIdx >= 0 && i === portIdx + 1) return false
  if (fileIdx >= 0 && i === fileIdx + 1) return false
  return true
})
const BASE = `http://127.0.0.1:${PORT}`

const die = (m) => {
  console.error(`error: ${m}`)
  process.exit(1)
}

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    return { __raw: text.slice(0, 300), __status: res.status }
  }
}

const sessions = () => api('GET', '/api/sessions')

/** Resolve a short id prefix to a full session. Refuses an ambiguous prefix rather than guessing. */
async function resolve(prefix) {
  if (!prefix) die('need a session id (or a unique prefix of one) — try: confer.mjs who')
  const all = await sessions()
  const hits = all.filter((s) => s.id.startsWith(prefix) || (s.title ?? '').toLowerCase() === prefix.toLowerCase())
  if (hits.length === 0) die(`no session matches '${prefix}'`)
  if (hits.length > 1) die(`'${prefix}' is ambiguous: ${hits.map((s) => s.id.slice(0, 8)).join(', ')}`)
  return hits[0]
}

/**
 * The recent events for one session.
 *
 * READS THE JOURNAL DIRECTLY, and the HTTP path is only a fallback, because `/api/events?since=0`
 * materialises the ENTIRE journal into one response — every row the hub has ever written. That is
 * survivable on a fresh hub and fatal on a real one: against the operator's live hub (375k rows, 318MB
 * of payload) it reset the connection mid-transfer and took this tool down with ECONNRESET. A
 * coordination channel that stops working precisely as a hub gets busy is worse than no channel, because
 * it fails at the moment you are relying on it.
 *
 * A bounded `ORDER BY seq DESC LIMIT n` returns in milliseconds regardless of journal size. The HTTP
 * fallback stays for a hub whose DB we cannot locate, with a `since` floor so it can never ask for
 * everything again.
 */
function dbPathFor(port) {
  if (process.env.AMA_DB) return process.env.AMA_DB
  return port === '7788' ? '.sandbox/data/hub.db' : 'data/hub.db'
}

async function eventsFor(sessionId, limit = 400) {
  const dbPath = dbPathFor(PORT)
  if (fs.existsSync(dbPath)) {
    try {
      const { createRequire } = await import('node:module')
      const require = createRequire(new URL('../apps/hub/package.json', import.meta.url))
      const Database = require('better-sqlite3')
      const db = new Database(dbPath, { readonly: true })
      try {
        const rows = db
          .prepare('SELECT seq, ts, session, kind, payload FROM events WHERE session = ? ORDER BY seq DESC LIMIT ?')
          .all(sessionId, limit)
        return rows
          .reverse()
          .map((r) => ({ seq: r.seq, ts: r.ts, sessionId: r.session, kind: r.kind, payload: safeParse(r.payload) }))
      } finally {
        db.close()
      }
    } catch {
      // fall through to HTTP
    }
  }
  // Fallback: ask for a recent window only. Never `since=0` — see above.
  const all = await api('GET', '/api/events?since=0')
  return Array.isArray(all) ? all.filter((e) => e.sessionId === sessionId) : []
}

function safeParse(raw) {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/**
 * The agent's own prose, from either vendor.
 *
 * Claude puts it in `claude/assistant` as content blocks; Codex completes an `agentMessage` item. Tool
 * calls, reasoning and deltas are deliberately skipped — the point is to read what the agent SAID, not to
 * reconstruct its work. Returns newest-last.
 */
function messages(events) {
  const out = []
  for (const e of events) {
    const p = e.payload
    if (!p || typeof p !== 'object') continue
    if (e.kind === 'claude/assistant') {
      const blocks = p.message?.content ?? p.content
      if (Array.isArray(blocks)) {
        const text = blocks.filter((b) => b?.type === 'text').map((b) => b.text).join('')
        if (text.trim()) out.push({ seq: e.seq, text })
      }
    } else if (e.kind === 'codex/item/completed') {
      const it = p.item
      if (it && (it.type === 'agentMessage' || it.type === 'assistantMessage')) {
        const text = it.text ?? it.message ?? ''
        if (String(text).trim()) out.push({ seq: e.seq, text: String(text) })
      }
    }
  }
  return out
}

/** Block until the session stops working. `active`/`starting` mean a turn is in flight. */
async function waitIdle(id, { quiet = false } = {}) {
  let spins = 0
  for (;;) {
    const s = (await sessions()).find((x) => x.id === id)
    if (!s) die('session disappeared')
    if (s.status !== 'active' && s.status !== 'starting') return s
    if (!quiet && spins % 6 === 0) process.stderr.write(`  …${s.title ?? id.slice(0, 8)} is working (${s.status})\n`)
    spins++
    await sleep(5000)
  }
}

const CMDS = {
  async who() {
    const all = await sessions()
    if (!all.length) return console.log('(no sessions)')
    for (const s of all) {
      const flag = s.status === 'active' ? '*' : ' '
      console.log(`${flag} ${s.id.slice(0, 8)}  ${(s.title ?? '-').padEnd(18)} ${s.status.padEnd(8)} ${s.provider}/${s.profileId}  ${s.model ?? ''}${s.effort ? '/' + s.effort : ''}`)
    }
    console.log('\n* = mid-turn')
  },

  async last() {
    const s = await resolve(positional[1])
    const msgs = messages(await eventsFor(s.id))
    if (!msgs.length) return console.log('(nothing said yet)')
    console.log(msgs[msgs.length - 1].text)
  },

  async wait() {
    const s = await resolve(positional[1])
    await waitIdle(s.id)
    await CMDS.last()
  },

  async ask() {
    const s = await resolve(positional[1])
    const body = FILE ? fs.readFileSync(FILE, 'utf8') : positional.slice(2).join(' ')
    if (!body.trim()) die('nothing to say — pass a message or --file <path>')

    // Where the transcript ends BEFORE we speak. Everything after this seq is the reply, which is what
    // makes this a conversation rather than "print the last thing said" — on a long-running agent those
    // are very different, and the difference is invisible until it burns you.
    const before = messages(await eventsFor(s.id))
    const mark = before.length ? before[before.length - 1].seq : 0

    // THE HUB DOES NOT QUEUE. `sessions.send` REJECTS while a turn is in flight — the queue lives in the
    // web client, not the API. An earlier version of this script assumed otherwise, printed "the hub will
    // deliver this after", and dropped the message on the floor when the POST came back
    // "a turn is already in progress". Reporting a send that did not happen is worse than failing, because
    // the caller then waits for a reply to a question nobody was ever asked.
    //
    // So wait for the agent to actually be free, then send.
    if (s.status === 'active' || s.status === 'starting') {
      process.stderr.write(`  ${s.title ?? s.id.slice(0, 8)} is mid-turn — waiting for it to finish before sending…\n`)
      await waitIdle(s.id, { quiet: true })
    }

    let res = await api('POST', `/api/sessions/${s.id}/input`, { text: body })
    // Lost the race: it started another turn between our idle check and our POST. Wait it out and retry
    // rather than failing, since the whole point of this path is an unattended hand-off.
    for (let attempt = 0; attempt < 20 && /turn is already in progress/i.test(res?.error ?? ''); attempt++) {
      await waitIdle(s.id, { quiet: true })
      res = await api('POST', `/api/sessions/${s.id}/input`, { text: body })
    }
    if (res?.error) die(`hub refused the message: ${res.error}`)
    process.stderr.write(`  sent to ${s.title ?? s.id.slice(0, 8)}; waiting for the reply…\n`)

    await sleep(3000) // let the turn actually start, so we don't read the pre-turn idle
    await waitIdle(s.id)

    const after = messages(await eventsFor(s.id)).filter((m) => m.seq > mark)
    if (!after.length) {
      console.log('(the turn ended without the agent saying anything — it may have only run tools)')
      return
    }
    console.log(after.map((m) => m.text).join('\n\n'))
  },
}

const cmd = positional[0]
const fn = CMDS[cmd]
if (!fn) {
  console.error(`unknown command '${cmd ?? ''}'. Use: who | ask | last | wait   [--port N] [--file P]`)
  process.exit(1)
}
await fn()

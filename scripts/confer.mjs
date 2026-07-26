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
 * Every event for one session, read over HTTP so this works against any hub without knowing where its
 * SQLite file lives. `/api/events` pages the whole journal gap-free, which is more than we need but is
 * the only endpoint that exposes the transcript without a WebSocket.
 */
async function eventsFor(sessionId) {
  const all = await api('GET', '/api/events?since=0')
  return Array.isArray(all) ? all.filter((e) => e.sessionId === sessionId) : []
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

    // A busy agent would silently queue this; better to say so than to appear hung.
    if (s.status === 'active' || s.status === 'starting') {
      process.stderr.write(`  (${s.title ?? s.id.slice(0, 8)} is mid-turn; the hub will deliver this after)\n`)
    }

    const res = await api('POST', `/api/sessions/${s.id}/input`, { text: body })
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

// What is every agent actually doing, and does anything need me RIGHT NOW.
//
//   node scripts/fleet-watch.mjs            # one report
//   node scripts/fleet-watch.mjs --json     # same, machine-readable
//
// WHY THIS EXISTS. Managing this fleet by polling `confer who` missed two failures in one session, both
// invisible from a status column:
//
//   1. Every dispatch silently 401'd for half an hour after the control plane started requiring a device
//      token. confer exited 0, printed nothing, and the agents simply never heard. Status said "idle",
//      which is what an agent with nothing to do looks like.
//   2. An agent nudged with "continue" resumed a task from an hour earlier, because the brief it was
//      supposedly stuck on had never arrived. Status said "active". It was working — on the wrong thing.
//
// So a status column is not monitoring. The question worth answering is DID MY LAST MESSAGE REACH THEM,
// and every field below exists to answer some version of that.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const PORT = process.env.AMA_PORT ?? '7777'
const BASE = `http://127.0.0.1:${PORT}`
const asJson = process.argv.includes('--json')

function installedDataDir() {
  if (process.platform === 'win32') {
    return process.env.APPDATA ? path.join(process.env.APPDATA, 'AllMyAgents', 'data') : null
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'AllMyAgents', 'data')
  }
  return path.join(os.homedir(), '.local', 'share', 'AllMyAgents', 'data')
}

function deviceToken() {
  if (process.env.HUB_DEVICE_TOKEN) return process.env.HUB_DEVICE_TOKEN
  const dir = installedDataDir()
  for (const file of [dir && path.join(dir, 'device-token.txt'), 'data/device-token.txt'].filter(Boolean)) {
    try {
      const v = fs.readFileSync(file, 'utf8').trim()
      if (v.length >= 32) return v
    } catch {
      /* next */
    }
  }
  return null
}

const TOKEN = deviceToken()

async function api(pathname) {
  const res = await fetch(`${BASE}${pathname}`, {
    headers: TOKEN ? { authorization: `Bearer ${TOKEN}` } : {},
  })
  const body = await res.json().catch(() => null)
  // A refusal is DATA, not an exception. The whole point of this tool is to notice that the hub said no —
  // the previous generation of this logic treated {error} as a list and crashed on `.filter`.
  if (!res.ok || !Array.isArray(body)) {
    throw new Error(
      `${pathname} -> HTTP ${res.status}${body && body.error ? `: ${body.error}` : ''}` +
        (TOKEN ? '' : ' (no device token found — every call will be refused)')
    )
  }
  return body
}

/**
 * The most recent row of each interesting KIND for one session.
 *
 * Deliberately one query per kind rather than "last N events, then filter". A busy agent emits thousands
 * of streaming rows per turn, so any fixed window is all codex/* deltas and the session/input that
 * started it sits far outside. The first version of this tool took the last 40 and reported NEVER
 * MESSAGED for the entire fleet — confidently, and about agents I had just briefed. A monitor that lies
 * in the reassuring direction would be bad; this one lied in the alarming direction, which is only
 * better by luck.
 */
function lastOfEachKind(sessionId) {
  const dir = installedDataDir()
  const db = dir ? path.join(dir, 'hub.db') : 'data/hub.db'
  const script = `
    const D=require('better-sqlite3');const d=new D(${JSON.stringify(db)},{readonly:true});
    const one=(sql,...a)=>d.prepare(sql).get(${JSON.stringify(sessionId)},...a)??null;
    process.stdout.write(JSON.stringify({
      input: one("SELECT kind,payload,ts FROM events WHERE session=? AND kind='session/input' ORDER BY seq DESC LIMIT 1"),
      reply: one("SELECT kind,payload,ts FROM events WHERE session=? AND kind IN ('codex/item/completed','claude/assistant') ORDER BY seq DESC LIMIT 1"),
      error: one("SELECT kind,payload,ts FROM events WHERE session=? AND kind='session/error' ORDER BY seq DESC LIMIT 1"),
    }));`
  try {
    return JSON.parse(execFileSync(process.execPath, ['-e', script], { cwd: 'apps/hub', encoding: 'utf8' }))
  } catch {
    return { input: null, reply: null, error: null }
  }
}

const AGENT_TITLES =
  /simon|strachey|naur|cori|blackburn|burnell|knuth|sparck|iverson|kahn|cerf|gauss|kleene|cannon|mcclintock|blum|boole/i

/**
 * Did this agent actually DO anything, or just answer?
 *
 * "Replied" is not progress. An agent replied "No action; this is addressed to Strachey" — declining an
 * assignment it had misread as someone else's — and the monitor reported it as healthy, because a reply
 * had arrived and a reply was all it checked. The work sat unowned until I happened to read the text.
 *
 * So correlate against the repository: commits on the agent's branch and uncommitted changes in its
 * worktree. An agent that answered and produced neither is either declining, blocked, or done — and all
 * three need me to read what it said rather than trust a status.
 */
function repoActivity(sessionId, sinceIso) {
  const short = sessionId.slice(0, 8)
  const branch = `agent/${short}`
  const worktrees = [
    process.env.APPDATA &&
      path.join(process.env.APPDATA, '..', 'Local', 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Roaming', 'AllMyAgents', 'data', 'worktrees', short),
    installedDataDir() && path.join(installedDataDir(), 'worktrees', short),
  ].filter(Boolean)

  // Commits SINCE the brief, not commits-not-yet-on-main. `main..branch` collapses to zero the moment I
  // merge, so an agent whose work already landed reported as having done nothing — which is how this tool
  // libelled Naur minutes after merging two of its commits. What I actually want to know is whether it
  // produced anything after I last spoke to it, and that stays true after integration.
  let sinceBrief = 0
  let unmerged = 0
  try {
    unmerged = Number(
      execFileSync('git', ['rev-list', '--count', `main..${branch}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    )
  } catch {
    unmerged = 0
  }
  if (sinceIso) {
    try {
      const out = execFileSync('git', ['log', '--oneline', `--since=${sinceIso}`, branch], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      sinceBrief = out.split(/\r?\n/).filter((l) => l.trim()).length
    } catch {
      sinceBrief = 0
    }
  }
  const ahead = sinceBrief || unmerged

  let dirty = 0
  for (const wt of worktrees) {
    try {
      const out = execFileSync('git', ['-C', wt, 'status', '--porcelain'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      dirty = out
        .split(/\r?\n/)
        .filter((l) => l.trim() && !/^\?\? (\.sandbox|AGENTS\.md|CLAUDE\.md|\.audit|\.allmyagents|\.probe)/.test(l)).length
      break
    } catch {
      /* try the next candidate path */
    }
  }
  return { ahead, dirty }
}

/** First meaningful line of what they last said — so a decline is VISIBLE, not inferred. */
function replyGist(row) {
  if (!row) return null
  try {
    const payload = JSON.parse(row.payload)
    const text =
      payload?.item?.text ??
      (payload?.message?.content ?? []).map((c) => c.text).filter(Boolean).join(' ') ??
      ''
    return String(text).split(/\r?\n/).find((l) => l.trim())?.slice(0, 96) ?? null
  } catch {
    return null
  }
}

const report = []
let sessions
try {
  sessions = await api('/api/sessions')
} catch (error) {
  console.error(`fleet-watch: cannot read the hub — ${error.message}`)
  process.exit(2)
}

for (const s of sessions) {
  if (!AGENT_TITLES.test(s.title ?? '')) continue
  const { input: lastInput, reply: lastReply, error: lastError } = lastOfEachKind(s.id)

  // THE LOAD-BEARING COMPARISON. An agent is only "waiting on me" if my instruction is newer than
  // anything it has said back. Status alone cannot distinguish "idle, finished, awaiting orders" from
  // "idle because my message never arrived".
  const inputTs = lastInput ? Date.parse(lastInput.ts) : 0
  const replyTs = lastReply ? Date.parse(lastReply.ts) : 0
  const errorTs = lastError ? Date.parse(lastError.ts) : 0

  const { ahead, dirty } = repoActivity(s.id, lastInput ? lastInput.ts : null)

  let verdict
  if (s.status === 'active' || s.status === 'starting') verdict = 'working'
  else if (errorTs > inputTs) verdict = 'ERRORED after my message — send "continue"'
  else if (!lastInput) verdict = 'NEVER MESSAGED — nothing was ever sent to this agent'
  else if (inputTs > replyTs) verdict = 'NO REPLY to my last message — resend, do not "continue"'
  else if (ahead === 0 && dirty === 0)
    // The case that slipped past the previous version: answered, produced nothing, looked healthy.
    verdict = 'REPLIED BUT NO WORK — read the reply; it may be a decline or a blocker'
  else verdict = `done: ${ahead} commit(s) since brief${dirty ? `, ${dirty} uncommitted` : ''}`

  report.push({
    title: s.title,
    id: s.id.slice(0, 8),
    status: s.status,
    profile: s.profileId,
    verdict,
    lastInputAt: lastInput ? lastInput.ts.slice(11, 19) : null,
    lastReplyAt: lastReply ? lastReply.ts.slice(11, 19) : null,
    said: replyGist(lastReply),
    ahead,
    dirty,
    error: lastError ? String(JSON.parse(lastError.payload)?.message ?? '').slice(0, 90) : null,
  })
}

if (asJson) {
  console.log(JSON.stringify(report, null, 1))
} else {
  const needs = report.filter((r) => /ERRORED|NEVER MESSAGED|NO REPLY|NO WORK/.test(r.verdict))
  console.log(`\n${report.length} agents · ${report.filter((r) => r.status === 'active').length} working · ${needs.length} need attention\n`)
  for (const r of report) {
    const mark = /ERRORED|NEVER MESSAGED|NO REPLY|NO WORK/.test(r.verdict) ? '!' : ' '
    console.log(
      `${mark} ${(r.title ?? '').padEnd(12)} ${r.status.padEnd(8)} in:${(r.lastInputAt ?? '--').padEnd(9)} out:${(r.lastReplyAt ?? '--').padEnd(9)} ${r.verdict}`
    )
    // Print what they SAID, always. The decline that slipped past me was one line of plain English; no
    // amount of status-column cleverness substitutes for showing it.
    if (r.said) console.log(`               said: ${r.said}`)
    if (r.error) console.log(`               error: ${r.error}`)
  }
  console.log()
}

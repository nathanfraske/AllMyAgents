// Try to BREAK the sandbox hub, rather than confirm it works.
//
//   node scripts/sandbox-adversarial.mjs            # everything
//   node scripts/sandbox-adversarial.mjs danger     # one group
//
// WHY THIS IS SEPARATE FROM THE UNIT TESTS. The unit tests assert that each function does what it is
// supposed to. This asserts that the RUNNING SYSTEM refuses to do what it must not, under inputs nobody
// would type on purpose: garbage in the config file, hostile values on the API, flags flipped mid-turn,
// two writers racing the same file. Every check here is written as "this must NOT happen", because the
// bugs this project has actually shipped were all of that shape — a permission that silently widened, a
// setting that silently reverted, a crash loop from one malformed row.
//
// It talks to the SANDBOX (7788) and refuses 7777, for the same reason every other harness here does.

import { setTimeout as sleep } from 'node:timers/promises'
import fs from 'node:fs'
import path from 'node:path'

const PORT = 7788
const BASE = `http://127.0.0.1:${PORT}`
const SANDBOX_CONFIG = path.resolve('.sandbox/data/config.json')
const SANDBOX_TOKEN = path.resolve('.sandbox/data/device-token.txt')

if (process.env.HUB_PORT === '7777' || process.argv.includes('--port=7777')) {
  console.error('refusing to run against the live hub on 7777')
  process.exit(1)
}

let pass = 0
let fail = 0
const failures = []

function ok(name, detail = '') {
  pass++
  console.log(`  \x1b[32mPASS\x1b[0m ${name}${detail ? `  ${detail}` : ''}`)
}
function bad(name, detail) {
  fail++
  failures.push(`${name} — ${detail}`)
  console.log(`  \x1b[31mFAIL\x1b[0m ${name}  ${detail}`)
}
/**
 * Assert a MUST-NOT: `condition` true means the system held the line.
 *
 * `whyItFailed` is printed ONLY on failure. It used to print on both, which produced lines like
 * "PASS hub BOOTS with the poisoned row still on disk  did not come back within 30s" — a passing
 * assertion carrying its own failure message. Nothing was actually wrong, which is the problem: output
 * that contradicts itself on the happy path is output you stop reading, and then a real failure scrolls
 * past unnoticed.
 */
function must(name, condition, whyItFailed = '') {
  condition ? ok(name) : bad(name, whyItFailed || 'expected the system to refuse this')
}

async function api(method, pathname, body) {
  const token = fs.readFileSync(SANDBOX_TOKEN, 'utf8').trim()
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = { __raw: text.slice(0, 200) }
  }
  return { status: res.status, json }
}

const getDanger = async () => (await api('GET', '/api/config/danger')).json
const setDanger = async (patch) => (await api('POST', '/api/config/danger', patch)).json

// ---------------------------------------------------------------------------------------------
// DANGER ZONE — the flags decide whether an agent runs unattended. A wrong value here is the whole
// security model, so the interesting question is not "does the checkbox work" but "what does it do
// when fed something no checkbox could produce".
// ---------------------------------------------------------------------------------------------
async function groupDanger() {
  console.log('\n\x1b[1mDanger Zone — hostile input\x1b[0m')
  const before = await getDanger()

  // A non-boolean must be IGNORED, never coerced. Coercion is how "men" or "" or 0 silently turns a
  // deliberate ON into an OFF (or worse, the reverse) without the operator touching anything.
  await setDanger({ fullAccessAnyOrigin: true })
  for (const hostile of ['true', 1, 'yes', {}, [], null]) {
    const after = await setDanger({ fullAccessAnyOrigin: hostile })
    must(
      `non-boolean ${JSON.stringify(hostile)} does not change the flag`,
      after.fullAccessAnyOrigin === true,
      `flag is now ${JSON.stringify(after.fullAccessAnyOrigin)}`
    )
  }

  // An unknown key must not be persisted — the config file is read back at boot and an attacker-ish
  // or fat-fingered key that survives is a foothold for confusion later.
  await setDanger({ __proto__: { polluted: true }, notARealFlag: true })
  const after = await getDanger()
  must('unknown flag is not echoed back', after.notARealFlag === undefined)
  must('prototype pollution did not take', {}.polluted === undefined)

  // The persisted file must stay valid JSON and must contain exactly the known flags.
  const raw = fs.readFileSync(SANDBOX_CONFIG, 'utf8')
  let cfg
  try {
    cfg = JSON.parse(raw)
    ok('config.json is still valid JSON after hostile writes')
  } catch (e) {
    bad('config.json is still valid JSON after hostile writes', e.message)
  }
  if (cfg) {
    must('no unknown key reached the config file', cfg.danger?.notARealFlag === undefined)
  }

  await setDanger(before) // restore
}

// ---------------------------------------------------------------------------------------------
// A corrupt config must not take the hub down. This project has already been bricked once by exactly
// this shape of thing — one malformed row in the journal crash-looping the whole app — so "unparseable
// input degrades to defaults" is a property worth re-proving on the config path too.
// ---------------------------------------------------------------------------------------------
async function groupCorruptConfig() {
  console.log('\n\x1b[1mCorrupt config — must degrade, not die\x1b[0m')
  const original = fs.readFileSync(SANDBOX_CONFIG, 'utf8')
  try {
    fs.writeFileSync(SANDBOX_CONFIG, '{ "danger": { "fullAccessAnyOrigin": tru')
    // The hub only reads config at boot, so this proves the NEXT boot survives it.
    const health = await api('GET', '/api/health')
    must('hub still answering with a corrupt config on disk', health.status === 200)
    // And a write must repair it rather than compounding the damage.
    const restored = await setDanger({ fullAccessAnyOrigin: false })
    must('a write over a corrupt config produces valid state', restored.fullAccessAnyOrigin === false)
    JSON.parse(fs.readFileSync(SANDBOX_CONFIG, 'utf8'))
    ok('config.json is valid JSON again after the repair write')
  } catch (e) {
    bad('corrupt config handling', e.message)
  } finally {
    fs.writeFileSync(SANDBOX_CONFIG, original)
  }
}

// ---------------------------------------------------------------------------------------------
// Concurrent writers. Two settings blocks share one read-merge-write of config.json; interleave them
// and the loser's block can vanish. That is silent, and it is exactly the class of bug that makes a
// toggle "randomly not stick".
// ---------------------------------------------------------------------------------------------
async function groupRace() {
  console.log('\n\x1b[1mConcurrent config writes — neither block may vanish\x1b[0m')
  const before = await getDanger()
  await Promise.all([
    ...Array.from({ length: 12 }, (_, i) => setDanger({ fullAccessAnyOrigin: i % 2 === 0 })),
    ...Array.from({ length: 12 }, () => api('POST', '/api/config/prefs', { chatNamePool: 'women' })),
    ...Array.from({ length: 12 }, () => api('POST', '/api/config/prefs', { chatNamePool: 'everyone' })),
  ])
  await sleep(300)
  let cfg
  try {
    cfg = JSON.parse(fs.readFileSync(SANDBOX_CONFIG, 'utf8'))
    ok('config.json survived 36 concurrent writes as valid JSON')
  } catch (e) {
    bad('config.json survived 36 concurrent writes as valid JSON', e.message)
  }
  if (cfg) {
    must('the danger block still exists after the race', cfg.danger !== undefined, JSON.stringify(cfg))
    must('the prefs block still exists after the race', cfg.prefs !== undefined, JSON.stringify(cfg))
  }
  await setDanger(before)
}

// ---------------------------------------------------------------------------------------------
// Owner preferences — same treatment. The removed men-only value is specifically worth probing: it is
// the one string someone might send believing it is supported.
// ---------------------------------------------------------------------------------------------
async function groupPrefs() {
  console.log('\n\x1b[1mPreferences — hostile input\x1b[0m')
  await api('POST', '/api/config/prefs', { chatNamePool: 'women' })
  for (const hostile of ['men', 'MEN', '', 'everyone ', 0, null, {}, 'women; DROP TABLE']) {
    const r = await api('POST', '/api/config/prefs', { chatNamePool: hostile })
    must(
      `pool ${JSON.stringify(hostile)} is rejected, keeping 'women'`,
      r.json.chatNamePool === 'women',
      `pool is now ${JSON.stringify(r.json.chatNamePool)}`
    )
  }
  const back = await api('POST', '/api/config/prefs', { chatNamePool: 'everyone' })
  must("a VALID pool still applies", back.json.chatNamePool === 'everyone')
}

// ---------------------------------------------------------------------------------------------
// Malformed requests must not 500 or wedge the process. A hub that dies on a bad body is a hub an
// agent can kill by accident.
// ---------------------------------------------------------------------------------------------
async function groupMalformed() {
  console.log('\n\x1b[1mMalformed requests — no 5xx, no wedge\x1b[0m')
  const probes = [
    ['POST', '/api/config/danger', '{ not json'],
    ['POST', '/api/config/prefs', ''],
    ['POST', '/api/config/danger', JSON.stringify({ fullAccessAnyOrigin: 'x'.repeat(100_000) })],
    ['POST', '/api/sessions', JSON.stringify({ profileId: '../../etc/passwd' })],
    ['GET', '/api/sessions/%2e%2e%2f%2e%2e%2fetc%2fpasswd/journal', undefined],
  ]
  const token = fs.readFileSync(SANDBOX_TOKEN, 'utf8').trim()
  for (const [method, pathname, body] of probes) {
    try {
      const res = await fetch(`${BASE}${pathname}`, {
        method,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body,
      })
      must(`${method} ${pathname.slice(0, 46)} does not 5xx`, res.status < 500, `got ${res.status}`)
    } catch (e) {
      bad(`${method} ${pathname.slice(0, 46)}`, `threw: ${e.message}`)
    }
  }
  const health = await api('GET', '/api/health')
  must('hub is still alive after every malformed request', health.status === 200)
}

// ---------------------------------------------------------------------------------------------
// THE BRICK, re-proved on a running hub.
//
// A redaction bug once wrote a payload containing an invalid escape. `since()` parsed payloads with an
// unguarded JSON.parse, so every WebSocket replay that crossed that row threw, and the app crash-looped
// on startup until the row was repaired by hand — 323,594 events held hostage by one of them. The write
// side is fixed and there is a unit test for the parse guard, but a durable store outlives the bug that
// wrote into it: the property that matters is that a hub SERVING a poisoned journal stays up.
//
// So this writes a genuinely unparseable payload straight into the sandbox DB, behind the hub's back,
// and then asks the hub to replay across it.
// ---------------------------------------------------------------------------------------------
async function groupPoisonedJournal() {
  console.log('\n\x1b[1mPoisoned journal row — must degrade, not crash-loop\x1b[0m')
  const { createRequire } = await import('node:module')
  const require = createRequire(path.resolve('apps/hub/package.json'))
  let Database
  try {
    Database = require('better-sqlite3')
  } catch (e) {
    bad('load better-sqlite3', e.message)
    return
  }

  const dbPath = path.resolve('.sandbox/data/hub.db')
  const db = new Database(dbPath)
  let seq
  try {
    // Exactly the shape that bricked it: a lone backslash orphaned by a naive redaction, which is
    // invalid JSON rather than merely surprising JSON.
    const info = db
      .prepare("INSERT INTO events (ts, session, kind, payload) VALUES (?, ?, ?, ?)")
      .run(new Date().toISOString(), null, 'adversarial/poison', '{"secret":"abc\\')
    seq = Number(info.lastInsertRowid)
    ok(`injected an unparseable payload at seq ${seq}`)
  } finally {
    db.close()
  }

  // The hub must still be serving, and a replay that CROSSES the poisoned row must come back.
  const health = await api('GET', '/api/health')
  must('hub is still up with a poisoned row in its journal', health.status === 200)

  const replay = await api('GET', `/api/events?since=${seq - 3}`)
  must('a replay crossing the poisoned row still responds', replay.status === 200, `status ${replay.status}`)

  const events = Array.isArray(replay.json) ? replay.json : (replay.json.events ?? [])
  if (Array.isArray(events) && events.length) {
    const poisoned = events.find((e) => e.seq === seq)
    must('the poisoned row is RETURNED, not silently skipped', poisoned !== undefined)
    if (poisoned) {
      must(
        'it is marked unreadable rather than passed off as data',
        poisoned.payload?.__unreadable === true,
        JSON.stringify(poisoned.payload).slice(0, 120)
      )
    }
    // Contiguity is the point of not skipping: a gap in seq is how a client silently loses events.
    const seqs = events.map((e) => e.seq)
    must('sequence numbers stay contiguous across it', seqs.includes(seq))
  } else {
    bad('replay returned events', `got ${JSON.stringify(replay.json).slice(0, 160)}`)
  }

  // And it must survive a RESTART. Current preflight correctly refuses the poisoned family, then the
  // supervisor restores an identity-bound verified generation; the original bug was an unrecoverable
  // crash loop, so a still-running process alone would not prove this boundary.
  const { execSync } = await import('node:child_process')
  execSync('node scripts/sandbox.mjs down', { stdio: 'ignore' })
  execSync('node scripts/sandbox.mjs up', { stdio: 'ignore' })
  let booted = false
  for (let i = 0; i < 30; i++) {
    await sleep(1000)
    const h = await fetch(`${BASE}/api/health`).then((r) => r.ok).catch(() => false)
    if (h) {
      booted = true
      break
    }
  }
  must('hub safely RECOVERS and boots after a poisoned journal', booted, 'did not come back within 30s')
}

const GROUPS = {
  danger: groupDanger,
  config: groupCorruptConfig,
  race: groupRace,
  prefs: groupPrefs,
  malformed: groupMalformed,
  poison: groupPoisonedJournal,
}

const only = process.argv[2]
const chosen = only ? { [only]: GROUPS[only] } : GROUPS
if (only && !GROUPS[only]) {
  console.error(`unknown group '${only}'. Known: ${Object.keys(GROUPS).join(', ')}`)
  process.exit(1)
}

const up = await fetch(`${BASE}/api/health`).then((r) => r.ok).catch(() => false)
if (!up) {
  console.error(`sandbox hub is not answering on ${BASE} — run: node scripts/sandbox.mjs up`)
  process.exit(1)
}

for (const fn of Object.values(chosen)) await fn()

console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} passed, ${fail} failed\x1b[0m`)
if (fail) {
  console.log('\nfailures:')
  for (const f of failures) console.log(`  - ${f}`)
}
// Keep a machine-readable result because the poison/restart group intentionally tears down the process
// tree that owns the sandbox, which can detach the captured Windows console stream in some runners.
fs.writeFileSync(
  path.resolve('.sandbox/adversarial-result.json'),
  `${JSON.stringify({ pass, fail, failures, completedAt: new Date().toISOString() }, null, 2)}\n`,
)
// Let Node drain stdout/stderr before exit. `process.exit(...)` can drop the entire result table on
// Windows when this harness is run under a release orchestrator with piped output.
process.exitCode = fail === 0 ? 0 : 1

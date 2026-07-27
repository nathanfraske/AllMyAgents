// Every local gate that must be green before cutting a release, in one command.
//
//   node scripts/preflight-release.mjs
//
// WHY THIS EXISTS, and why it asserts on OUTPUT rather than exit codes.
//
// During the 0.1.5 cut, `npm run -s hub:test` was run several times and reported success. That script does
// not exist. npm exited 0, printed nothing, and the pipeline downstream of it dutifully reported a green
// suite. The real command (`pnpm --filter hub test`) then failed immediately: 21 of 49 test files could not
// even load, because a newly added dependency had been written into package.json and the lockfile but never
// installed. A release would have shipped a hub that could not start.
//
// The lesson is not "remember the right script name". It is that an exit code is not evidence. A command
// that does nothing succeeds. So every check below asserts on something the command PRINTS — a test count,
// a version string, a file listing — and a check that cannot find its evidence FAILS rather than passing
// quietly. A preflight that can produce a false green is worse than no preflight, because it is trusted.
//
// This does not replace CI. It catches the things that are embarrassing to discover after a tag is pushed.

import { execSync } from 'node:child_process'
import fs from 'node:fs'

const results = []
let failed = 0

function check(name, fn) {
  process.stdout.write(`  ${name} … `)
  try {
    const detail = fn()
    console.log(`OK${detail ? ` — ${detail}` : ''}`)
    results.push({ name, ok: true, detail })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.log(`FAIL\n      ${msg.split('\n').slice(0, 4).join('\n      ')}`)
    results.push({ name, ok: false, detail: msg })
    failed++
  }
}

function run(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, ...opts })
}

/** Cargo commands run in the crate, not the repo root, and write EVERY diagnostic — lints, errors, and
 *  even the "Finished" line — to stderr. `run` captures stdout only, so without the redirect below these
 *  checks would assert against an empty string and pass no matter what clippy found. That is precisely the
 *  false-green this script exists to prevent, so the redirect is not incidental.
 *
 *  A non-zero exit returns its output rather than throwing, because with `-D warnings` the lint text IS
 *  the evidence the check needs to report. */
function runNative(cmd) {
  const opts = { cwd: 'apps/desktop/src-tauri' }
  try {
    return run(`${cmd} 2>&1`, opts)
  } catch (err) {
    return `${err.stdout ?? ''}${err.stderr ?? ''}`
  }
}

// Vitest colours its summary, so the line is really:
//   "Tests \x1b[22m \x1b[1m\x1b[32m462 passed\x1b[39m"
// Matching that with a pattern written against the plain text silently fails and reports a passing suite as
// broken — which this script did on its first real run. Strip the escapes before matching rather than
// trying to write a regex that tolerates them.
const stripAnsi = (s) => s.replace(/\[[0-9;]*m/g, '')

/** Assert a command's OUTPUT matches, not merely that it exited 0. */
function expectOutput(cmd, re, label) {
  let out = ''
  try {
    out = stripAnsi(run(cmd))
  } catch (err) {
    out = stripAnsi(`${err.stdout ?? ''}${err.stderr ?? ''}`)
    throw new Error(`command failed: ${cmd}\n${out.slice(-800)}`)
  }
  const m = out.match(re)
  if (!m) throw new Error(`${label}: expected output matching ${re} but got:\n${out.slice(-800)}`)
  return m
}

console.log('\nAllMyAgents — release preflight\n')

console.log('Version')
const conf = JSON.parse(fs.readFileSync('apps/desktop/src-tauri/tauri.conf.json', 'utf8'))
const cargo = fs.readFileSync('apps/desktop/src-tauri/Cargo.toml', 'utf8').match(/^version = "([^"]+)"/m)?.[1]

check('tauri.conf.json and Cargo.toml agree', () => {
  if (conf.version !== cargo) throw new Error(`tauri.conf.json=${conf.version} Cargo.toml=${cargo}`)
  return conf.version
})

check('version is greater than the published release', () => {
  let published
  try {
    const raw = run('curl -sSfL --max-time 30 https://github.com/nathanfraske/AllMyAgents/releases/latest/download/latest.json')
    published = JSON.parse(raw).version
  } catch {
    return 'no published latest.json to compare (first release?)'
  }
  const p = (s) => s.split('-')[0].split('.').map(Number)
  const [a, b] = [p(conf.version), p(published)]
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) !== (b[i] || 0)) {
      if ((a[i] || 0) > (b[i] || 0)) return `${conf.version} > ${published}`
      throw new Error(`${conf.version} is NOT greater than published ${published} — the updater compares this field, not the git tag, so no installed client would be offered this release`)
    }
  }
  throw new Error(`${conf.version} equals published ${published} — installed clients would see no update`)
})

console.log('\nSource hygiene')
check('no unresolved merge markers', () => {
  try {
    const out = run(`git grep -nE "^(<{7} |={7}$|>{7} )" -- "*.ts" "*.tsx" "*.svelte" "*.js" "*.mjs" "*.cjs" "*.rs" "*.json" "*.yml" "*.yaml" "*.toml"`)
    throw new Error(`conflict markers present:\n${out.slice(0, 400)}`)
  } catch (err) {
    // git grep exits 1 when it finds nothing — that is the success case here.
    if (err.status === 1) return 'clean'
    throw err
  }
})

check('no uncommitted changes to tracked files', () => {
  // Untracked files are NOT a release problem: nothing untracked reaches the payload, and this repo
  // legitimately carries local-only files (agent instruction files, scratch dirs). Failing on them made the
  // check cry wolf on its first run, and a preflight that is routinely red gets ignored — which is the
  // failure mode it exists to prevent. Modified TRACKED files are the real risk: they mean the thing tested
  // is not the thing tagged.
  const out = run('git status --porcelain')
  const lines = out.split('\n').filter(Boolean)
  const modified = lines.filter((l) => !l.startsWith('??'))
  const untracked = lines.filter((l) => l.startsWith('??'))
  if (modified.length) {
    throw new Error(`tracked files modified but not committed — the tag would not match what was tested:\n${modified.slice(0, 8).join('\n')}`)
  }
  return untracked.length ? `clean (${untracked.length} untracked, ignored)` : 'clean'
})

check('nothing unpushed', () => {
  const n = run('git rev-list --count origin/main..HEAD').trim()
  if (n !== '0') throw new Error(`${n} commit(s) ahead of origin/main — CI has not seen them`)
  return 'in sync with origin/main'
})

console.log('\nDependencies')
check('every declared hub dependency is installed', () => {
  // Checked by presence in apps/hub/node_modules, not by require.resolve with a `paths` option. pnpm links
  // each dependency into the workspace's node_modules and the real files live in the .pnpm store, so a
  // resolve rooted at a RELATIVE path reports every package missing — this check did exactly that on its
  // first run and claimed three installed packages were absent while the suite that imports them passed.
  //
  // This is not academic: the same class of staleness is real here, because `hub:bundle` prunes
  // apps/hub/node_modules while staging the payload. Running the bundle and then the tests genuinely does
  // leave the tree unable to start — that is how a broken suite looked green earlier. So the check must be
  // right, and it must run BEFORE packaging (it does).
  const pkg = JSON.parse(fs.readFileSync('apps/hub/package.json', 'utf8'))
  const deps = Object.keys(pkg.dependencies ?? {})
  const missing = deps.filter((d) => !fs.existsSync(`apps/hub/node_modules/${d}`))
  if (missing.length) throw new Error(`declared but not installed: ${missing.join(', ')} — run pnpm install`)
  return `${deps.length} present`
})

check('shipped npm lockfile covers the runtime deps', () => {
  const pkg = JSON.parse(fs.readFileSync('apps/hub/package.json', 'utf8'))
  const lock = fs.readFileSync('apps/hub/package-lock.json', 'utf8')
  const missing = Object.keys(pkg.dependencies ?? {}).filter((d) => !lock.includes(`node_modules/${d}`))
  if (missing.length) throw new Error(`absent from the SHIPPED lockfile: ${missing.join(', ')} — users install from this, not from pnpm-lock.yaml`)
  return 'complete'
})

console.log('\nTests and types (asserting on counts, not exit codes)')
// Vitest's summary is either "Tests  462 passed (462)" or "Tests  4 failed | 353 passed (357)".
// Both counts are captured deliberately: a pattern that only looks for "N passed" reports a partially
// failing suite as green. An earlier version here also wrapped the count in an optional `(?:\S+)?`, which
// backtracked into the number itself and turned "462 passed" into "2 passed" — a check whose output nobody
// reads closely is barely better than no check, so the count it prints has to be trustworthy.
const VITEST_SUMMARY = /Tests\s+(?:(\d+) failed\s*\|\s*)?(\d+) passed/

function vitest(cmd, label) {
  const m = expectOutput(cmd, VITEST_SUMMARY, label)
  const failedCount = Number(m[1] ?? 0)
  if (failedCount > 0) throw new Error(`${failedCount} test(s) failing`)
  return `${m[2]} passed`
}

check('hub tests', () => vitest('pnpm --filter hub test 2>&1', 'hub tests'))
check('web tests', () => vitest('pnpm --filter web test 2>&1', 'web tests'))
check('hub typecheck', () => {
  expectOutput('pnpm --filter hub typecheck 2>&1', /tsc --noEmit/, 'hub typecheck')
  return 'clean'
})
check('web check', () => {
  const m = expectOutput('pnpm --filter web check 2>&1', /COMPLETED (\d+) FILES (\d+) ERRORS/, 'web check')
  if (m[2] !== '0') throw new Error(`${m[2]} errors`)
  return `${m[1]} files, 0 errors`
})

console.log('\nPackaging')
check('credential firewall self-test', () => {
  expectOutput('pnpm run bundle:audit 2>&1', /self-test: all cases passed/, 'bundle audit')
  return 'all leak classes caught'
})
check('real payload stages and passes the audit', () => {
  const m = expectOutput('pnpm run hub:bundle 2>&1', /credential audit passed: (\d+) payload files/, 'hub bundle')
  return `${m[1]} files audited`
})

// The 0.1.6 cut tagged a commit whose Rust shell did not lint. Every JS gate above was green, so the
// preflight said "safe to tag" — it had simply never compiled the native crate. `cargo clippy -D warnings`
// then failed on macOS AND Windows over four lints in one file (the agent-browser bridge, which had landed
// without anyone running a Rust gate locally). The release artifacts built fine, because clippy is a lint
// gate and `tauri build` does not run it, so main went red while the installers were valid — an especially
// confusing failure to read under time pressure.
//
// Order and working directory mirror the ci.yml `tauri shell` job deliberately. tauri-build validates
// tauri.conf.json at build.rs time, and that config points `frontendDist` at apps/web/dist and declares
// hub-runtime as a resource, so BOTH must be staged before cargo touches the crate or this fails on config
// validation rather than on the code. hub:bundle already ran in Packaging above; the web build has not.
console.log('\nNative shell (mirrors the ci.yml tauri job)')
check('web dist staged for tauri-build', () => {
  run('pnpm --filter web build 2>&1')
  if (!fs.existsSync('apps/web/dist/index.html')) throw new Error('apps/web/dist/index.html absent after build')
  return 'apps/web/dist present'
})

check('cargo check --all-targets', () => {
  const out = stripAnsi(runNative('cargo check --all-targets'))
  if (/^error(\[E\d+\])?:/m.test(out)) throw new Error(out.slice(-900))
  if (!/Finished|Checking|Compiling/.test(out)) throw new Error(`no evidence cargo ran:\n${out.slice(-500)}`)
  return 'compiles'
})

check('cargo clippy --all-targets -- -D warnings', () => {
  // Asserting on absence-of-error as well as the Finished line: with `-D warnings` a lint IS an error, and
  // this is the exact gate that main went red on.
  const out = stripAnsi(runNative('cargo clippy --all-targets -- -D warnings'))
  if (/^error(\[E\d+\])?:/m.test(out) || /could not compile/.test(out)) {
    const first = out.split('\n').filter((l) => /^error/.test(l)).slice(0, 4).join('\n')
    throw new Error(`${first}\n(full tail)\n${out.slice(-500)}`)
  }
  if (!/Finished|Checking/.test(out)) throw new Error(`no evidence clippy ran:\n${out.slice(-500)}`)
  return 'no lints'
})

console.log('')
if (failed) {
  console.log(`${failed} check(s) FAILED — do not cut.\n`)
  process.exit(1)
}
console.log(`all ${results.length} checks passed — safe to tag v${conf.version}-<suffix>\n`)

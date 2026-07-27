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

/** Assert a command's OUTPUT matches, not merely that it exited 0. */
function expectOutput(cmd, re, label) {
  let out = ''
  try {
    out = run(cmd)
  } catch (err) {
    out = `${err.stdout ?? ''}${err.stderr ?? ''}`
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

check('working tree is committed', () => {
  const out = run('git status --porcelain')
  if (out.trim()) throw new Error(`uncommitted changes:\n${out.trim().split('\n').slice(0, 8).join('\n')}`)
  return 'clean'
})

check('nothing unpushed', () => {
  const n = run('git rev-list --count origin/main..HEAD').trim()
  if (n !== '0') throw new Error(`${n} commit(s) ahead of origin/main — CI has not seen them`)
  return 'in sync with origin/main'
})

console.log('\nDependencies')
check('every declared hub dependency is installed', () => {
  const pkg = JSON.parse(fs.readFileSync('apps/hub/package.json', 'utf8'))
  const deps = Object.keys(pkg.dependencies ?? {})
  const missing = deps.filter((d) => {
    try {
      run(`node -e "require.resolve('${d}/package.json',{paths:['apps/hub']})"`)
      return false
    } catch {
      return true
    }
  })
  if (missing.length) throw new Error(`declared but not installed: ${missing.join(', ')} — run pnpm install`)
  return `${deps.length} resolved`
})

check('shipped npm lockfile covers the runtime deps', () => {
  const pkg = JSON.parse(fs.readFileSync('apps/hub/package.json', 'utf8'))
  const lock = fs.readFileSync('apps/hub/package-lock.json', 'utf8')
  const missing = Object.keys(pkg.dependencies ?? {}).filter((d) => !lock.includes(`node_modules/${d}`))
  if (missing.length) throw new Error(`absent from the SHIPPED lockfile: ${missing.join(', ')} — users install from this, not from pnpm-lock.yaml`)
  return 'complete'
})

console.log('\nTests and types (asserting on counts, not exit codes)')
check('hub tests', () => {
  const m = expectOutput('pnpm --filter hub test 2>&1', /Tests\s+(?:\S+)?(\d+) passed/, 'hub tests')
  return `${m[1]} passed`
})
check('web tests', () => {
  const m = expectOutput('pnpm --filter web test 2>&1', /Tests\s+(?:\S+)?(\d+) passed/, 'web tests')
  return `${m[1]} passed`
})
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

console.log('')
if (failed) {
  console.log(`${failed} check(s) FAILED — do not cut.\n`)
  process.exit(1)
}
console.log(`all ${results.length} checks passed — safe to tag v${conf.version}-<suffix>\n`)

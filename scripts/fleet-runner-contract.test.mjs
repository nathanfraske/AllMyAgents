import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import test from 'node:test'

const root = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(new URL('../apps/hub/package.json', import.meta.url))
const { parse } = require('yaml')
const { cachePlan, checkedDirectory, configure, prepareRelease } = require(path.join(root, 'scripts/fleet-build-cache.cjs'))
const baseline = JSON.parse(fs.readFileSync(new URL('./fixtures/fleet-gate-baseline.json', import.meta.url), 'utf8'))
const read = name => fs.readFileSync(path.join(root, '.github/workflows', name), 'utf8')
const ci = parse(read('ci.yml'))
const release = parse(read('release.yml'))
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')

// Execute these deliberately simple checked-in &&/||/== expressions with the same
// contexts as GitHub. No input is interpolated into executable source.
function runner(expression, osName, overrides = {}) {
  const context = {
    github: { repository: 'nathanfraske/AllMyAgents', event_name: 'pull_request', event: {
      pull_request: { head: { repo: { full_name: 'nathanfraske/AllMyAgents' } } },
    } },
    inputs: {}, matrix: { os: osName, platform: osName }, fromJSON: JSON.parse,
    ...overrides,
  }
  const value = vm.runInNewContext(expression.slice(3, -2), context, { timeout: 1000 })
  return JSON.parse(JSON.stringify(value))
}

test('normal trusted CI uses current fleet labels without a missing repository variable', () => {
  const expected = {
    'windows-latest': ['self-hosted', 'Windows', 'X64', 'fleet-general-windows'],
    'ubuntu-latest': ['self-hosted', 'Linux', 'X64', 'fleet-general-linux'],
    'macos-15-intel': ['self-hosted', 'macOS', 'X64', 'fleet-general-macos'],
    'macos-latest': 'macos-latest',
  }
  for (const job of Object.values(ci.jobs)) {
    for (const osName of job.strategy.matrix.os) assert.deepEqual(runner(job['runs-on'], osName), expected[osName])
  }
  assert.equal(ci.on.workflow_dispatch.inputs.runner_mode.default, 'fleet')
  assert.deepEqual(ci.permissions, { contents: 'read' })
  assert.doesNotMatch(read('ci.yml'), /vars\.TEST_FLEET_CI|linux-docker-x64|windows-native-x64/)
})

test('forks, other repositories and explicit hosted diagnostics cannot enter the fleet', () => {
  const foreign = {
    repository: 'nathanfraske/AllMyAgents', event_name: 'pull_request',
    event: { pull_request: { head: { repo: { full_name: 'outside/AllMyAgents' } } } },
  }
  for (const job of Object.values(ci.jobs)) for (const osName of job.strategy.matrix.os) {
    assert.equal(runner(job['runs-on'], osName, { github: foreign, inputs: { qualify_local: true } }), osName)
    assert.equal(runner(job['runs-on'], osName, { github: { ...foreign, repository: 'outside/AllMyAgents', event_name: 'push' } }), osName)
    assert.equal(runner(job['runs-on'], osName, { inputs: { runner_mode: 'hosted', qualify_local: true } }), osName)
  }
  assert.deepEqual(ci.on.push.branches, ['main'])
  assert('pull_request' in ci.on)
  assert(!('pull_request_target' in ci.on))
})

test('release builds use the x64 fleet and retain the hosted ARM architectures', () => {
  assert.deepEqual(runner(release.jobs['linux-testbed']['runs-on'], 'ubuntu-22.04'), ['self-hosted', 'Linux', 'X64', 'fleet-general-linux'])
  assert.equal(runner(release.jobs['linux-testbed']['runs-on'], 'ubuntu-24.04-arm'), 'ubuntu-24.04-arm')
  assert.deepEqual(runner(release.jobs.release['runs-on'], 'windows-latest'), ['self-hosted', 'Windows', 'X64', 'fleet-general-windows'])
  assert.deepEqual(runner(release.jobs.release['runs-on'], 'macos-15-intel'), ['self-hosted', 'macOS', 'X64', 'fleet-general-macos'])
  assert.equal(runner(release.jobs.release['runs-on'], 'macos-latest'), 'macos-latest')
  assert.equal(release.jobs.release.needs, 'launch-and-repair-gate')
  assert.equal(release.jobs['linux-testbed'].needs, 'launch-and-repair-gate')
  assert.deepEqual(release.on.push.tags, ['v*'])
  assert.equal(release.concurrency['cancel-in-progress'], false)
  assert.doesNotMatch(read('release.yml'), /linux-docker-x64|windows-native-x64/)
})

test('Apple Silicon stays hosted in every existing macOS verification matrix', () => {
  for (const filename of ['macos-p0-verification.yml', 'macos-installability.yml']) {
    const workflow = parse(read(filename))
    for (const job of Object.values(workflow.jobs)) {
      assert(job.strategy.matrix.runner.includes('macos-latest'), `${filename}: Apple Silicon coverage missing`)
      assert.equal(runner(job['runs-on'], 'macos-latest', { matrix: { runner: 'macos-latest' } }), 'macos-latest')
    }
  }
})

test('all original gate bodies, order and matrix entries remain; only setup/target plumbing changes', () => {
  for (const [filename, original] of Object.entries(baseline.workflows)) {
    const workflow = parse(read(filename))
    assert.deepEqual(Object.keys(workflow.jobs), Object.keys(original.jobs), filename)
    for (const [id, job] of Object.entries(original.jobs)) {
      const current = workflow.jobs[id]
      if (job.matrix) for (const [axis, values] of Object.entries(job.matrix)) {
        for (const value of values) assert(current.strategy.matrix[axis].includes(value), `${filename}/${id}: dropped ${value}`)
      }
      let position = 0
      for (const step of job.steps) {
        const offset = current.steps.slice(position).findIndex(value => digest(value) === step.sha256)
        assert(offset >= 0, `${filename}/${id}: changed or dropped original gate ${step.label}`)
        position += offset + 1
      }
    }
  }
  assert.equal(ci.jobs.gates['timeout-minutes'], 20)
  assert.equal(ci.jobs.rust['timeout-minutes'], 30)
  const policy = ci.jobs.gates.steps.find(step => step.name === 'Release durability gate policy')
  assert.match(policy.run, /wait-release-verification\.test\.mjs scripts\/macos-installability-policy\.test\.mjs scripts\/fleet-runner-contract\.test\.mjs/)
  const harness = ci.jobs.rust.steps.find(step => step.name === 'cargo test (Windows manifested harness)')
  assert.match(harness.run, /cargo test --lib --no-run --message-format=json/)
  assert.match(harness.run, /\$tests\.Count -ne 1/)
  assert.match(harness.run, /& \$testExe\.FullName/)
  assert.doesNotMatch(harness.run, /Get-ChildItem target\/debug/)
})

test('persistent setup is self-hosted only and does not replace frozen install or original test gates', () => {
  for (const job of [ci.jobs.gates, ci.jobs.rust, release.jobs.release, release.jobs['linux-testbed']]) {
    const setup = job.steps.findIndex(step => step.run === 'node scripts/fleet-build-cache.cjs')
    assert(setup > job.steps.findIndex(step => step.uses === 'actions/setup-node@v4'))
    assert.equal(job.steps[setup].if, "runner.environment == 'self-hosted'")
    assert(setup < job.steps.findIndex(step => step.run === 'pnpm install --frozen-lockfile'))
  }
  const fresh = release.jobs.release.steps.find(step => step.run === 'node scripts/fleet-build-cache.cjs --prepare-release')
  assert.equal(fresh.if, "runner.environment == 'self-hosted'")
  for (const job of [ci.jobs.rust, release.jobs.release]) {
    assert.equal(job.steps.find(step => step.uses === 'swatinem/rust-cache@v2').if, "runner.environment != 'self-hosted'")
  }
})

test('cache plans use the qualified platform roots and reject guessed roots, repos and architectures', () => {
  for (const [platform, cacheRoot] of Object.entries({ win32: 'D:\\TestFleetCache', linux: '/var/cache/test-fleet', darwin: '/Volumes/TestFleetCache' })) {
    const p = platform === 'win32' ? path.win32 : path.posix
    const env = { GITHUB_REPOSITORY: 'nathanfraske/AllMyAgents', RUNNER_TOOL_CACHE: p.join(cacheRoot, 'toolcache') }
    const plan = cachePlan(env, platform, 'x64', 'pnpm@10.14.0')
    assert.equal(plan.root, cacheRoot)
    assert.equal(plan.writableRoot, platform === 'linux' ? p.join(cacheRoot, 'user') : cacheRoot)
    assert.equal(plan.values.npm_config_verify_store_integrity, 'true')
    assert.equal(plan.values.CARGO_TARGET_DIR, p.join(plan.base, 'cargo-target'))
    for (const invalid of [{ ...env, GITHUB_REPOSITORY: 'outside/repo' }, { ...env, RUNNER_TOOL_CACHE: p.dirname(cacheRoot) }]) {
      assert.throws(() => cachePlan(invalid, platform, 'x64', 'pnpm@10.14.0'))
    }
    assert.throws(() => cachePlan(env, platform, 'arm64', 'pnpm@10.14.0'))
    assert.throws(() => cachePlan(env, platform, 'x64', 'pnpm@latest'))
  }
})

function fixture(t) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-fleet-cache-test-'))
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }))
  const base = path.join(folder, 'cache', 'project')
  return { folder, plan: { root: folder, writableRoot: folder, base, values: {
    npm_config_store_dir: path.join(base, 'pnpm-store'), npm_config_verify_store_integrity: 'true',
    CARGO_TARGET_DIR: path.join(base, 'cargo-target'), FLEET_CACHE_ROOT: base,
  } } }
}

test('cache setup writes only the qualified paths and requires sufficient space', t => {
  const { folder, plan } = fixture(t)
  const file = path.join(folder, 'job-env')
  t.mock.method(fs, 'statfsSync', () => ({ bavail: 9n * 1024n ** 3n, bsize: 1n }))
  configure(plan, file)
  assert(fs.readFileSync(file, 'utf8').includes(`CARGO_TARGET_DIR=${plan.values.CARGO_TARGET_DIR}\n`))
  assert(fs.statSync(plan.values.npm_config_store_dir).isDirectory())
  fs.statfsSync.mock.mockImplementation(() => ({ bavail: 0n, bsize: 1n }))
  assert.throws(() => configure(plan, file), /at least 8 GiB/)
})

test('fresh release removes only the exact old bundle and retains compiled dependencies', t => {
  const { plan } = fixture(t)
  const target = plan.values.CARGO_TARGET_DIR
  const bundle = path.join(target, 'release', 'bundle')
  fs.mkdirSync(bundle, { recursive: true })
  fs.writeFileSync(path.join(bundle, 'old-installer.msi'), 'old generated output')
  const compiled = path.join(target, 'release', 'keep.rlib')
  fs.writeFileSync(compiled, 'keep')
  assert.throws(() => prepareRelease(plan, plan.root), /escaped qualified cache target/)
  assert(fs.existsSync(bundle))
  prepareRelease(plan, target)
  assert(!fs.existsSync(bundle))
  assert.equal(fs.readFileSync(compiled, 'utf8'), 'keep')
})

test('cache parent links are refused before creating or deleting anything outside the cache', t => {
  const { folder, plan } = fixture(t)
  const outside = path.join(folder, 'outside')
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(outside, 'keep'), 'keep')
  fs.symlinkSync(outside, path.join(folder, 'cache'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => checkedDirectory(plan.root, plan.base, true), /directory link/)
  assert.throws(() => prepareRelease(plan, plan.values.CARGO_TARGET_DIR), /directory link/)
  assert.deepEqual(fs.readdirSync(outside), ['keep'])
  assert.throws(() => checkedDirectory(plan.root, path.dirname(plan.root), true), /escaped disk/)
})

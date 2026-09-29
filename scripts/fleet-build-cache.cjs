'use strict'

// Project-owned extraction of the cache contract qualified at 303f79d4719ea39088cedf1f00a64ff321ed8bad.
// No credentials, downloads, runner registration or host setup. Fork PRs must stay hosted.
const fs = require('node:fs')
const path = require('node:path')

function cachePlan(env, platform, arch, packageManager) {
  if (env.GITHUB_REPOSITORY !== 'nathanfraske/AllMyAgents' || arch !== 'x64') {
    throw new Error('Unqualified repository or architecture for fleet cache')
  }
  const roots = { win32: 'D:\\TestFleetCache', linux: '/var/cache/test-fleet', darwin: '/Volumes/TestFleetCache' }
  const root = roots[platform]
  const p = platform === 'win32' ? path.win32 : path.posix
  if (!root || p.normalize(env.RUNNER_TOOL_CACHE || '') !== p.join(root, 'toolcache')) {
    throw new Error('Runner does not advertise the qualified persistent cache')
  }
  if (!/^pnpm@\d+\.\d+\.\d+(?:\+sha(?:224|256|384|512)\.[a-f0-9]+)?$/.test(packageManager || '')) {
    throw new Error('Expected a pinned pnpm packageManager')
  }
  // Linux registration owns only the user subtree, not the root-owned mount.
  const writableRoot = platform === 'linux' ? p.join(root, 'user') : root
  const base = p.join(writableRoot, 'build-cache-v1', 'nathanfraske--AllMyAgents', `${platform}-${arch}`)
  return { root, writableRoot, base, values: {
    npm_config_store_dir: p.join(base, 'pnpm-store'),
    npm_config_verify_store_integrity: 'true',
    CARGO_TARGET_DIR: p.join(base, 'cargo-target'),
    FLEET_CACHE_ROOT: base,
  } }
}

function inside(root, destination) {
  const relative = path.relative(root, destination)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Cache path escaped disk')
  }
  return relative
}

// Check each existing component before creating the next one, not after following a link.
function checkedDirectory(root, destination, create = false) {
  const relative = inside(root, destination)
  let current = root
  for (const component of ['', ...relative.split(path.sep).filter(Boolean)]) {
    if (component) current = path.join(current, component)
    let stat
    try { stat = fs.lstatSync(current) } catch (error) {
      if (error.code !== 'ENOENT') throw error
      if (!create) return false
      // Never create a missing mount root; only children below the verified root.
      if (current === root) throw new Error('Persistent cache disk is missing')
      fs.mkdirSync(current)
      stat = fs.lstatSync(current)
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Unexpected cache directory link or file')
    inside(fs.realpathSync(root), fs.realpathSync(current))
  }
  return true
}

function configure(plan, environmentFile) {
  if (!environmentFile) throw new Error('Actions environment file missing')
  if (!checkedDirectory(plan.root, plan.writableRoot)) throw new Error('Runner cache directory is missing')
  fs.accessSync(plan.writableRoot, fs.constants.W_OK)
  const space = fs.statfsSync(plan.writableRoot, { bigint: true })
  if (space.bavail * space.bsize < 8n * 1024n ** 3n) throw new Error('Persistent cache needs at least 8 GiB free')
  for (const folder of [plan.base, plan.values.npm_config_store_dir, plan.values.CARGO_TARGET_DIR]) {
    checkedDirectory(plan.root, folder, true)
  }
  fs.appendFileSync(environmentFile, Object.entries(plan.values).map(([k, v]) => `${k}=${v}\n`).join(''), 'utf8')
  console.log(JSON.stringify({ event: 'persistent-build-cache', ...plan, free_bytes: (space.bavail * space.bsize).toString() }))
}

function prepareRelease(plan, cargoTarget) {
  const expected = path.join(plan.base, 'cargo-target')
  if (!cargoTarget || !path.isAbsolute(cargoTarget) || path.resolve(cargoTarget) !== path.resolve(expected)) {
    throw new Error('Installer directory escaped qualified cache target')
  }
  const bundle = path.join(expected, 'release', 'bundle')
  // Only generated installer output; preserve registry, compiler cache, source and all other jobs.
  if (checkedDirectory(plan.root, bundle)) fs.rmSync(bundle, { recursive: true })
  console.log('Fresh installer output; compiled dependencies retained')
}

module.exports = { cachePlan, checkedDirectory, configure, prepareRelease }
if (require.main === module) {
  const args = process.argv.slice(2)
  if (args.length > 1 || (args.length === 1 && args[0] !== '--prepare-release')) throw new Error('Unknown cache operation')
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
  const plan = cachePlan(process.env, process.platform, process.arch, pkg.packageManager)
  if (args[0] === '--prepare-release') prepareRelease(plan, process.env.CARGO_TARGET_DIR)
  else configure(plan, process.env.GITHUB_ENV)
}

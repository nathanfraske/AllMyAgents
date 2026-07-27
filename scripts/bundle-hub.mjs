#!/usr/bin/env node
// -----------------------------------------------------------------------------
// bundle-hub.mjs — assemble the LIGHT runtime payload the release desktop app
// ships as Tauri resources. The installer contains ONLY our own code plus a
// Node runtime; it deliberately does NOT bundle the hub's node_modules, the
// native better-sqlite3 addon, or the vendor CLIs (@anthropic-ai/claude-code,
// @openai/codex, @anthropic-ai/claude-agent-sdk).
//
// Those runtime dependencies are fetched by `npm install` on the USER's machine
// on first launch (see apps/desktop/src-tauri/src/lib.rs). Keeping them out of
// the installer keeps it small AND sidesteps redistributing the vendor binaries
// — the user's own machine pulls them from the npm registry, exactly like a
// normal `npm install`, so we are not redistributing anything. Node itself is
// MIT-licensed and freely redistributable, so bundling it is fine.
//
// Payload layout (staged at apps/desktop/src-tauri/hub-runtime, shipped as a
// Tauri resource → present at <resource_dir>/hub-runtime at runtime):
//
//   hub-runtime/
//     apps/hub/
//       dist/           index.js, …     (tsc output of apps/hub/src — OUR code)
//       package.json                    (runtime versions pinned)
//       package-lock.json               (npm's reproducible transitive graph)
//     node/
//       node(.exe)                      (the platform Node runtime — MIT)
//       node_modules/npm/…              (npm, so first-run install needs nothing)
//
// On first launch the app copies apps/hub/{dist,package.json,package-lock.json}
// into a writable data dir and runs `npm install --omit=dev` there. Plain npm
// reads package-lock.json beside package.json, so it fetches the locked native
// addon + vendor CLIs for the host platform instead of resolving a new graph.
// This script uses only Node built-ins and must run on the platform being
// packaged.
//
// ⚠️ THE LANDMINE (docs/alpha-release-plan.md): the repo's `profiles/` holds the
// operator's REAL vendor credentials and `data/` holds their live journal. An
// installer that carried either would leak them into a public artifact. This
// script therefore (a) copies from an explicit ALLOWLIST — never a broad tree
// sweep — and (b) ends with a credential firewall that walks the finished payload
// and THROWS if anything credential-shaped is present. Failing the build is the
// point: a release cannot be cut past this check.
//
// The bundle ships ZERO profiles. "Template profiles" for this app means exactly
// that: no profile directory at all in the installer, and an EMPTY
// %APPDATA%\AllMyAgents\profiles created on the user's own machine at first run
// (apps/desktop/src-tauri/src/lib.rs `materialize_app_data`), which the in-app
// login then populates with their own credentials. There is no template file to
// carry a secret in, which is the strongest possible version of the guarantee.
// -----------------------------------------------------------------------------

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')
const hubSrc = path.join(repoRoot, 'apps', 'hub')
const outRoot = path.join(repoRoot, 'apps', 'desktop', 'src-tauri', 'hub-runtime')
const outHub = path.join(outRoot, 'apps', 'hub')
const outNodeDir = path.join(outRoot, 'node')

const log = (m) => console.log(`[bundle-hub] ${m}`)
const rmrf = (p) => fs.rmSync(p, { recursive: true, force: true })
function must(p, label) {
  if (!fs.existsSync(p)) throw new Error(`[bundle-hub] MISSING ${label}: ${p}`)
  log(`ok: ${label}`)
}
function dirStats(root) {
  let bytes = 0
  let files = 0
  const stack = [root]
  while (stack.length) {
    const d = stack.pop()
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name)
      if (ent.isDirectory()) stack.push(p)
      else if (ent.isFile()) {
        files++
        bytes += fs.statSync(p).size
      }
    }
  }
  return { bytes, files }
}
const mb = (b) => `${(b / 1024 / 1024).toFixed(1)} MB`

/** Every file under `root`, as a POSIX-style path relative to `root`. */
function walkFiles(root) {
  const out = []
  const stack = ['']
  while (stack.length) {
    const rel = stack.pop()
    for (const ent of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${ent.name}` : ent.name
      if (ent.isDirectory()) stack.push(r)
      else out.push(r)
    }
  }
  return out
}

// -----------------------------------------------------------------------------
// Credential firewall — the release gate for the landmine in the header comment.
// -----------------------------------------------------------------------------

/** Exact file names that can only mean "a credential got in". Compared lowercased. */
const DENY_BASENAME = new Set([
  '.credentials.json', // Claude Code OAuth credentials
  'credentials.json',
  '.claude.json', // Claude Code CLI state (project list, machine paths, sometimes tokens)
  'auth.json', // Codex CLI auth
  'device-token.txt', // this hub's mesh device token
  'hub.db', // this hub's journal
  '.env',
  '.env.local',
  'id_rsa',
  'id_ed25519',
  'id_ecdsa',
  '.pypirc',
  '.netrc',
  '_netrc',
])

/** Extensions that are credential/state shaped. `.jsonl` covers Codex rollout history. */
const DENY_EXT = new Set([
  '.pem',
  '.p12',
  '.pfx',
  '.key',
  '.jks',
  '.keystore',
  '.jsonl',
  '.db',
  '.db-wal',
  '.db-shm',
  '.sqlite',
  '.sqlite3',
])

/** Path components that must never appear anywhere in the payload. */
const DENY_SEGMENT = new Set(['profiles', 'worktrees', '.claude', '.codex', '.git', '.ssh', '.aws'])

/** High-signal secret literals, scanned in the CONTENT of our own shipped code. */
const SECRET_PATTERNS = [
  [/sk-ant-[A-Za-z0-9_-]{12,}/, 'Anthropic API key'],
  [/sk-proj-[A-Za-z0-9_-]{12,}/, 'OpenAI project key'],
  [/\bsk-[A-Za-z0-9]{32,}\b/, 'OpenAI-style API key'],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/, 'GitHub token'],
  [/github_pat_[A-Za-z0-9_]{20,}/, 'GitHub fine-grained PAT'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'PEM private key'],
  [/untrusted comment:[^\n]*secret key/i, 'minisign/rsign PRIVATE signing key'],
  [/"(?:access_token|refresh_token|id_token|api_key|apiKey)"\s*:\s*"[^"]{16,}"/, 'OAuth/API token literal'],
]

/** Absolute per-user home paths — a machine-specific dev path baked into a shipped file. */
// Backslashes are matched 1-or-2 deep because a path baked into a JS string literal
// is escaped (`"C:\\Users\\me"`), and forward slashes are accepted because Node
// normalizes them interchangeably on Windows.
const HOME_PATTERNS = [
  [/[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}[^\\/"'`\s]+/, 'Windows user home path'],
  [/\/Users\/[^/"'`\s]+\//, 'macOS user home path'],
  [/\/home\/[^/"'`\s]+\//, 'Linux user home path'],
]

/**
 * Walk the finished payload and throw on anything credential-shaped.
 *
 * - `allowed`: the ONLY relative paths permitted, as regexes. Anything else is a
 *   structural leak (a stray tree got copied) and fails even if it looks benign.
 * - name/extension/segment deny-lists catch a credential that slips into an
 *   otherwise-allowed tree.
 * - content scanning runs over OUR code only (`apps/hub/**`) — the vendored Node
 *   distribution is a third-party artifact we copy verbatim and scanning ~1200
 *   minified npm files for `sk-…` shapes is all false positives, no signal.
 * - `.npmrc`/`npmrc` anywhere is content-checked for a registry auth token, since
 *   npm ships builtin ones that are legitimate but could be swapped for an authed
 *   copy on a developer's machine.
 */
function auditPayload(root, allowed) {
  const files = walkFiles(root)
  const problems = []
  for (const rel of files) {
    const base = path.posix.basename(rel).toLowerCase()
    const ext = path.posix.extname(base)
    const segments = rel.split('/').slice(0, -1)

    if (!allowed.some((re) => re.test(rel))) problems.push(`NOT ON THE ALLOWLIST: ${rel}`)
    if (DENY_BASENAME.has(base)) problems.push(`CREDENTIAL FILE: ${rel}`)
    if (DENY_EXT.has(ext)) problems.push(`CREDENTIAL/STATE EXTENSION (${ext}): ${rel}`)
    if (base.startsWith('.env.')) problems.push(`DOTENV FILE: ${rel}`)
    for (const seg of segments) {
      if (DENY_SEGMENT.has(seg.toLowerCase())) problems.push(`FORBIDDEN DIRECTORY "${seg}": ${rel}`)
    }
    if (base === '.npmrc' || base === 'npmrc') {
      const text = fs.readFileSync(path.join(root, rel), 'utf8')
      if (/_auth(Token)?\s*=/i.test(text)) problems.push(`NPM REGISTRY AUTH TOKEN: ${rel}`)
    }
  }

  let scanned = 0
  for (const rel of files) {
    if (!rel.startsWith('apps/')) continue
    scanned++
    const text = fs.readFileSync(path.join(root, rel), 'utf8')
    for (const [re, label] of SECRET_PATTERNS) if (re.test(text)) problems.push(`${label} in ${rel}`)
    for (const [re, label] of HOME_PATTERNS) {
      const m = text.match(re)
      if (m) problems.push(`${label} baked into ${rel}: ${m[0]}`)
    }
  }

  if (problems.length) {
    throw new Error(
      `[bundle-hub] CREDENTIAL AUDIT FAILED — refusing to build an installer.\n` +
        problems.map((p) => `  • ${p}`).join('\n') +
        `\n\nThe installer must ship our code + the Node runtime and NOTHING else. ` +
        `See docs/alpha-release-plan.md "The landmine".`
    )
  }
  log(`credential audit passed: ${files.length} payload files, ${scanned} of them content-scanned`)
}

// -----------------------------------------------------------------------------
// `--self-test` — prove the firewall actually fires, without building anything.
// Runs the REAL auditPayload against a synthetic payload seeded with one of each
// leak class, and fails loudly if any of them would have slipped through. The
// release checklist runs this before a build so "the audit passed" means
// something. Run it with `pnpm run bundle:audit`.
// -----------------------------------------------------------------------------
const ALLOWLIST = [
  /^apps\/hub\/dist\/(?:[^/]+\/)*[^/]+\.js$/,
  /^apps\/hub\/package\.json$/,
  /^apps\/hub\/package-lock\.json$/,
  new RegExp(`^node/${path.basename(process.execPath).replace('.', '\\.')}$`),
  /^node\/node_modules\/npm\/.+$/,
]

if (process.argv.includes('--self-test')) {
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TEMP || process.env.TMPDIR || '/tmp'), 'ama-audit-'))
  const write = (rel, body = 'x') => {
    const p = path.join(tmp, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, body)
  }
  const cases = [
    ['profiles/claude-a/.credentials.json', '{}', 'claude OAuth credentials'],
    ['apps/hub/dist/auth.json', '{}', 'codex auth.json'],
    ['apps/hub/dist/sessions/rollout-2026.jsonl', '{}', 'codex rollout history'],
    ['data/hub.db', 'sqlite', 'the live journal'],
    ['apps/hub/dist/.env', 'A=1', 'a dotenv file'],
    ['apps/hub/dist/leak.js', 'const k = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAA"', 'an inline Anthropic key'],
    ['apps/hub/dist/pathleak.js', 'const p = "C:\\\\Users\\\\operator\\\\AiAgentApp"', 'an absolute operator path'],
    ['node/node_modules/npm/.npmrc', '//registry.npmjs.org/:_authToken=abc123', 'an authed .npmrc'],
    ['apps/hub/dist/README.md', 'hi', 'a non-allowlisted file'],
  ]
  let failures = 0
  for (const [rel, body, label] of cases) {
    rmrf(tmp)
    write('apps/hub/package.json', '{}')
    write('apps/hub/package-lock.json', '{}')
    write('apps/hub/dist/index.js', 'export {}')
    write(rel, body)
    let threw = false
    try {
      auditPayload(tmp, ALLOWLIST)
    } catch {
      threw = true
    }
    if (threw) log(`self-test ok — caught ${label} (${rel})`)
    else {
      failures++
      console.error(`[bundle-hub] SELF-TEST FAILED — audit did NOT catch ${label} (${rel})`)
    }
  }
  // And the clean case must PASS, or the audit is just "always throws".
  rmrf(tmp)
  write('apps/hub/package.json', '{}')
  write('apps/hub/package-lock.json', '{}')
  write('apps/hub/dist/index.js', 'export {}')
  write(`node/${path.basename(process.execPath)}`, 'binary')
  write('node/node_modules/npm/bin/npm-cli.js', 'x')
  try {
    auditPayload(tmp, ALLOWLIST)
    log('self-test ok — a clean payload passes')
  } catch (e) {
    failures++
    console.error(`[bundle-hub] SELF-TEST FAILED — a clean payload was rejected: ${e.message}`)
  }
  rmrf(tmp)
  if (failures) process.exit(1)
  log('self-test: all cases passed')
  process.exit(0)
}

// 1. Clean staging.
log(`cleaning ${outRoot}`)
rmrf(outRoot)
fs.mkdirSync(outHub, { recursive: true })
fs.mkdirSync(outNodeDir, { recursive: true })

// 2. Compile the hub (src → dist) with the workspace's TypeScript, run through
//    this same Node so the script needs no package manager on PATH.
log('compiling hub (tsc -p tsconfig.build.json)…')
const tsc = path.join(hubSrc, 'node_modules', 'typescript', 'bin', 'tsc')
execFileSync(process.execPath, [tsc, '-p', 'tsconfig.build.json'], { cwd: hubSrc, stdio: 'inherit' })
must(path.join(hubSrc, 'dist', 'index.js'), 'compiled hub entry (apps/hub/dist/index.js)')

// 3. Copy the compiled JS (our code) into the payload — ALLOWLIST, not a tree
//    sweep. Only `*.js` emitted by tsc ships; compiled unit tests (`*.test.js`)
//    and anything else tsc might emit (source maps, declarations) are dropped, so
//    a future tsconfig change can't quietly widen what the installer carries.
log('copying dist (allowlist: *.js, excluding *.test.js)…')
let copied = 0
const skipped = []
for (const rel of walkFiles(path.join(hubSrc, 'dist'))) {
  const keep = rel.endsWith('.js') && !rel.endsWith('.test.js') && !rel.endsWith('.spec.js')
  if (!keep) {
    skipped.push(rel)
    continue
  }
  const to = path.join(outHub, 'dist', rel)
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.copyFileSync(path.join(hubSrc, 'dist', rel), to)
  copied++
}
log(`dist: ${copied} files copied, ${skipped.length} skipped${skipped.length ? ` (${skipped.slice(0, 6).join(', ')}${skipped.length > 6 ? ', …' : ''})` : ''}`)

// 4. Ship the manifest and npm lock together. npm's plain `install` honors
//    package-lock.json only when it is beside package.json in the install cwd;
//    the desktop release path copies this pair from the payload into that cwd.
//
//    UPGRADE CONTRACT: at each release, run `npm outdated --omit=dev` from
//    apps/hub and review each result. To accept an upgrade, put the tested exact
//    version in package.json and refresh pnpm-lock.yaml with pnpm. Then copy
//    package.json into an empty temp directory, run
//    `npm install --package-lock-only --ignore-scripts --workspaces=false` there,
//    and copy its package-lock.json back before rerunning the hub + bundle checks.
//    Generating beside pnpm's symlinked node_modules once produced a lock full of
//    ../../node_modules/.pnpm links that worked only on the build machine. The
//    gate below rejects that, a missing/stale lock, or a drifting runtime spec;
//    upgrades never happen just because a user installs on a later day.
const sourceManifest = path.join(hubSrc, 'package.json')
const sourceLock = path.join(hubSrc, 'package-lock.json')
must(sourceLock, 'source npm lock (apps/hub/package-lock.json)')
fs.copyFileSync(sourceManifest, path.join(outHub, 'package.json'))
fs.copyFileSync(sourceLock, path.join(outHub, 'package-lock.json'))

// npm accepts exact SemVer releases (including deliberate prereleases), not
// tags/ranges/protocols that can resolve differently after the release is cut.
const EXACT_SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const stagedManifest = JSON.parse(fs.readFileSync(path.join(outHub, 'package.json'), 'utf8'))
const stagedLock = JSON.parse(fs.readFileSync(path.join(outHub, 'package-lock.json'), 'utf8'))
const lockRootDeps = stagedLock.packages?.['']?.dependencies ?? {}
const manifestDepNames = Object.keys(stagedManifest.dependencies ?? {}).sort()
const lockDepNames = Object.keys(lockRootDeps).sort()
if (JSON.stringify(manifestDepNames) !== JSON.stringify(lockDepNames)) {
  throw new Error(
    `[bundle-hub] npm lock root dependencies do not match package.json:\n` +
      `  package.json: ${manifestDepNames.join(', ')}\n` +
      `  package-lock.json: ${lockDepNames.join(', ')}`
  )
}
for (const [name, spec] of Object.entries(stagedManifest.dependencies ?? {})) {
  if (!EXACT_SEMVER.test(spec)) {
    throw new Error(`[bundle-hub] runtime dependency ${name} must use an exact SemVer, got ${JSON.stringify(spec)}`)
  }
  if (lockRootDeps[name] !== spec) {
    throw new Error(
      `[bundle-hub] stale npm lock for ${name}: package.json has ${spec}, package-lock.json has ${JSON.stringify(lockRootDeps[name])}`
    )
  }
  const workspaceVersion = JSON.parse(
    fs.readFileSync(path.join(hubSrc, 'node_modules', name, 'package.json'), 'utf8')
  ).version
  if (workspaceVersion !== spec) {
    throw new Error(
      `[bundle-hub] pnpm workspace/runtime drift for ${name}: package.json has ${spec}, installed pnpm tree has ${workspaceVersion}`
    )
  }
}
for (const [lockPath, pkg] of Object.entries(stagedLock.packages ?? {})) {
  if (!lockPath) continue
  if (
    lockPath.startsWith('../') ||
    pkg.link ||
    typeof pkg.resolved !== 'string' ||
    !pkg.resolved.startsWith('https://registry.npmjs.org/') ||
    typeof pkg.integrity !== 'string'
  ) {
    throw new Error(
      `[bundle-hub] npm lock contains a non-portable package entry at ${JSON.stringify(lockPath)} ` +
        `(resolved: ${JSON.stringify(pkg.resolved)})`
    )
  }
}
log(
  `locked runtime deps: ${Object.entries(stagedManifest.dependencies ?? {})
    .map(([name, version]) => `${name}@${version}`)
    .join(', ')}`
)

// 5. Ship the Node runtime (MIT) + npm, so the first-run install has everything
//    it needs with zero system prerequisites.
//
//    WHERE npm LIVES DIFFERS BY PLATFORM, and getting this wrong is a hard build
//    failure on macOS:
//      Windows  <prefix>\node.exe          + <prefix>\node_modules\npm
//      macOS    <prefix>/bin/node          + <prefix>/lib/node_modules/npm
//      Linux    same as macOS
//    (Homebrew, nvm, fnm, asdf and the official .pkg all follow the POSIX
//    bin/ + lib/node_modules/ layout.) We search the known locations rather than
//    assuming one, and STAGE into the single Windows-shaped layout
//    `node/node_modules/npm` on every platform — that is the layout the desktop
//    shell hardcodes (`bundled_node_dir()/node_modules/npm/bin/npm-cli.js` in
//    apps/desktop/src-tauri/src/lib.rs) and the one the credential allowlist
//    matches, so the payload is platform-identical even though the source isn't.
const nodeSrcDir = path.dirname(process.execPath)
const nodeName = path.basename(process.execPath) // node.exe / node
const stagedNode = path.join(outNodeDir, nodeName)
fs.copyFileSync(process.execPath, stagedNode)
// copyFileSync preserves the source mode, but be explicit: a Node binary that
// loses its exec bit produces an unbootable install, and the failure would only
// show up on a user's Mac.
if (process.platform !== 'win32') fs.chmodSync(stagedNode, 0o755)

const npmCandidates = [
  path.join(nodeSrcDir, 'node_modules', 'npm'), // Windows: next to node.exe
  path.join(nodeSrcDir, '..', 'lib', 'node_modules', 'npm'), // macOS/Linux: <prefix>/lib/node_modules
  path.join(nodeSrcDir, '..', 'node_modules', 'npm'), // some relocatable/nvm-ish layouts
]
const npmSrc = npmCandidates.map((p) => path.resolve(p)).find((p) => fs.existsSync(path.join(p, 'bin', 'npm-cli.js')))
if (!npmSrc) {
  throw new Error(
    `[bundle-hub] npm not found alongside node (${process.execPath}). Looked in:\n` +
      npmCandidates.map((p) => `  • ${path.resolve(p)}`).join('\n') +
      `\nInstall Node from nodejs.org (its distribution bundles npm) and re-run.`
  )
}
log(`copying npm from ${npmSrc} (for first-run install)…`)
// `dereference` on POSIX: npm's tree contains symlinks (node_modules/.bin/*).
// Copying them as symlinks would produce dangling links in the installed app AND
// smuggle content past the credential audit, which walks real files. Resolving
// them to real files keeps the payload self-contained and fully auditable.
// Windows keeps the historical (symlink-free) copy so its payload is unchanged.
fs.cpSync(npmSrc, path.join(outNodeDir, 'node_modules', 'npm'), {
  recursive: true,
  dereference: process.platform !== 'win32',
})
log(`shipped Node runtime: ${nodeName} (${process.version}, ${process.platform}-${process.arch}) + npm`)

// 6. Validate the shipped payload — our code + the runtime, nothing vendor.
must(path.join(outHub, 'dist', 'index.js'), 'hub entry in payload')
// The agent worker (docs/agent-worker-impl.md §3) ships in the same dist/ tree the whole copy above
// already carries; assert it made the payload so a hubctl worker spawn can never miss its entry.
must(path.join(outHub, 'dist', 'agentWorker.js'), 'agent worker entry in payload')
must(path.join(outHub, 'package.json'), 'hub manifest in payload')
must(path.join(outHub, 'package-lock.json'), 'npm lock in payload')
must(path.join(outNodeDir, nodeName), 'node runtime in payload')
must(path.join(outNodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), 'npm in payload')
// Assert we did NOT accidentally ship dependencies or vendor binaries.
if (fs.existsSync(path.join(outHub, 'node_modules'))) {
  throw new Error('[bundle-hub] payload unexpectedly contains apps/hub/node_modules — the installer must stay dependency-free')
}
// The bundle ships NO profile directory at all — see the header comment. This is
// the assertion that keeps it that way.
for (const forbidden of ['profiles', 'data']) {
  if (fs.existsSync(path.join(outRoot, forbidden))) {
    throw new Error(`[bundle-hub] payload contains ${forbidden}/ — the installer must ship no profiles and no journal`)
  }
}

// 6b. CREDENTIAL FIREWALL. Everything above is "did we copy what we meant to";
//     this is "prove nothing else got in". It fails the build, by design.
// ALLOWLIST (defined up top so `--self-test` exercises the exact same rules):
//   apps/hub/dist/**/*.js  +  apps/hub/{package.json,package-lock.json} — our hub
//   node/<node exe>  +  node/node_modules/npm/**     — the vendored Node runtime (MIT)
auditPayload(outRoot, ALLOWLIST)

// 7. Report.
const s = dirStats(outRoot)
log('----------------------------------------------------------------')
log(`light payload ready: ${outRoot}`)
log(`  files: ${s.files}   size: ${mb(s.bytes)}`)
log(`  node runtime: ${mb(dirStats(outNodeDir).bytes)}   our code: ${mb(dirStats(outHub).bytes)}`)
log('done. (runtime deps are fetched by npm on first launch — not in the installer)')

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
//       package.json                    (prod-only, versions pinned)
//     node/
//       node(.exe)                      (the platform Node runtime — MIT)
//       node_modules/npm/…              (npm, so first-run install needs nothing)
//
// On first launch the app copies apps/hub/{dist,package.json} into a writable
// data dir and runs `npm install --omit=dev` there, which fetches the native
// addon + vendor CLIs for the host platform. This script uses only Node
// built-ins and must run on the platform being packaged.
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

// 3. Copy the compiled JS (our code) into the payload.
log('copying dist…')
fs.cpSync(path.join(hubSrc, 'dist'), path.join(outHub, 'dist'), { recursive: true })

// 4. Pin prod-dep versions to whatever the workspace currently resolves, so the
//    first-run `npm install` reproduces the validated set instead of drifting to
//    "latest". Read the resolved version from each installed dep.
const hubPkg = JSON.parse(fs.readFileSync(path.join(hubSrc, 'package.json'), 'utf8'))
const pinned = {}
for (const dep of Object.keys(hubPkg.dependencies ?? {})) {
  const p = path.join(hubSrc, 'node_modules', dep, 'package.json') // follows the pnpm symlink
  pinned[dep] = JSON.parse(fs.readFileSync(p, 'utf8')).version
}
log(`pinned prod deps (installed at runtime): ${Object.entries(pinned).map(([k, v]) => `${k}@${v}`).join(', ')}`)

// 5. Ship a prod-only, pinned package.json — the manifest the first-run install
//    consumes. No devDependencies, no scripts.
const staged = {
  name: hubPkg.name,
  version: hubPkg.version,
  private: true,
  type: hubPkg.type, // "module" — required for the ESM dist + import.meta.dirname
  dependencies: pinned,
}
fs.writeFileSync(path.join(outHub, 'package.json'), `${JSON.stringify(staged, null, 2)}\n`)

// 6. Ship the Node runtime (MIT) + npm, so the first-run install has everything
//    it needs with zero system prerequisites. npm lives next to node.exe in the
//    official distribution.
const nodeSrcDir = path.dirname(process.execPath)
const nodeName = path.basename(process.execPath) // node.exe / node
fs.copyFileSync(process.execPath, path.join(outNodeDir, nodeName))
const npmSrc = path.join(nodeSrcDir, 'node_modules', 'npm')
if (!fs.existsSync(path.join(npmSrc, 'bin', 'npm-cli.js'))) {
  throw new Error(`[bundle-hub] npm not found next to node at ${npmSrc}. Install Node from nodejs.org (bundles npm).`)
}
log('copying npm (for first-run install)…')
fs.cpSync(npmSrc, path.join(outNodeDir, 'node_modules', 'npm'), { recursive: true })
log(`shipped Node runtime: ${nodeName} (${process.version}) + npm`)

// 7. Validate the shipped payload — our code + the runtime, nothing vendor.
must(path.join(outHub, 'dist', 'index.js'), 'hub entry in payload')
must(path.join(outHub, 'package.json'), 'hub manifest in payload')
must(path.join(outNodeDir, nodeName), 'node runtime in payload')
must(path.join(outNodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), 'npm in payload')
// Assert we did NOT accidentally ship dependencies or vendor binaries.
if (fs.existsSync(path.join(outHub, 'node_modules'))) {
  throw new Error('[bundle-hub] payload unexpectedly contains apps/hub/node_modules — the installer must stay dependency-free')
}

// 8. Report.
const s = dirStats(outRoot)
log('----------------------------------------------------------------')
log(`light payload ready: ${outRoot}`)
log(`  files: ${s.files}   size: ${mb(s.bytes)}`)
log(`  node runtime: ${mb(dirStats(outNodeDir).bytes)}   our code: ${mb(dirStats(outHub).bytes)}`)
log('done. (runtime deps are fetched by npm on first launch — not in the installer)')

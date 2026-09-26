#!/usr/bin/env node
// Build on the target architecture. No npm, vendor account or compiler is needed on the installed host.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
if (process.platform !== 'linux') throw new Error('Build Linux packages on Linux; do not ship a foreign Node runtime.')
const architecture = { x64: 'amd64', arm64: 'arm64' }[process.arch]
if (!architecture) throw new Error(`No qualified Linux package for ${process.arch}; use the architecture-native testbed bundle.`)
const payload = path.join(repo, 'apps/desktop/src-tauri/testbed-runtime')
const manifest = JSON.parse(fs.readFileSync(path.join(payload, 'manifest.json'), 'utf8'))
if (manifest.platform !== 'linux' || manifest.arch !== process.arch) throw new Error('Testbed payload does not match the package host')
const version = manifest.appVersion
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Package version must be a release version')
const output = path.join(repo, 'target/linux-testbed')
fs.mkdirSync(output, { recursive: true })
// A checkout may live on a WSL Windows mount without POSIX mode metadata. Package staging must not.
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-deb-'))
try {
  const lib = path.join(stage, 'usr/lib/allmyagents-testbed')
  fs.mkdirSync(path.dirname(lib), { recursive: true })
  fs.cpSync(payload, lib, { recursive: true })
  const allowed = new Set(['node', 'README.txt', 'manifest.json', 'build.json', 'package.json', 'SHA256SUMS',
    ...['testbedNode', 'deviceToken', 'remoteDevices', 'directHubProtocol', 'myOwnMeshRpc', 'fileTransfers'].map(name => `dist/${name}.js`)])
  const normalize = (dir) => {
    fs.chmodSync(dir, 0o755)
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) normalize(file)
      else if (entry.isFile()) {
        const relative = path.relative(lib, file)
        if (!allowed.delete(relative)) throw new Error(`Unexpected testbed payload file: ${relative}`)
        fs.chmodSync(file, entry.name === 'node' ? 0o755 : 0o644)
      }
      else throw new Error(`Unexpected non-regular payload entry: ${entry.name}`)
    }
  }
  normalize(lib)
  if (allowed.size) throw new Error(`Incomplete testbed payload: ${[...allowed].join(', ')}`)
  // Verify before shipping, not merely after download. Bundle generation has an exact file allowlist.
  execFileSync('sha256sum', ['--check', 'SHA256SUMS'], { cwd: lib, stdio: 'inherit' })
  const bin = path.join(stage, 'usr/bin')
  fs.mkdirSync(bin, { recursive: true })
  fs.writeFileSync(path.join(bin, 'allmyagents-testbed'), '#!/bin/sh\nexec /usr/lib/allmyagents-testbed/node /usr/lib/allmyagents-testbed/dist/testbedNode.js "$@"\n', { mode: 0o755 })
  const notices = path.join(stage, 'usr/share/doc/allmyagents-testbed')
  fs.mkdirSync(notices, { recursive: true })
  fs.copyFileSync(path.join(repo, 'LICENSE'), path.join(notices, 'copyright'))
  // Official Node distributions include LICENSE beside bin/. Node has no --license CLI option.
  const nodeLicense = process.env.NODE_LICENSE_FILE || path.resolve(path.dirname(process.execPath), '..', 'LICENSE')
  if (!fs.existsSync(nodeLicense)) throw new Error('Node distribution LICENSE missing; set NODE_LICENSE_FILE to the matching runtime license.')
  fs.copyFileSync(nodeLicense, path.join(notices, 'node-license.txt'))
  const control = path.join(stage, 'DEBIAN')
  fs.mkdirSync(control)
  fs.writeFileSync(path.join(control, 'control'), [
    'Package: allmyagents-testbed', `Version: ${version}`, `Architecture: ${architecture}`,
    'Maintainer: AllMyAgents <noreply@allmyagents.invalid>', 'Section: net', 'Priority: optional',
    'Depends: libc6 (>= 2.28), libstdc++6, ca-certificates',
    'Description: MyOwnMesh-native remote files and terminal for AllMyAgents',
    ' Vendor-free remote execution target. Installing this package does not enable',
    ' remote access, create sudo grants, or start a service. Select a privilege',
    ' profile with allmyagents-testbed install-user or install-elevated, then pair.', '',
  ].join('\n'))
  const name = `allmyagents-testbed_${version}_${architecture}.deb`
  const file = path.join(output, name)
  execFileSync('dpkg-deb', ['--root-owner-group', '--build', stage, file], { stdio: 'inherit' })
  fs.writeFileSync(`${file}.sha256`, `${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}  ${name}\n`)
  console.log(`Packaged ${file}; services and grants are unchanged until explicit configuration.`)
} finally {
  fs.rmSync(stage, { recursive: true, force: true }) // Only our newly-created staging directory.
}

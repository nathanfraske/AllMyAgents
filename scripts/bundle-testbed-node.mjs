#!/usr/bin/env node
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const hub = path.join(root, 'apps', 'hub')
const output = path.join(root, 'apps', 'desktop', 'src-tauri', 'testbed-runtime')
const distOutput = path.join(output, 'dist')
const runtimeName = process.platform === 'win32' ? 'node.exe' : 'node'
const modules = ['testbedNode.js', 'deviceToken.js', 'remoteDevices.js', 'directHubProtocol.js', 'myOwnMeshRpc.js']
const tauriConfig = JSON.parse(fs.readFileSync(path.join(root, 'apps', 'desktop', 'src-tauri', 'tauri.conf.json'), 'utf8'))
let sourceCommit
try {
  sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
} catch {
  sourceCommit = undefined
}

execFileSync(process.execPath, [
  path.join(hub, 'node_modules', 'typescript', 'bin', 'tsc'),
  '-p',
  path.join(hub, 'tsconfig.build.json'),
], {
  cwd: root,
  stdio: 'inherit',
})

fs.rmSync(output, { recursive: true, force: true })
fs.mkdirSync(distOutput, { recursive: true })
for (const moduleName of modules) {
  const source = path.join(hub, 'dist', moduleName)
  if (!fs.existsSync(source)) throw new Error(`compiled testbed module is missing: ${moduleName}`)
  fs.copyFileSync(source, path.join(distOutput, moduleName))
}
fs.copyFileSync(process.execPath, path.join(output, runtimeName))
if (process.platform !== 'win32') fs.chmodSync(path.join(output, runtimeName), 0o755)
fs.writeFileSync(path.join(output, 'package.json'), `${JSON.stringify({
  private: true,
  type: 'module',
}, null, 2)}\n`)
fs.writeFileSync(path.join(output, 'build.json'), `${JSON.stringify({
  version: 1,
  appVersion: typeof tauriConfig.version === 'string' ? tauriConfig.version : undefined,
  ...(sourceCommit ? { sourceCommit } : {}),
}, null, 2)}\n`)

const launch = process.platform === 'win32'
  ? '.\\node.exe .\\dist\\testbedNode.js'
  : './node ./dist/testbedNode.js'
fs.writeFileSync(path.join(output, 'README.txt'), [
  'AllMyAgents lightweight testbed node',
  '',
  'This payload contains no vendor CLI, account, journal, project, or operator credential.',
  'It requires a running AllMyStuff/MyOwnMesh node on the target machine.',
  '',
  `Scoped: ${launch} configure --profile scoped --root <path> --read --write --terminal`,
  `Run:    ${launch} run`,
  `Code:   ${launch} pair-code`,
  `Elevated machine install: ${launch} install-elevated --profile elevated-machine`,
  ...(process.platform === 'linux'
    ? [`Dedicated service user with passwordless sudo: ${launch} install-elevated --profile linux-sudo-machine`]
    : []),
  '',
  'Same signed-fleet peers can authorize over the authenticated fleet roster without a pairing code.',
  'An agent still needs an explicit per-chat device/root grant from its source AllMyAgents hub.',
  '',
].join('\n'))

fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify({
  version: 1,
  kind: 'allmyagents-lightweight-testbed',
  platform: process.platform,
  arch: process.arch,
  protocol: 1,
  appVersion: typeof tauriConfig.version === 'string' ? tauriConfig.version : undefined,
  ...(sourceCommit ? { sourceCommit } : {}),
}, null, 2))

const files = [runtimeName, 'README.txt', 'manifest.json', 'package.json', 'build.json', ...modules.map((name) => `dist/${name}`)]
const sums = files.map((relative) => {
  const digest = crypto.createHash('sha256').update(fs.readFileSync(path.join(output, relative))).digest('hex')
  return `${digest}  ${relative.replaceAll('\\', '/')}`
})
fs.writeFileSync(path.join(output, 'SHA256SUMS'), `${sums.join('\n')}\n`)

const actual = fs.readdirSync(output).sort()
const expected = ['README.txt', 'SHA256SUMS', 'manifest.json', 'package.json', 'build.json', 'dist', runtimeName].sort()
if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('testbed payload contains an unexpected top-level file')
process.stdout.write(`[bundle-testbed] built ${output} for ${process.platform}/${process.arch}\n`)

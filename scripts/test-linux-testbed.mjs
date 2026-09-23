#!/usr/bin/env node
// Installed-payload smoke, not a live fleet deployment. Uses only isolated data and harmless commands.
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

if (process.platform !== 'linux') throw new Error('Run the installed Linux qualification on Linux')
const packageFile = path.resolve(process.argv[2])
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-linux-package-'))
try {
  execFileSync('dpkg-deb', ['--extract', packageFile, work])
  const payload = path.join(work, 'usr/lib/allmyagents-testbed')
  execFileSync('sha256sum', ['-c', 'SHA256SUMS'], { cwd: payload })
  const node = path.join(payload, 'node')
  const cli = path.join(payload, 'dist/testbedNode.js')
  assert.match(execFileSync(node, [cli, '--help'], { encoding: 'utf8' }), /install-user/)
  const data = path.join(work, 'isolated-data')
  execFileSync(node, [cli, 'configure', '--profile', 'full-machine', '--data-dir', data])
  const { DeviceExecutor } = await import(pathToFileURL(path.join(payload, 'dist/remoteDevices.js')).href)
  const executor = new DeviceExecutor(path.join(data, 'device-executor.json'))
  const caps = executor.capabilities()
  assert.equal(caps.platform, 'linux')
  assert.equal(caps.arch, process.arch)
  assert.equal(caps.durableCommands, 1)
  assert.equal(caps.roots[0].path, '/')
  assert.equal(caps.roots[0].terminal, true)
  // More than the former 120-second interactive limit, with no execution deadline.
  // Short mode is for iterative packaging checks; CI/release always uses the full interval.
  const seconds = process.argv.includes('--short') ? 1 : 125
  const jobId = crypto.randomUUID()
  const actor = { durableRunId: jobId }
  const action = { op: 'exec_start', rootId: caps.roots[0].id, jobId,
    command: `sleep ${seconds}; printf 'linux packaged node OK'`, timeoutMs: 0 }
  assert.equal((await executor.execute(action, actor)).jobState, 'running')
  assert.equal((await executor.execute(action, actor)).ok, false) // No duplicate start.
  let result
  const deadline = Date.now() + (seconds + 20) * 1000
  do {
    await new Promise(resolve => setTimeout(resolve, 250))
    result = await executor.execute({ op: 'exec_status', rootId: action.rootId, jobId }, actor)
    if (Date.now() > deadline) throw new Error('Packaged command did not complete')
  } while (result.jobState === 'running')
  assert.equal(result.ok, true)
  assert.equal(result.stdout, 'linux packaged node OK')
  assert.equal(result.timedOut, false)
  assert.ok(result.telemetry.targetMs >= seconds * 1000, 'Retained duration must measure the command, not the last status query')
  console.log(JSON.stringify({ packageFile, platform: caps.platform, arch: caps.arch, seconds,
    unlimited: true, exactOnce: true, targetMs: result.telemetry.targetMs, exitCode: result.exitCode }))
} finally {
  fs.rmSync(work, { recursive: true, force: true })
}

#!/usr/bin/env node
// Installed-payload smoke, not a live fleet deployment. Uses only isolated data and harmless commands.
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { mock } from 'node:test'

if (process.platform !== 'linux') throw new Error('Run the installed Linux qualification on Linux')
const [input, ...flags] = process.argv.slice(2)
// Retain --short as a compatibility alias, not a reduced-checks mode. All runners use the default.
if (!input || input.startsWith('-') || flags.length > 1 || flags.some(flag => flag !== '--short')) {
  throw new Error('Usage: node scripts/test-linux-testbed.mjs <package.deb> [--short (deprecated no-op)]')
}
const packageFile = path.resolve(input)
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
  assert.equal(caps.fileTransfers, 1)
  assert.equal(caps.roots[0].path, '/')
  assert.equal(caps.roots[0].terminal, true)
  // Exercise the shipped module through DeviceExecutor, not a source-tree import. All file effects
  // stay in this extracted package's unique temporary directory; no service or fleet policy changes.
  const bytes = Buffer.alloc(8 * 1024 * 1024 + 17, 173)
  const digest = crypto.createHash('sha256').update(bytes).digest('hex')
  const output = path.join(work, 'transfer-output.bin')
  const relativeOutput = path.relative(caps.roots[0].path, output)
  const writeId = crypto.randomUUID(), readId = crypto.randomUUID()
  const transferActor = { transferOwner: 'isolated-package-qualification' }
  const request = async (id, mode, fields, owner = transferActor) => executor.execute({
    op: 'file_transfer', rootId: caps.roots[0].id, transfer: { id, mode, ...fields },
  }, owner)
  assert.equal((await request(writeId, 'write', { operation: 'begin', path: relativeOutput, size: bytes.length }, {})).ok, false)
  assert.equal((await request(writeId, 'write', { operation: 'begin', path: relativeOutput, size: bytes.length })).ok, true)
  assert.equal((await request(writeId, 'write', { operation: 'status' }, { transferOwner: 'wrong-owner' })).ok, false)
  for (let offset = 0; offset < bytes.length; offset += 512 * 1024) {
    const result = await request(writeId, 'write', { operation: 'chunk', offset, content: bytes.subarray(offset, offset + 512 * 1024).toString('base64') })
    assert.equal(result.ok, true)
    assert.equal(result.transfer.offset, Math.min(offset + 512 * 1024, bytes.length))
  }
  const published = await request(writeId, 'write', { operation: 'finish', sha256: digest })
  assert.equal(published.ok, true)
  assert.equal(published.transfer.sha256, digest)
  assert.equal(fs.readFileSync(output).equals(bytes), true)
  assert.equal((await request(writeId, 'write', { operation: 'finish', sha256: digest })).ok, false)
  assert.equal((await request(crypto.randomUUID(), 'write', { operation: 'begin', path: relativeOutput, size: 0 })).ok, false)
  const reopened = new DeviceExecutor(path.join(data, 'device-executor.json'))
  const retained = await reopened.execute({ op: 'file_transfer', rootId: caps.roots[0].id, transfer: { id: writeId, mode: 'write', operation: 'status' } }, transferActor)
  assert.equal(retained.transfer.state, 'completed')
  assert.equal(retained.transfer.sha256, digest)
  assert.equal((await request(readId, 'read', { operation: 'begin', path: relativeOutput })).ok, true)
  const downloaded = crypto.createHash('sha256')
  for (let offset = 0; offset < bytes.length;) {
    const result = await request(readId, 'read', { operation: 'chunk', offset })
    assert.equal(result.ok, true)
    assert.ok(result.transfer.offset > offset)
    downloaded.update(Buffer.from(result.transfer.content, 'base64'))
    offset = result.transfer.offset
  }
  assert.equal((await request(readId, 'read', { operation: 'finish' })).transfer.sha256, digest)
  assert.equal(downloaded.digest('hex'), digest)
  console.log(JSON.stringify({ qualification: 'installed-package-file-transfer', bytes: bytes.length, sha256: digest,
    upload: true, download: true, ownerBound: true, noOverwrite: true, noReplay: true, retainedReceipt: true }))
  // Keep the installed-executor regression past the former 120-second limit, without making every
  // hosted/fleet/release job sleep 125 seconds. Only the executor's JS deadline timers are advanced;
  // the child, polling, Date and performance clock remain real. The finite-deadline positive control
  // proves the packaged timer/kill path fires; ignored deadlines must not produce a green result.
  const seconds = 1
  const simulatedDeadlineMs = 125_000
  for (const timeoutMs of [0, 120_000]) {
    const jobId = crypto.randomUUID()
    const actor = { durableRunId: jobId }
    const action = { op: 'exec_start', rootId: caps.roots[0].id, jobId,
      command: `sleep ${seconds}; printf 'linux packaged node OK'`, timeoutMs }
    mock.timers.enable({ apis: ['setTimeout'] })
    try {
      assert.equal((await executor.execute(action, actor)).jobState, 'running')
      assert.equal((await executor.execute(action, actor)).ok, false) // No duplicate start.
      mock.timers.tick(simulatedDeadlineMs)
    } finally {
      mock.timers.reset() // Poll/telemetry assertions below must use real time, even on failure.
    }
    let result
    const deadline = Date.now() + (seconds + 20) * 1000
    do {
      await new Promise(resolve => setTimeout(resolve, 250))
      result = await executor.execute({ op: 'exec_status', rootId: action.rootId, jobId }, actor)
      if (Date.now() > deadline) throw new Error('Packaged command did not complete')
    } while (result.jobState === 'running')
    assert.equal(result.jobState, 'completed')
    assert.equal(result.ok, timeoutMs === 0)
    assert.equal(result.timedOut, timeoutMs !== 0)
    if (timeoutMs === 0) {
      assert.equal(result.stdout, 'linux packaged node OK')
      assert.equal(result.exitCode, 0)
      assert.ok(result.telemetry.targetMs >= seconds * 1000, 'Retained duration must measure the command, not the last status query')
    } else {
      assert.match(result.error, /command timed out after 120000ms/)
    }
    console.log(JSON.stringify({ packageFile, platform: caps.platform, arch: caps.arch, seconds,
      simulatedDeadlineMs, timeoutMs, unlimited: timeoutMs === 0, timedOut: result.timedOut,
      exactOnce: true, targetMs: result.telemetry.targetMs, exitCode: result.exitCode }))
  }
} finally {
  fs.rmSync(work, { recursive: true, force: true })
}

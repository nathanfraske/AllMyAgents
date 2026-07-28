// Destructive only inside temporary fixtures; uses the lane-owned port 7802 and refuses live/shared ports.
// Build first: pnpm hub:build && pnpm accept:orphan-supervisor
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(fileURLToPath(import.meta.url), '..', '..')
const built = path.join(repo, 'apps', 'hub', 'dist')
const port = Number(process.env.ORPHAN_ACCEPT_PORT ?? 7802)
if (port === 7777 || port === 7788) throw new Error(`refusing protected port ${port}`)
if (!fs.existsSync(path.join(built, 'hubctl.js'))) {
  throw new Error('apps/hub/dist/hubctl.js is missing; run pnpm hub:build first')
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-hubctl-orphan-'))
  const dist = path.join(root, 'dist')
  fs.cpSync(built, dist, { recursive: true })
  return { root, dist, entry: path.join(dist, 'hubctl.js'), hub: path.join(dist, 'index.js') }
}

function launch(entry, cwd) {
  const env = {
    ...process.env,
    HUB_FIXED_PORT: String(port),
    HUB_WORKER: '0',
    HUBCTL_DEV: '0',
    HUB_DATA_DIR: path.join(cwd, 'data'),
    HUB_PROFILES_DIR: path.join(cwd, 'profiles'),
  }
  delete env.HUB_WORKER_SOCKET
  const child = spawn(process.execPath, [entry], {
    cwd,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (chunk) => (output += chunk))
  child.stderr.on('data', (chunk) => (output += chunk))
  return { child, output: () => output }
}

function waitFor(check, timeoutMs, description) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (check()) return resolve()
      if (Date.now() - started >= timeoutMs) return reject(new Error(`timed out waiting for ${description}`))
      setTimeout(poll, 25)
    }
    poll()
  })
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return child.exitCode
  return Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((_, reject) => setTimeout(() => reject(new Error('supervisor did not exit')), timeoutMs)),
  ])
}

async function missingEntryScenario() {
  const held = net.createServer()
  await new Promise((resolve, reject) => {
    held.once('error', reject)
    held.listen(port, '127.0.0.1', resolve)
  })
  const copy = fixture()
  const run = launch(copy.entry, copy.root)
  try {
    await waitFor(() => run.output().includes('supervisor starting'), 5_000, 'supervisor start')
    fs.rmSync(copy.entry)
    const code = await waitForExit(run.child, 8_000)
    const output = run.output()
    if (code !== 1) throw new Error(`missing-entry supervisor exited ${code}\n${output}`)
    if (!output.includes('supervisor entry no longer exists')) {
      throw new Error(`missing-entry diagnostic absent\n${output}`)
    }
    if ((output.match(/respawning in/g) ?? []).length > 0) {
      throw new Error(`missing-entry supervisor attempted another spawn\n${output}`)
    }
    console.log('PASS missing supervisor entry exits before another revive')
  } finally {
    if (run.child.exitCode === null) run.child.kill()
    held.close()
    fs.rmSync(copy.root, { recursive: true, force: true })
  }
}

async function boundedFailureScenario() {
  const copy = fixture()
  fs.writeFileSync(copy.hub, 'process.exit(1)\n')
  const run = launch(copy.entry, copy.root)
  try {
    const code = await waitForExit(run.child, 20_000)
    const output = run.output()
    if (code !== 1) throw new Error(`repeated-failure supervisor exited ${code}\n${output}`)
    if (!output.includes('recovery failure 5/5') || !output.includes('TERMINAL supervisor failure')) {
      throw new Error(`bounded failure diagnostic absent\n${output}`)
    }
    const failures = (output.match(/recovery failure \d+\/5/g) ?? []).length
    if (failures !== 5) throw new Error(`expected 5 failures, saw ${failures}\n${output}`)
    console.log('PASS five identical failed revives stop the supervisor')
  } finally {
    if (run.child.exitCode === null) run.child.kill()
    fs.rmSync(copy.root, { recursive: true, force: true })
  }
}

async function occupiedPortScenario() {
  const held = net.createServer()
  await new Promise((resolve, reject) => {
    held.once('error', reject)
    held.listen(port, '127.0.0.1', resolve)
  })
  const copy = fixture()
  const run = launch(copy.entry, copy.root)
  try {
    const code = await waitForExit(run.child, 8_000)
    const output = run.output()
    if (code !== 1) throw new Error(`occupied-port supervisor exited ${code}\n${output}`)
    if (!output.includes(`fixed port ${port} is still held`)) {
      throw new Error(`occupied-port terminal diagnostic absent\n${output}`)
    }
    if ((output.match(/respawning in/g) ?? []).length > 0) {
      throw new Error(`occupied-port supervisor attempted another spawn\n${output}`)
    }
    console.log('PASS occupied dead-hub port is terminal before another revive')
  } finally {
    if (run.child.exitCode === null) run.child.kill()
    held.close()
    fs.rmSync(copy.root, { recursive: true, force: true })
  }
}

await missingEntryScenario()
await occupiedPortScenario()
await boundedFailureScenario()

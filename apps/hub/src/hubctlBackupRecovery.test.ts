import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

const hubRoot = path.resolve(import.meta.dirname, '..')
const supervisors: ChildProcess[] = []
const scenarioRoots: string[] = []
let buildRoot = ''
let hubctlEntry = ''

const fixtureHub = `
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

const scenario = process.env.HUB_TEST_SCENARIO
const stateDir = process.env.HUB_TEST_STATE_DIR
const requestedPort = Number(process.env.HUB_PORT)
const publicPort = Number(process.env.HUB_FIXED_PORT)
if (!scenario || !stateDir || !Number.isInteger(requestedPort) || !Number.isInteger(publicPort)) {
  throw new Error('fixture hub is missing its scenario environment')
}

fs.mkdirSync(stateDir, { recursive: true })
const marker = (name) => path.join(stateDir, name)
const mark = (name) => fs.writeFileSync(marker(name), String(process.pid))
const has = (name) => fs.existsSync(marker(name))
const role = requestedPort === 0 ? 'green' : 'blue'
let bootOrdinal = 0
if (role === 'blue') {
  const bootFile = marker('blue-boot-count')
  bootOrdinal = fs.existsSync(bootFile) ? Number(fs.readFileSync(bootFile, 'utf8')) + 1 : 1
  fs.writeFileSync(bootFile, String(bootOrdinal))
}
const firstBlue = role === 'blue' && bootOrdinal === 1
const sockets = new Set()
const server = http.createServer((request, response) => {
  if (request.url === '/api/health') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ boot: 'complete', restoredSessions: 0 }))
    return
  }
  if (request.url === '/api/auth') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{}')
    return
  }
  response.writeHead(404)
  response.end()
})
server.on('connection', (socket) => {
  sockets.add(socket)
  socket.once('close', () => sockets.delete(socket))
})

const send = (message) => process.send?.(message)
const listen = (port) => new Promise((resolve, reject) => {
  const onError = (error) => {
    server.off('listening', onListening)
    reject(error)
  }
  const onListening = () => {
    server.off('error', onError)
    resolve()
  }
  server.once('error', onError)
  server.once('listening', onListening)
  server.listen(port, '127.0.0.1')
})
const close = () => new Promise((resolve) => {
  for (const socket of sockets) socket.destroy()
  sockets.clear()
  if (!server.listening) {
    resolve()
    return
  }
  server.close(() => resolve())
})
const waitForMarker = async (name) => {
  while (!has(name)) await new Promise((resolve) => setTimeout(resolve, 5))
}

await listen(requestedPort)
const address = server.address()
if (!address || typeof address === 'string') throw new Error('fixture listener did not bind')
send({ type: 'ready', port: address.port, restored: 0, schemaVersion: 1 })

let restartRequested = false
if (firstBlue && scenario.startsWith('post-listener-')) {
  const watcher = setInterval(() => {
    if (!has('green-bound-public')) return
    clearInterval(watcher)
    mark('blue-exit-started')
    console.log('[fixture] blue exiting after green public bind')
    process.exit(43)
  }, 5)
}

const respondControl = (message, overrides = {}) => send({
  type: 'journal-backup-control-result',
  requestId: message.requestId,
  epoch: message.epoch,
  active: message.active,
  applied: true,
  ...overrides,
})

async function handle(message) {
  if (message?.type === 'journal-backup-control') {
    if (role === 'blue') {
      if (!message.active && firstBlue && scenario === 'precommit-blue-death') {
        mark('blue-exit-started')
        console.log('[fixture] blue exiting before pause acknowledgement')
        process.exit(42)
        return
      }
      respondControl(message)
      if (message.active && firstBlue && !restartRequested) {
        restartRequested = true
        setTimeout(() => send({ type: 'restart-request', reason: scenario }), 25)
      }
      return
    }

    if (message.active) {
      await waitForMarker('allow-green-activation')
      if (scenario === 'post-listener-blue-death-failure') {
        respondControl(message, {
          active: false,
          applied: false,
          error: 'fixture rejected green backup activation',
        })
      } else {
        respondControl(message)
      }
    } else {
      respondControl(message)
    }
    return
  }

  if (message?.type === 'drain') {
    await close()
    send({ type: 'released' })
    return
  }

  if (message?.type === 'promote') {
    await close()
    await listen(message.port)
    mark('green-bound-public')
    if (scenario === 'lost-promoted-ack') {
      console.log('[fixture] green bound public listener; promoted ACK withheld')
    } else {
      console.log('[fixture] green bound public listener; promoted ACK sent')
      send({ type: 'promoted' })
    }
    return
  }

  if (message?.type === 'restart-aborted') {
    console.log('[fixture] restart-aborted reached a surviving blue')
    if (!server.listening) await listen(publicPort)
    send({ type: 'rollback-rebound' })
    return
  }

  if (message?.type === 'retire') {
    await close()
    process.exit(0)
  }
}

process.on('message', (message) => {
  void handle(message).catch((error) => {
    console.error('[fixture] message handler failed', error)
    process.exit(50)
  })
})
process.on('disconnect', () => process.exit(0))
`

class OutputCapture {
  text = ''
  private readonly messages: unknown[] = []
  private waiters = new Set<{
    pattern: RegExp
    resolve: () => void
    reject: (error: Error) => void
    timer: NodeJS.Timeout
  }>()
  private messageWaiters = new Set<{
    type: string
    resolve: (message: unknown) => void
    reject: (error: Error) => void
    timer: NodeJS.Timeout
  }>()

  constructor(readonly child: ChildProcess) {
    const append = (chunk: Buffer | string): void => {
      this.text += String(chunk)
      for (const waiter of [...this.waiters]) {
        if (!waiter.pattern.test(this.text)) continue
        clearTimeout(waiter.timer)
        this.waiters.delete(waiter)
        waiter.resolve()
      }
    }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    child.on('message', (message: unknown) => {
      this.messages.push(message)
      for (const waiter of [...this.messageWaiters]) {
        if (
          !message ||
          typeof message !== 'object' ||
          (message as { type?: unknown }).type !== waiter.type
        ) {
          continue
        }
        clearTimeout(waiter.timer)
        this.messageWaiters.delete(waiter)
        waiter.resolve(message)
      }
    })
    child.once('exit', (code, signal) => {
      for (const waiter of [...this.waiters]) {
        clearTimeout(waiter.timer)
        this.waiters.delete(waiter)
        waiter.reject(
          new Error(
            `hubctl exited before ${String(waiter.pattern)} ` +
              `(code=${String(code)} signal=${String(signal)}):\n${this.text}`
          )
        )
      }
      for (const waiter of [...this.messageWaiters]) {
        clearTimeout(waiter.timer)
        this.messageWaiters.delete(waiter)
        waiter.reject(
          new Error(
            `hubctl exited before IPC ${waiter.type} ` +
              `(code=${String(code)} signal=${String(signal)}):\n${this.text}`
          )
        )
      }
    })
  }

  waitFor(pattern: RegExp, timeoutMs = 20_000): Promise<void> {
    if (pattern.test(this.text)) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const waiter = {
        pattern,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters.delete(waiter)
          reject(new Error(`timed out waiting for ${String(pattern)}:\n${this.text}`))
        }, timeoutMs),
      }
      this.waiters.add(waiter)
    })
  }

  count(fragment: string): number {
    return this.text.split(fragment).length - 1
  }

  countMessages(type: string): number {
    return this.messages.filter(
      (message) =>
        !!message &&
        typeof message === 'object' &&
        (message as { type?: unknown }).type === type
    ).length
  }

  waitForMessage<T extends { type: string }>(
    type: T['type'],
    timeoutMs = 20_000
  ): Promise<T> {
    const existing = this.messages.find(
      (message) =>
        !!message &&
        typeof message === 'object' &&
        (message as { type?: unknown }).type === type
    )
    if (existing) return Promise.resolve(existing as T)
    return new Promise<T>((resolve, reject) => {
      const waiter = {
        type,
        resolve: (message: unknown) => resolve(message as T),
        reject,
        timer: setTimeout(() => {
          this.messageWaiters.delete(waiter)
          reject(new Error(`timed out waiting for hubctl IPC ${type}:\n${this.text}`))
        }, timeoutMs),
      }
      this.messageWaiters.add(waiter)
    })
  }
}

function replaceExactly(source: string, from: string, to: string, label: string): string {
  const first = source.indexOf(from)
  if (first < 0 || source.indexOf(from, first + from.length) >= 0) {
    throw new Error(`compiled hubctl ${label} seam was not unique`)
  }
  return source.slice(0, first) + to + source.slice(first + from.length)
}

async function compileHubFixture(): Promise<void> {
  buildRoot = fs.mkdtempSync(path.join(hubRoot, '.hubctl-backup-recovery-'))
  const outDir = path.join(buildRoot, 'dist')
  const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc')
  const compiler = spawn(
    process.execPath,
    [tsc, '-p', path.join(hubRoot, 'tsconfig.build.json'), '--outDir', outDir],
    {
      cwd: hubRoot,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  )
  let output = ''
  compiler.stdout?.setEncoding('utf8')
  compiler.stderr?.setEncoding('utf8')
  compiler.stdout?.on('data', (chunk: string) => (output += chunk))
  compiler.stderr?.on('data', (chunk: string) => (output += chunk))
  const [code, signal] = await once(compiler, 'exit') as [
    number | null,
    NodeJS.Signals | null,
  ]
  if (code !== 0) {
    throw new Error(
      `hubctl fixture build failed (code=${String(code)} signal=${String(signal)}): ${output}`
    )
  }
  hubctlEntry = path.join(outDir, 'hubctl.js')
  let compiledHubctl = fs.readFileSync(hubctlEntry, 'utf8')
  compiledHubctl = replaceExactly(
    compiledHubctl,
    "await waitForHubMsg(green.child, 'promoted', 8_000);",
    "await waitForHubMsg(green.child, 'promoted', Number(process.env.HUB_TEST_PROMOTE_ACK_TIMEOUT_MS ?? 8_000));",
    'promotion timeout'
  )
  compiledHubctl = replaceExactly(
    compiledHubctl,
    `killGreen: (child) => {
                        green.state = 'retired';
                        killTree(child);
                    },`,
    `killGreen: (child) => {
                        green.state = 'retired';
                        if (process.env.HUB_TEST_HOLD_GREEN_KILL === '1' && process.send) {
                            const release = (message) => {
                                if (message?.type === 'hubctl-test-probe-green-kill-wait') {
                                    process.send({ type: 'hubctl-test-green-kill-waiting' });
                                    return;
                                }
                                if (message?.type !== 'hubctl-test-release-green-kill')
                                    return;
                                process.off('message', release);
                                killTree(child);
                            };
                            process.on('message', release);
                            process.send({ type: 'hubctl-test-green-kill-pending', pid: child.pid });
                        }
                        else {
                            killTree(child);
                        }
                    },`,
    'green kill'
  )
  if (process.env.AMA_HUBCTL_MUTATE_PROMOTION_FENCE === '1') {
    compiledHubctl = replaceExactly(
      compiledHubctl,
      `greenMayOwnPublicListener = true;
        sendToHub(green.child, { type: 'promote', port: FIXED_PORT }); // green: re-listen on 7777
        await waitForHubMsg(green.child, 'promoted', Number(process.env.HUB_TEST_PROMOTE_ACK_TIMEOUT_MS ?? 8_000));`,
      `sendToHub(green.child, { type: 'promote', port: FIXED_PORT }); // MUTATION: fence moved after ACK
        await waitForHubMsg(green.child, 'promoted', Number(process.env.HUB_TEST_PROMOTE_ACK_TIMEOUT_MS ?? 8_000));
        greenMayOwnPublicListener = true;`,
      'promotion fence mutation'
    )
  }
  fs.writeFileSync(hubctlEntry, compiledHubctl)
  const rollbackEntry = path.join(outDir, 'restartRollback.js')
  let compiledRollback = fs.readFileSync(rollbackEntry, 'utf8')
  compiledRollback = replaceExactly(
    compiledRollback,
    'await requestRebind(blue, reason, options.rollbackRebindTimeoutMs ?? 8_000);',
    `process.send?.({ type: 'hubctl-test-blue-rebind-attempt' });
        await requestRebind(blue, reason, options.rollbackRebindTimeoutMs ?? 8_000);`,
    'blue rebind observation'
  )
  fs.writeFileSync(rollbackEntry, compiledRollback)
  fs.writeFileSync(path.join(outDir, 'index.js'), fixtureHub)
}

async function reserveEphemeralPort(): Promise<number> {
  for (;;) {
    const reservation = http.createServer()
    await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve))
    const address = reservation.address()
    if (!address || typeof address === 'string') throw new Error('port reservation did not bind')
    await new Promise<void>((resolve) => reservation.close(() => resolve()))
    if (address.port !== 7777 && address.port !== 7788) return address.port
  }
}

async function startScenario(
  scenario:
    | 'precommit-blue-death'
    | 'post-listener-blue-death-failure'
    | 'post-listener-blue-death-commit'
    | 'lost-promoted-ack'
): Promise<{ capture: OutputCapture; stateDir: string }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-hubctl-backup-recovery-'))
  scenarioRoots.push(root)
  const stateDir = path.join(root, 'state')
  const publicPort = await reserveEphemeralPort()
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HUB_FIXED_PORT: String(publicPort),
    HUB_DATA_DIR: path.join(root, 'data'),
    HUB_TEST_SCENARIO: scenario,
    HUB_TEST_STATE_DIR: stateDir,
  }
  if (scenario === 'lost-promoted-ack') {
    env.HUB_TEST_PROMOTE_ACK_TIMEOUT_MS = '100'
    env.HUB_TEST_HOLD_GREEN_KILL = '1'
  }
  delete env.HUBCTL_DEV
  delete env.HUB_WORKER
  delete env.HUB_WORKER_SOCKET
  const child = spawn(process.execPath, [hubctlEntry], {
    cwd: hubRoot,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  supervisors.push(child)
  const capture = new OutputCapture(child)
  await capture.waitFor(/hub \(blue\) live on/)
  return { capture, stateDir }
}

async function stopSupervisor(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([
    once(child, 'exit'),
    new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
  ])
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
}

beforeAll(async () => {
  await compileHubFixture()
}, 30_000)

afterEach(async () => {
  await Promise.all(supervisors.splice(0).map(stopSupervisor))
  for (const root of scenarioRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })
  }
})

afterAll(() => {
  if (buildRoot) {
    fs.rmSync(buildRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })
  }
})

describe('hubctl live-blue death during backup handoff', () => {
  it('fences a public green whose promoted ACK is lost before blue can rebind', async () => {
    const { capture } = await startScenario('lost-promoted-ack')

    await capture.waitFor(/green bound public listener; promoted ACK withheld/)
    await capture.waitForMessage<{ type: 'hubctl-test-green-kill-pending' }>(
      'hubctl-test-green-kill-pending'
    )
    capture.child.send?.({ type: 'hubctl-test-probe-green-kill-wait' })
    await capture.waitForMessage<{ type: 'hubctl-test-green-kill-waiting' }>(
      'hubctl-test-green-kill-waiting'
    )

    expect(capture.countMessages('hubctl-test-blue-rebind-attempt')).toBe(0)
    expect(capture.text).not.toContain('restart-aborted reached a surviving blue')
    expect(capture.text).not.toContain('EADDRINUSE')

    capture.child.send?.({ type: 'hubctl-test-release-green-kill' })
    await capture.waitFor(/hub\(green\) exited/)
    await capture.waitForMessage<{ type: 'hubctl-test-blue-rebind-attempt' }>(
      'hubctl-test-blue-rebind-attempt'
    )
    await capture.waitFor(/restart-aborted reached a surviving blue/)
    await capture.waitFor(/blue journal backups resumed after rollback/)

    expect(capture.text.indexOf('hub(green) exited')).toBeLessThan(
      capture.text.indexOf('restart-aborted reached a surviving blue')
    )
    expect(capture.text).not.toContain('EADDRINUSE')
    expect(capture.count('live hub is down — respawning')).toBe(0)
  }, 15_000)

  it('clears a blue that dies before pause acknowledgement and revives exactly once', async () => {
    const { capture } = await startScenario('precommit-blue-death')

    await capture.waitFor(/blue exiting before pause acknowledgement/)
    await capture.waitFor(/restart rollback failed during blue-survival/)
    await capture.waitFor(/hub recovered on/)
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(capture.text).not.toContain('restart-aborted reached a surviving blue')
    expect(capture.text).not.toContain('EADDRINUSE')
    expect(capture.count('live hub is down — respawning')).toBe(1)
  }, 15_000)

  it('fences green, skips dead-blue rollback, and revives once after pre-ownership failure', async () => {
    const { capture, stateDir } = await startScenario('post-listener-blue-death-failure')

    await capture.waitFor(/green bound public listener/)
    await capture.waitFor(/hub\(blue\) exited/)
    expect(capture.count('live hub is down — respawning')).toBe(0)

    fs.writeFileSync(path.join(stateDir, 'allow-green-activation'), 'go')
    await capture.waitFor(/restart rollback failed during blue-survival/)
    await capture.waitFor(/hub recovered on/)
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(capture.text).not.toContain('restart-aborted reached a surviving blue')
    expect(capture.text).not.toContain('EADDRINUSE')
    expect(capture.count('live hub is down — respawning')).toBe(1)
  }, 15_000)

  it('cancels deferred revival when green commits after blue dies post-listener', async () => {
    const { capture, stateDir } = await startScenario('post-listener-blue-death-commit')

    await capture.waitFor(/green bound public listener/)
    await capture.waitFor(/hub\(blue\) exited/)
    expect(capture.count('live hub is down — respawning')).toBe(0)

    fs.writeFileSync(path.join(stateDir, 'allow-green-activation'), 'go')
    await capture.waitFor(/green live on/)
    await capture.waitFor(/blue retiring|post-flip cleanup error/)
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(capture.text).not.toContain('EADDRINUSE')
    expect(capture.count('live hub is down — respawning')).toBe(0)
  }, 15_000)
})

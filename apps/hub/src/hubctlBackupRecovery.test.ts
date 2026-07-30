import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { Journal } from './journal.js'
import { snapshotJournal } from './journalBackup.js'
import { JournalRecoveryLease } from './journalRecovery.js'

const hubRoot = path.resolve(import.meta.dirname, '..')
const supervisors: ChildProcess[] = []
const scenarioRoots: string[] = []
const scenarioLeases: JournalRecoveryLease[] = []
let buildRoot = ''
let hubctlEntry = ''

const fixtureHub = `
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { runHubPreflight } from './preflight.js'
import { verifyNormalJournalLineage } from './journalRecovery.js'
import { parseProfileGenerationEnvironment, SCHEMA_VERSION } from './restartHandshake.js'

const scenario = process.env.HUB_TEST_SCENARIO
const stateDir = process.env.HUB_TEST_STATE_DIR
const requestedPort = Number(process.env.HUB_PORT)
const publicPort = Number(process.env.HUB_FIXED_PORT)
const dataDir = process.env.HUB_DATA_DIR
if (!scenario || !stateDir || !dataDir || !Number.isInteger(requestedPort) || !Number.isInteger(publicPort)) {
  throw new Error('fixture hub is missing its scenario environment')
}

fs.mkdirSync(stateDir, { recursive: true })
const marker = (name) => path.join(stateDir, name)
const mark = (name) => fs.writeFileSync(marker(name), String(process.pid))
const has = (name) => fs.existsSync(marker(name))
const role = requestedPort === 0 ? 'green' : 'blue'
const profileAuthority = parseProfileGenerationEnvironment(process.env)
if (profileAuthority.active !== (role === 'blue')) {
  throw new Error('fixture hub received the wrong profile public-generation role')
}
let bootOrdinal = 0
if (role === 'blue') {
  const bootFile = marker('blue-boot-count')
  bootOrdinal = fs.existsSync(bootFile) ? Number(fs.readFileSync(bootFile, 'utf8')) + 1 : 1
  fs.writeFileSync(bootFile, String(bootOrdinal))
}
const firstBlue = role === 'blue' && bootOrdinal === 1
const freshRecoveryBlue = role === 'blue' && bootOrdinal > 1
const sockets = new Set()
const server = http.createServer((request, response) => {
  if (request.url === '/api/health') {
    if (freshRecoveryBlue && scenario === 'initial-positive-fresh-health-failure') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ boot: 'incomplete', restoredSessions: 0 }))
      return
    }
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
const preflightAttemptId = process.env.HUB_PREFLIGHT_ATTEMPT_ID
if (
  typeof preflightAttemptId !== 'string' ||
  !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(preflightAttemptId)
) {
  throw new Error('fixture hub is missing its preflight attempt binding')
}
let preflightLivenessSequence = 0
let preflightLivenessPhase = 'starting'
const sendPreflightLiveness = () =>
  send({
    type: 'preflight-liveness',
    attemptId: preflightAttemptId,
    phase: preflightLivenessPhase,
    sequence: preflightLivenessSequence++,
  })
const sendPreflightFailure = (failure) =>
  send({ type: 'preflight-failed', attemptId: preflightAttemptId, ...failure })
fs.appendFileSync(marker('preflight-attempt-ids'), preflightAttemptId + String.fromCharCode(10))
sendPreflightLiveness()
preflightLivenessPhase = 'integrity-check'
sendPreflightLiveness()
const preflightLivenessLease = setInterval(sendPreflightLiveness, 1_000)
preflightLivenessLease.unref?.()
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

if (
  (role === 'green' &&
    ['green-offline-refusal', 'green-positive-corruption', 'green-positive-no-snapshot', 'green-positive-lease-blocked'].includes(scenario)) ||
  (role === 'blue' && bootOrdinal === 2 && scenario === 'revive-positive-corruption')
) {
  const positive = scenario !== 'green-offline-refusal'
  sendPreflightFailure({
    code: positive ? 'database-corrupt' : 'database-validation-unavailable',
    message: positive ? 'fixture confirmed SQLite corruption' : 'fixture cannot conclusively validate the shared journal',
    recovery: positive ? 'run independently verified recovery' : 'keep the shared root offline',
    ...(positive ? { recoveryCause: 'sqlite-corruption' } : {}),
  })
  setTimeout(() => process.exit(78), 10)
  await new Promise(() => {})
}

if (firstBlue && scenario.startsWith('initial-positive-')) {
  sendPreflightFailure({
    code: 'database-corrupt',
    message: 'fixture confirmed initial SQLite corruption',
    recovery: 'run independently verified recovery',
    recoveryCause: 'sqlite-corruption',
  })
  setTimeout(() => process.exit(78), 10)
  await new Promise(() => {})
}

if (firstBlue && scenario === 'initial-lost-preflight-ipc') {
  setTimeout(() => process.exit(78), 10)
  await new Promise(() => {})
}

if (firstBlue && scenario === 'initial-malformed-preflight-ipc') {
  sendPreflightFailure({ code: 42, message: { unbounded: true } })
  setTimeout(() => process.exit(78), 10)
  await new Promise(() => {})
}

if (firstBlue && scenario === 'initial-wal-validation-unavailable') {
  const result = runHubPreflight({
    dataDir,
    journalPath: path.join(dataDir, 'hub.db'),
    schemaVersion: SCHEMA_VERSION,
  })
  if (result.ok || result.failure.recoveryCause !== undefined) {
    throw new Error('normal WAL preflight unexpectedly acquired recovery authority')
  }
  mark('initial-wal-normal-unavailable')
  sendPreflightFailure(result.failure)
  setTimeout(() => process.exit(78), 10)
  await new Promise(() => {})
}

if (
  role === 'blue' &&
  bootOrdinal > 1 &&
  [
    'green-positive-corruption',
    'initial-positive-corruption',
    'initial-positive-child-exit-uncertain',
    'initial-positive-port-release-failure',
    'initial-positive-lost-recovery-ack',
    'initial-positive-replacement-worker-death',
    'initial-positive-fresh-preflight-failure',
    'initial-positive-fresh-ready-failure',
    'initial-positive-fresh-health-failure',
    'initial-positive-fresh-backup-failure',
    'initial-lost-preflight-ipc',
    'initial-malformed-preflight-ipc',
    'initial-wal-validation-unavailable',
    'revive-positive-corruption',
  ].includes(scenario)
) {
  let result = runHubPreflight({
    dataDir,
    journalPath: path.join(dataDir, 'hub.db'),
    schemaVersion: SCHEMA_VERSION,
  })
  if (result.ok) {
    const lineage = verifyNormalJournalLineage({
      dataDir,
      journalPath: path.join(dataDir, 'hub.db'),
      maxSchemaVersion: SCHEMA_VERSION,
    })
    if (lineage) result = { ok: false, checks: result.checks, failure: lineage }
  }
  if (!result.ok) {
    sendPreflightFailure(result.failure)
    setTimeout(() => process.exit(78), 10)
    await new Promise(() => {})
  }
  mark('fresh-normal-preflight-passed')
  if (scenario === 'initial-positive-fresh-preflight-failure') {
    sendPreflightFailure({
      code: 'database-validation-unavailable',
      message: 'fixture rejected the fresh recovery child after its controlling preflight',
      recovery: 'keep the recovered root offline',
    })
    setTimeout(() => process.exit(78), 10)
    await new Promise(() => {})
  }
  if (scenario === 'initial-positive-fresh-ready-failure') {
    process.exit(52)
  }
}

await listen(requestedPort)
const address = server.address()
if (!address || typeof address === 'string') throw new Error('fixture listener did not bind')
preflightLivenessPhase = 'booting'
sendPreflightLiveness()
clearInterval(preflightLivenessLease)
send({
  type: 'ready',
  attemptId: preflightAttemptId,
  port: address.port,
  restored: 0,
  schemaVersion: 1,
})

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
      if (
        message.active &&
        freshRecoveryBlue &&
        scenario === 'initial-positive-fresh-backup-failure'
      ) {
        respondControl(message, {
          active: false,
          applied: false,
          error: 'fixture rejected fresh blue backup activation',
        })
      } else {
        respondControl(message)
      }
      if (message.active && firstBlue && !restartRequested) {
        if (scenario === 'revive-positive-corruption') {
          fs.writeFileSync(path.join(dataDir, 'hub.db'), Buffer.alloc(128 * 1024, 0x52))
          mark('blue-exit-started')
          process.exit(47)
          return
        }
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
    send({
      type: 'released',
      questionTurns: { settled: 0, outcomeUnknown: 0 },
      loginAttempts: { settled: 0, outcomeUnknown: 0 },
    })
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
      send({
        type: 'promoted',
        profilePublicEpoch: message.profilePublicEpoch,
      })
    }
    return
  }

  if (message?.type === 'restart-aborted') {
    console.log('[fixture] restart-aborted reached a surviving blue')
    if (!server.listening) await listen(publicPort)
    send({
      type: 'rollback-rebound',
      profilePublicEpoch: message.profilePublicEpoch,
    })
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
    'await Promise.all(victims.map((child) => waitForChildExit(child, 10_000)));',
    `if (process.env.HUB_TEST_SCENARIO === 'initial-positive-child-exit-uncertain') {
            throw new Error('fixture could not prove every implicated child exited');
        }
        await Promise.all(victims.map((child) => waitForChildExit(child, 10_000)));`,
    'recovery child-exit proof'
  )
  compiledHubctl = replaceExactly(
    compiledHubctl,
    'await waitForPortRelease(FIXED_PORT, 10_000);',
    `if (process.env.HUB_TEST_SCENARIO === 'initial-positive-port-release-failure') {
            throw new Error('fixture could not prove the public port was released');
        }
        await waitForPortRelease(FIXED_PORT, 10_000);`,
    'recovery public-port proof'
  )
  compiledHubctl = replaceExactly(
    compiledHubctl,
    `attemptId: recoveryAttemptId,
            onLiveness:`,
    `attemptId: recoveryAttemptId,
            ...(process.env.HUB_TEST_SCENARIO === 'initial-positive-wedged-recovery-worker'
                ? { timeoutMs: 200 }
                : {}),
            onLiveness:`,
    'wedged recovery worker deadline'
  )
  compiledHubctl = replaceExactly(
    compiledHubctl,
    `if (workerSocket) {
                freshWorker = spawnWorker() ?? null;
                if (!freshWorker ||`,
    `if (workerSocket) {
                freshWorker = spawnWorker() ?? null;
                if (process.env.HUB_TEST_SCENARIO === 'initial-positive-replacement-worker-death' && freshWorker) {
                    killTree(freshWorker);
                    await waitForChildExit(freshWorker, 10_000);
                }
                if (!freshWorker ||`,
    'fresh recovery worker death'
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
        const promotionEpoch = profilePublicEpochs.next();
        sendToHub(green.child, {
            type: 'promote',
            port: FIXED_PORT,
            profilePublicEpoch: promotionEpoch,
        }); // green: re-listen on 7777
        const promoted = await waitForHubMsg(green.child, 'promoted', Number(process.env.HUB_TEST_PROMOTE_ACK_TIMEOUT_MS ?? 8_000));`,
      `const promotionEpoch = profilePublicEpochs.next();
        sendToHub(green.child, {
            type: 'promote',
            port: FIXED_PORT,
            profilePublicEpoch: promotionEpoch,
        }); // MUTATION: fence moved after ACK
        const promoted = await waitForHubMsg(green.child, 'promoted', Number(process.env.HUB_TEST_PROMOTE_ACK_TIMEOUT_MS ?? 8_000));
        greenMayOwnPublicListener = true;`,
      'promotion fence mutation'
    )
  }
  fs.writeFileSync(hubctlEntry, compiledHubctl)
  const recoveryEntry = path.join(outDir, 'journalRecovery.js')
  let compiledRecovery = fs.readFileSync(recoveryEntry, 'utf8')
  compiledRecovery = replaceExactly(
    compiledRecovery,
    `const boot = bootstrapJournalRecovery({
            dataDir: recoveryWorkerRequest.dataDir,`,
    `if (process.env.HUB_TEST_SCENARIO === 'initial-positive-wedged-recovery-worker') {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        }
        const boot = bootstrapJournalRecovery({
            dataDir: recoveryWorkerRequest.dataDir,`,
    'wedged recovery worker'
  )
  compiledRecovery = replaceExactly(
    compiledRecovery,
    `operationId: recoveryWorkerRequest.operationId,
        });`,
    `operationId: recoveryWorkerRequest.operationId,
            failpoint: (edge) => {
                if (process.env.HUB_TEST_SCENARIO !== 'initial-positive-lost-recovery-ack' ||
                    edge !== 'after-plan-publication-before-classifier-cleanup')
                    return;
                const marker = path.join(recoveryWorkerRequest.dataDir, 'lost-recovery-ack-injected');
                if (fs.existsSync(marker))
                    return;
                fs.writeFileSync(marker, recoveryWorkerRequest.operationId);
                process.exit(91);
            },
        });`,
    'lost recovery worker acknowledgement'
  )
  fs.writeFileSync(recoveryEntry, compiledRecovery)
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

async function prepareRecoverableData(dataDir: string, corrupt = true): Promise<void> {
  fs.mkdirSync(dataDir, { recursive: true })
  const journal = new Journal(path.join(dataDir, 'hub.db'))
  journal.append('recovery-session', 'session/input', { text: 'survives-supervisor-recovery' })
  const snapshot = await snapshotJournal(journal.db, {
    dir: path.join(dataDir, 'backups'),
    recoveryDataDir: dataDir,
    recoveryKeep: 6,
    now: () => new Date('2026-07-29T00:00:00.000Z'),
  })
  expect(snapshot.ok).toBe(true)
  journal.db.close()
  if (corrupt) fs.writeFileSync(path.join(dataDir, 'hub.db'), Buffer.alloc(128 * 1024, 0x43))
}

async function prepareRecoverableWal(dataDir: string): Promise<void> {
  fs.mkdirSync(dataDir, { recursive: true })
  const journalPath = path.join(dataDir, 'hub.db')
  const journal = new Journal(journalPath)
  journal.append('recovery-session', 'session/input', { text: 'survives-supervisor-recovery' })
  const snapshot = await snapshotJournal(journal.db, {
    dir: path.join(dataDir, 'backups'),
    recoveryDataDir: dataDir,
    recoveryKeep: 6,
    now: () => new Date('2026-07-29T00:00:00.000Z'),
  })
  expect(snapshot.ok).toBe(true)
  journal.append('recovery-session', 'session/input', { text: 'corrupt-wal-tail' })
  const main = fs.readFileSync(journalPath)
  const wal = fs.readFileSync(`${journalPath}-wal`)
  const shm = fs.readFileSync(`${journalPath}-shm`)
  journal.db.close()
  wal[64] = wal[64] ^ 0xff
  fs.writeFileSync(journalPath, main)
  fs.writeFileSync(`${journalPath}-wal`, wal)
  fs.writeFileSync(`${journalPath}-shm`, shm)
}

function spawnScenarioSupervisor(env: NodeJS.ProcessEnv): OutputCapture {
  const child = spawn(process.execPath, [hubctlEntry], {
    cwd: hubRoot,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  supervisors.push(child)
  return new OutputCapture(child)
}

async function startScenario(
  scenario:
    | 'precommit-blue-death'
    | 'post-listener-blue-death-failure'
    | 'post-listener-blue-death-commit'
    | 'lost-promoted-ack'
    | 'green-offline-refusal'
    | 'green-positive-corruption'
    | 'green-positive-no-snapshot'
    | 'green-positive-lease-blocked'
    | 'initial-positive-corruption'
    | 'initial-positive-child-exit-uncertain'
    | 'initial-positive-port-release-failure'
    | 'initial-positive-lost-recovery-ack'
    | 'initial-positive-wedged-recovery-worker'
    | 'initial-positive-replacement-worker-death'
    | 'initial-positive-fresh-preflight-failure'
    | 'initial-positive-fresh-ready-failure'
    | 'initial-positive-fresh-health-failure'
    | 'initial-positive-fresh-backup-failure'
    | 'initial-lost-preflight-ipc'
    | 'initial-malformed-preflight-ipc'
    | 'initial-wal-validation-unavailable'
    | 'revive-positive-corruption'
): Promise<{
  capture: OutputCapture
  stateDir: string
  dataDir: string
  publicPort: number
  recoveryLease?: JournalRecoveryLease
  env: NodeJS.ProcessEnv
}> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-hubctl-backup-recovery-'))
  scenarioRoots.push(root)
  const stateDir = path.join(root, 'state')
  const dataDir = path.join(root, 'data')
  const publicPort = await reserveEphemeralPort()
  if (scenario === 'green-positive-no-snapshot') {
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(path.join(dataDir, 'hub.db'), Buffer.alloc(128 * 1024, 0x4e))
  } else if (scenario === 'initial-wal-validation-unavailable') {
    await prepareRecoverableWal(dataDir)
  } else if (
    [
      'green-positive-corruption',
      'green-positive-lease-blocked',
      'initial-positive-corruption',
      'initial-positive-child-exit-uncertain',
      'initial-positive-port-release-failure',
      'initial-positive-lost-recovery-ack',
      'initial-positive-wedged-recovery-worker',
      'initial-positive-replacement-worker-death',
      'initial-positive-fresh-preflight-failure',
      'initial-positive-fresh-ready-failure',
      'initial-positive-fresh-health-failure',
      'initial-positive-fresh-backup-failure',
      'initial-lost-preflight-ipc',
      'initial-malformed-preflight-ipc',
      'initial-wal-validation-unavailable',
    ].includes(scenario)
  ) {
    await prepareRecoverableData(dataDir)
  } else if (scenario === 'revive-positive-corruption') {
    await prepareRecoverableData(dataDir, false)
  }
  let recoveryLease: JournalRecoveryLease | undefined
  if (scenario === 'green-positive-lease-blocked') {
    recoveryLease = new JournalRecoveryLease(dataDir)
    recoveryLease.acquireShared()
    scenarioLeases.push(recoveryLease)
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HUB_FIXED_PORT: String(publicPort),
    HUB_DATA_DIR: dataDir,
    HUB_TEST_SCENARIO: scenario,
    HUB_TEST_STATE_DIR: stateDir,
  }
  if (scenario === 'lost-promoted-ack') {
    env.HUB_TEST_PROMOTE_ACK_TIMEOUT_MS = '100'
    env.HUB_TEST_HOLD_GREEN_KILL = '1'
  }
  if (scenario === 'initial-positive-replacement-worker-death') env.HUB_WORKER = '1'
  delete env.HUBCTL_DEV
  if (scenario !== 'initial-positive-replacement-worker-death') {
    delete env.HUB_WORKER
    delete env.HUB_WORKER_SOCKET
  }
  const capture = spawnScenarioSupervisor(env)
  if (
    ![
      'initial-positive-corruption',
      'initial-positive-child-exit-uncertain',
      'initial-positive-port-release-failure',
      'initial-positive-lost-recovery-ack',
      'initial-positive-wedged-recovery-worker',
      'initial-positive-replacement-worker-death',
      'initial-positive-fresh-preflight-failure',
      'initial-positive-fresh-ready-failure',
      'initial-positive-fresh-health-failure',
      'initial-positive-fresh-backup-failure',
      'initial-lost-preflight-ipc',
      'initial-malformed-preflight-ipc',
      'initial-wal-validation-unavailable',
    ].includes(scenario)
  ) {
    await capture.waitFor(/hub \(blue\) live on/)
  }
  return { capture, stateDir, dataDir, publicPort, recoveryLease, env }
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

function expectFreshPreflightAttempts(stateDir: string, minimum: number): void {
  const attempts = fs
    .readFileSync(path.join(stateDir, 'preflight-attempt-ids'), 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
  expect(attempts.length).toBeGreaterThanOrEqual(minimum)
  expect(
    attempts.every((attempt) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        attempt
      )
    )
  ).toBe(true)
  expect(new Set(attempts).size).toBe(attempts.length)
}

beforeAll(async () => {
  await compileHubFixture()
}, 30_000)

afterEach(async () => {
  await Promise.all(supervisors.splice(0).map(stopSupervisor))
  for (const lease of scenarioLeases.splice(0)) lease.release()
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
    const { capture, stateDir } = await startScenario('lost-promoted-ack')

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
    expectFreshPreflightAttempts(stateDir, 2)

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

  it('poisons an uncertain green root without rollback, relaunch, or a retry hot-loop', async () => {
    const { capture, stateDir } = await startScenario('green-offline-refusal')

    await capture.waitFor(/journal recovery poison latched/)
    await capture.waitFor(/journal recovery remains visibly OFFLINE/)
    await new Promise<void>((resolve) => setTimeout(resolve, 250))

    expect(capture.child.exitCode).toBeNull()
    expect(capture.child.signalCode).toBeNull()
    expect(capture.text).not.toContain('restart-aborted reached a surviving blue')
    expect(capture.text).not.toContain('blue journal backups resumed after rollback')
    expect(capture.text).not.toContain('hub recovered on')
    expect(capture.count('journal recovery poison latched')).toBe(1)
    expect(fs.readFileSync(path.join(stateDir, 'blue-boot-count'), 'utf8')).toBe('1')
  }, 15_000)

  it('recovers a typed positive green refusal without rolling blue back', async () => {
    const { capture, stateDir, dataDir } = await startScenario('green-positive-corruption')

    await capture.waitFor(/recovery operation .* restored generation 1/)
    await capture.waitFor(/recovery reboot committed on/)

    expect(capture.text).not.toContain('restart-aborted reached a surviving blue')
    expect(capture.text).not.toContain('blue journal backups resumed after rollback')
    expect(fs.readFileSync(path.join(stateDir, 'blue-boot-count'), 'utf8')).toBe('2')
    expect(fs.existsSync(path.join(stateDir, 'fresh-normal-preflight-passed'))).toBe(true)
    expectFreshPreflightAttempts(stateDir, 3)
    expect(capture.text).toMatch(/preflight phase: starting/)
    expect(capture.text).toMatch(/preflight phase: integrity-check/)
    expect(capture.text).toMatch(/preflight phase: booting/)
    const restored = new Journal(path.join(dataDir, 'hub.db'))
    expect(
      restored
        .since(0)
        .some(
          (event) =>
            (event.payload as { text?: unknown } | null)?.text ===
            'survives-supervisor-recovery'
        )
    ).toBe(true)
    restored.db.close()
  }, 30_000)

  it.each([
    'initial-positive-corruption',
    'initial-lost-preflight-ipc',
    'initial-malformed-preflight-ipc',
    'initial-wal-validation-unavailable',
  ] as const)('recovers %s only after independent copied-family classification', async (scenario) => {
    const { capture, stateDir, dataDir } = await startScenario(scenario)

    await capture.waitFor(/recovery operation .* restored generation 1/)
    await capture.waitFor(/recovery reboot committed on/)

    expect(capture.text).not.toContain('restart-aborted reached a surviving blue')
    expect(capture.text).not.toContain('blue journal backups resumed after rollback')
    expect(fs.readFileSync(path.join(stateDir, 'blue-boot-count'), 'utf8')).toBe('2')
    expect(fs.existsSync(path.join(stateDir, 'fresh-normal-preflight-passed'))).toBe(true)
    expectFreshPreflightAttempts(stateDir, 2)
    if (scenario === 'initial-wal-validation-unavailable') {
      expect(fs.existsSync(path.join(stateDir, 'initial-wal-normal-unavailable'))).toBe(true)
    }
    const restored = new Journal(path.join(dataDir, 'hub.db'))
    expect(restored.since(0)).toHaveLength(1)
    restored.db.close()
  }, 30_000)

  it('recovers a positive refusal encountered by the revival path with a fresh blue generation', async () => {
    const { capture, stateDir } = await startScenario('revive-positive-corruption')

    await capture.waitFor(/live hub is down .* respawning/)
    await capture.waitFor(/recovery operation .* restored generation 1/)
    await capture.waitFor(/recovery reboot committed on/)

    expect(capture.text).not.toContain('restart-aborted reached a surviving blue')
    expect(capture.text).not.toContain('blue journal backups resumed after rollback')
    expect(fs.readFileSync(path.join(stateDir, 'blue-boot-count'), 'utf8')).toBe('3')
    expect(fs.existsSync(path.join(stateDir, 'fresh-normal-preflight-passed'))).toBe(true)
    expectFreshPreflightAttempts(stateDir, 3)
  }, 30_000)

  it('keeps a no-snapshot positive incident byte-identical and persistently offline', async () => {
    const { capture, dataDir, stateDir } = await startScenario('green-positive-no-snapshot')
    const journalPath = path.join(dataDir, 'hub.db')
    const before = fs.readFileSync(journalPath)

    await capture.waitFor(/journal recovery remains visibly OFFLINE/)
    await new Promise<void>((resolve) => setTimeout(resolve, 250))

    expect(capture.child.exitCode).toBeNull()
    expect(fs.readFileSync(journalPath)).toEqual(before)
    expect(fs.readFileSync(path.join(stateDir, 'blue-boot-count'), 'utf8')).toBe('1')
    expect(capture.count('journal recovery poison latched')).toBe(1)
  }, 30_000)

  it('keeps the root offline and untouched when exclusive recovery ownership is blocked', async () => {
    const { capture, dataDir, stateDir } = await startScenario('green-positive-lease-blocked')
    const journalPath = path.join(dataDir, 'hub.db')
    const before = fs.readFileSync(journalPath)

    await capture.waitFor(/exclusive recovery ownership is blocked|journal recovery remains visibly OFFLINE/)
    await capture.waitFor(/journal recovery remains visibly OFFLINE/)

    expect(fs.readFileSync(journalPath)).toEqual(before)
    expect(fs.readFileSync(path.join(stateDir, 'blue-boot-count'), 'utf8')).toBe('1')
    expect(capture.text).not.toContain('restart-aborted reached a surviving blue')
  }, 30_000)

  it.each([
    [
      'initial-positive-child-exit-uncertain',
      /could not prove every implicated child exited/,
    ],
    [
      'initial-positive-port-release-failure',
      /could not prove the public port was released/,
    ],
  ] as const)(
    'keeps %s byte-identical and offline before recovery mutation',
    async (scenario, expectedFailure) => {
      const { capture, dataDir } = await startScenario(scenario)
      const journalPath = path.join(dataDir, 'hub.db')
      const before = fs.readFileSync(journalPath)

      await capture.waitFor(expectedFailure)
      await capture.waitFor(/journal recovery remains visibly OFFLINE/)
      await new Promise<void>((resolve) => setTimeout(resolve, 100))

      expect(capture.child.exitCode).toBeNull()
      expect(fs.readFileSync(journalPath)).toEqual(before)
      expect(capture.text).not.toContain('recovery operation ')
      expect(capture.text).not.toContain('recovery reboot committed')
    },
    30_000
  )

  it('keeps a wedged independent recovery worker bounded, responsive, and offline', async () => {
    const { capture, dataDir } = await startScenario(
      'initial-positive-wedged-recovery-worker'
    )
    const journalPath = path.join(dataDir, 'hub.db')
    const before = fs.readFileSync(journalPath)

    await capture.waitFor(/journal recovery worker exceeded its absolute execution ceiling/)
    await capture.waitFor(/journal recovery remains visibly OFFLINE/)

    expect(capture.child.exitCode).toBeNull()
    expect(fs.readFileSync(journalPath)).toEqual(before)
    expect(capture.text).not.toContain('recovery reboot committed')
    expect(fs.existsSync(path.join(dataDir, 'journal-recovery', 'active-plan.json'))).toBe(false)
  }, 30_000)

  it('reconciles a lost recovery completion with the same durable operation exactly once', async () => {
    const { capture, dataDir, env } = await startScenario(
      'initial-positive-lost-recovery-ack'
    )
    await capture.waitFor(/journal recovery worker exited without an acknowledged result/)
    await capture.waitFor(/journal recovery remains visibly OFFLINE/)
    expect(capture.child.exitCode).toBeNull()

    const operationId = fs
      .readFileSync(path.join(dataDir, 'lost-recovery-ack-injected'), 'utf8')
      .trim()
    const recoveryDir = path.join(dataDir, 'journal-recovery')
    const receiptDir = path.join(recoveryDir, 'receipts')
    const stagingDir = path.join(dataDir, 'journal-recovery', 'staging')
    expect(fs.readdirSync(receiptDir)).toEqual([])
    expect(fs.readdirSync(stagingDir)).toContain(`.classifier-${operationId}`)
    expect(
      JSON.parse(fs.readFileSync(path.join(recoveryDir, 'active-plan.json'), 'utf8'))
    ).toMatchObject({ id: operationId })

    capture.child.kill()
    if (capture.child.exitCode === null && capture.child.signalCode === null) {
      await once(capture.child, 'exit')
    }
    const replacement = spawnScenarioSupervisor(env)
    await replacement.waitFor(/recovery reboot committed on/)

    expect(fs.readdirSync(receiptDir).filter((entry) => entry.endsWith('.json'))).toEqual([
      `${operationId}.json`,
    ])
    expect(fs.readdirSync(stagingDir)).not.toContain(`.classifier-${operationId}`)
    expect(replacement.text).not.toContain('blue journal backups resumed after rollback')
    expect(replacement.count('recovery reboot committed on')).toBe(1)
  }, 30_000)

  it.each([
    [
      'initial-positive-replacement-worker-death',
      /fresh worker generation did not remain alive|fresh worker generation died/,
    ],
    [
      'initial-positive-fresh-preflight-failure',
      /fixture rejected the fresh recovery child after its controlling preflight/,
    ],
    ['initial-positive-fresh-ready-failure', /hub exited while waiting for 'ready'/],
    ['initial-positive-fresh-health-failure', /health: boot=incomplete/],
    [
      'initial-positive-fresh-backup-failure',
      /fixture rejected fresh blue backup activation/,
    ],
  ] as const)(
    'keeps the recovered root offline when %s occurs before the commit gate',
    async (scenario, expectedFailure) => {
      const { capture } = await startScenario(scenario)

      await capture.waitFor(expectedFailure)
      await capture.waitFor(/journal recovery remains visibly OFFLINE/)
      await new Promise<void>((resolve) => setTimeout(resolve, 100))

      expect(capture.child.exitCode).toBeNull()
      expect(capture.child.signalCode).toBeNull()
      expect(capture.text).not.toContain('recovery reboot committed on')
      expect(capture.text).not.toContain('blue journal backups resumed after rollback')
    },
    30_000
  )
})

// One-machine proof for peer journal snapshot replication.
//
// This starts three real, isolated hubs, kills a transfer process after its first fsynced chunk, rejects a
// truncated offer, performs a protected assignment handoff, destroys the source data directory, restores it
// from the surviving peer, and boots the restored hub. It proves the local storage/transfer invariants; it
// does NOT pretend loopback is a real network or prove discovery/auth/reachability between physical PCs.
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(fileURLToPath(import.meta.url), '..', '..')
const HUB = path.join(REPO, 'apps', 'hub')
const SANDBOX = path.join(REPO, 'scripts', 'sandbox.mjs')
const CLI = path.join(HUB, 'src', 'journalReplicationCli.ts')
const ROOT = path.join(REPO, '.sandbox-journal-replication')
const NODES = [
  // Keep 7788 free for scripts/sandbox.mjs and sandbox-adversarial.mjs; this proof is safe to run beside it.
  { name: 'source-a', port: 7791 },
  { name: 'peer-b', port: 7792 },
  { name: 'peer-c', port: 7793 },
].map((node) => ({
  ...node,
  root: path.join(ROOT, node.name),
  data: path.join(ROOT, node.name, 'data'),
}))
const [source, peerB, peerC] = NODES

function fail(message) {
  throw new Error(message)
}

function assertHarnessPath(target) {
  const resolvedRoot = path.resolve(ROOT)
  const resolved = path.resolve(target)
  const relative = path.relative(resolvedRoot, resolved)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    fail(`refusing destructive harness operation outside a child of ${resolvedRoot}: ${resolved}`)
  }
}

function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra }
  delete env.HUB_DATA_DIR
  delete env.HUB_PROFILES_DIR
  delete env.HUB_PORT
  delete env.HUB_FIXED_PORT
  delete env.HUB_WORKER_SOCKET
  delete env.HUB_SUPERVISED
  return env
}

function sandbox(node, command) {
  if (node.port === 7777) fail('the replication harness must never use the live hub port 7777')
  assertHarnessPath(node.root)
  const result = spawnSync(process.execPath, [SANDBOX, command, '--isolated-profiles'], {
    cwd: REPO,
    env: cleanEnv({ SANDBOX_DIR: node.root, SANDBOX_PORT: String(node.port) }),
    encoding: 'utf8',
    timeout: 60_000,
  })
  if (result.status !== 0) {
    fail(
      `sandbox ${node.name} ${command} failed (${result.status}):\n${result.stdout ?? ''}\n${result.stderr ?? ''}`
    )
  }
  return result.stdout.trim()
}

function cli(args, { expectFailure = false } = {}) {
  const result = spawnSync(process.execPath, ['--import', 'tsx/esm', CLI, ...args], {
    cwd: HUB,
    env: cleanEnv(),
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024,
  })
  if (expectFailure) {
    if (result.status === 0) fail(`replication CLI unexpectedly succeeded: ${args.join(' ')}`)
    return { stderr: result.stderr.trim(), lines: [] }
  }
  if (result.status !== 0) {
    fail(`replication CLI failed (${result.status}): ${args.join(' ')}\n${result.stderr}`)
  }
  const lines = result.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  return { lines, last: lines.at(-1) }
}

function requestOnce(node, method, pathname, body) {
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
    const req = http.request(
      {
        host: '127.0.0.1',
        port: node.port,
        method,
        path: pathname,
        timeout: 5_000,
        headers: encoded
          ? { 'content-type': 'application/json', 'content-length': String(encoded.length) }
          : undefined,
      },
      (res) => {
        let raw = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => (raw += chunk))
        res.on('end', () => {
          let json
          try {
            json = raw ? JSON.parse(raw) : undefined
          } catch {
            reject(new Error(`${method} ${pathname} returned non-JSON: ${raw.slice(0, 500)}`))
            return
          }
          if ((res.statusCode ?? 500) >= 400) {
            reject(new Error(`${method} ${pathname} returned ${res.statusCode}: ${raw}`))
            return
          }
          resolve(json)
        })
      }
    )
    req.on('timeout', () => req.destroy(new Error(`${method} ${pathname} timed out`)))
    req.on('error', reject)
    if (encoded) req.write(encoded)
    req.end()
  })
}

async function request(node, method, pathname, body) {
  const attempts = method === 'GET' ? 3 : 1
  let lastError
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await requestOnce(node, method, pathname, body)
    } catch (error) {
      lastError = error
      if (!/ECONNRESET|ECONNREFUSED|socket hang up/i.test(error instanceof Error ? error.message : String(error))) {
        throw error
      }
      // A just-booted supervisor can replace its health-checked blue between two loopback GETs. Retrying a
      // read is safe; POSTs deliberately remain single-shot so the harness never hides a duplicate mutation.
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)))
    }
  }
  throw lastError
}

function portAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

async function killTransferAfterFirstChunk(sourceGenerationDir, targetDataDir) {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx/esm', CLI, 'transfer', sourceGenerationDir, targetDataDir, '250'],
    { cwd: HUB, env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
  )
  let stdout = ''
  let stderr = ''
  let killedAt
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => (stderr += chunk))
  child.stdout.on('data', (chunk) => {
    stdout += chunk
    for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
      try {
        const message = JSON.parse(line)
        if (!killedAt && message.type === 'chunk-durable') {
          killedAt = message.nextChunk
          child.kill('SIGKILL')
        }
      } catch {
        /* an incomplete final stdout line is retried on the next data event */
      }
    }
  })
  const exit = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`transfer did not reach a durable chunk in time\n${stderr}`))
    }, 30_000)
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal })
    })
  })
  if (!killedAt) fail(`transfer exited before a durable chunk (${JSON.stringify(exit)}): ${stderr}`)
  if (exit.code === 0) fail('interrupted transfer reported success')
  return killedAt
}

async function main() {
  if (path.resolve(ROOT) === path.resolve(REPO) || !path.resolve(ROOT).startsWith(`${path.resolve(REPO)}${path.sep}`)) {
    fail(`unsafe harness root: ${ROOT}`)
  }
  for (const node of NODES) sandbox(node, 'reset')
  for (const node of NODES) {
    if (!(await portAvailable(node.port))) {
      fail(`sandbox port ${node.port} is already occupied; stop that disposable service and retry`)
    }
  }

  const pass = []
  try {
    for (const node of NODES) sandbox(node, 'up')
    await request(source, 'POST', '/api/config/danger', { autoApproveRestart: true })
    await request(peerB, 'POST', '/api/config/danger', { busCanUseRiskyTools: true })
    const sourceBefore = await request(source, 'GET', '/api/events?since=0')
    const peerBefore = await request(peerB, 'GET', '/api/events?since=0')
    if (!sourceBefore.some((event) => event.payload?.autoApproveRestart === true)) fail('source marker was not journaled')
    if (!peerBefore.some((event) => event.payload?.busCanUseRiskyTools === true)) fail('peer marker was not journaled')
    if (sourceBefore.some((event) => event.payload?.busCanUseRiskyTools === true)) fail('source and peer journals overlapped')

    const peerBId = cli(['node-id', peerB.data]).last.nodeId
    const peerCId = cli(['node-id', peerC.data]).last.nodeId
    const sourceDb = path.join(source.data, 'hub.db')
    cli(['configure', sourceDb, '1', JSON.stringify([peerBId])])
    const snapshot = cli(['snapshot', source.data, '4096']).last
    const { manifest, generationDir: sourceGenerationDir } = snapshot

    const corruptOffer = path.join(ROOT, 'corrupt-offer')
    assertHarnessPath(corruptOffer)
    fs.cpSync(sourceGenerationDir, corruptOffer, { recursive: true })
    fs.truncateSync(path.join(corruptOffer, 'snapshot.db'), manifest.databaseBytes - 17)
    const rejected = cli(['transfer', corruptOffer, peerB.data], { expectFailure: true })
    if (!/truncat|size|hash|corrupt|integrity/i.test(rejected.stderr)) {
      fail(`corrupt offer failed for an unexpected reason: ${rejected.stderr}`)
    }
    const peerAfterRejection = await request(peerB, 'GET', '/api/events?since=0')
    if (!peerAfterRejection.some((event) => event.payload?.busCanUseRiskyTools === true)) {
      fail('corrupt replica attempt altered the peer active journal')
    }
    pass.push('corruption rejection: truncated offer refused before certification or active-journal merge')

    const durableChunks = await killTransferAfterFirstChunk(sourceGenerationDir, peerB.data)
    const resumed = cli(['transfer', sourceGenerationDir, peerB.data]).lines.find(
      (line) => line.type === 'transfer-complete'
    )
    if (!resumed?.complete || resumed.chunksReused < durableChunks) {
      fail(`resume did not reuse its durable watermark: ${JSON.stringify(resumed)}`)
    }
    cli(['ack', sourceDb, peerB.data, manifest.generationId])
    const gate = cli(['protect', sourceDb]).last.gate
    if (!gate.coverageSatisfied || gate.maxPrunableSeq !== manifest.maxSeq) {
      fail(`verified snapshot did not authorize its exact seq watermark: ${JSON.stringify(gate)}`)
    }
    pass.push(
      `interrupted/resumed transfer: killed after chunk ${durableChunks}, resumed with ${resumed.chunksReused} chunk(s) reused`
    )

    const unsafeRemoval = cli(
      ['configure', sourceDb, '1', JSON.stringify([peerCId])],
      { expectFailure: true }
    )
    if (!/protected|handoff|verified/i.test(unsafeRemoval.stderr)) {
      fail(`unsafe assignment change failed for an unexpected reason: ${unsafeRemoval.stderr}`)
    }
    cli(['configure', sourceDb, '1', JSON.stringify([peerBId, peerCId])])
    const peerBGeneration = path.join(
      peerB.data,
      'journal-replication',
      'replicas',
      manifest.sourceJournalId,
      manifest.generationId
    )
    cli(['transfer', peerBGeneration, peerC.data])
    cli(['ack', sourceDb, peerC.data, manifest.generationId])
    cli(['configure', sourceDb, '1', JSON.stringify([peerCId])])
    const status = cli(['status', sourceDb]).last
    if (
      status.assignedPeerIds.length !== 1 ||
      status.assignedPeerIds[0] !== peerCId ||
      !status.protectedGenerationIds.includes(manifest.generationId)
    ) {
      fail(`assignment handoff status is wrong: ${JSON.stringify(status)}`)
    }
    pass.push('assignment change: departing sole holder refused until the protected generation reached peer C')

    const peerActive = await request(peerB, 'GET', '/api/events?since=0')
    if (
      !peerActive.some((event) => event.payload?.busCanUseRiskyTools === true) ||
      peerActive.some((event) => event.payload?.autoApproveRestart === true)
    ) {
      fail('replication merged source rows into peer B active journal')
    }
    pass.push('two isolated hubs: source rows replicated to a separate snapshot; peer B active rows stayed independent')

    sandbox(peerB, 'down')
    assertHarnessPath(peerBGeneration)
    fs.rmSync(peerBGeneration, { recursive: true, force: true })
    sandbox(source, 'down')
    assertHarnessPath(source.data)
    fs.rmSync(source.data, { recursive: true, force: true })
    if (fs.existsSync(source.data)) fail('source data directory was not actually removed')

    const peerCGeneration = path.join(
      peerC.data,
      'journal-replication',
      'replicas',
      manifest.sourceJournalId,
      manifest.generationId
    )
    cli(['restore', peerCGeneration, source.data])
    sandbox(source, 'up')
    const health = await request(source, 'GET', '/api/health')
    if (health.boot !== 'complete') fail(`restored source did not complete boot: ${JSON.stringify(health)}`)
    const restored = await request(source, 'GET', '/api/events?since=0')
    if (!restored.some((event) => event.payload?.autoApproveRestart === true)) {
      fail('restored hub is missing the source journal marker')
    }
    if (restored.some((event) => event.payload?.busCanUseRiskyTools === true)) {
      fail('restored source contains peer B active-journal rows')
    }
    const restoredSnapshotRows = restored.filter((event) => event.seq <= manifest.maxSeq)
    if (restoredSnapshotRows.length !== manifest.rowCount) {
      fail(
        `restored snapshot row count ${restoredSnapshotRows.length} does not match verified snapshot ` +
          `${manifest.rowCount} (hub appended ${restored.length - restoredSnapshotRows.length} new boot row(s))`
      )
    }
    pass.push('complete scratch restore: deleted source data rebuilt from peer C and booted with exact verified rows')

    for (const line of pass) console.log(`PASS ${line}`)
    console.log(
      'PROVEN LOCALLY: isolated journals, process-kill resume, corruption rejection, protected handoff, scratch restore + real hub boot.'
    )
    console.log(
      'NOT PROVEN: physical-network discovery/auth/reachability, behavior during a real disk/power failure, or a second-machine restore.'
    )
  } finally {
    for (const node of NODES.slice().reverse()) {
      try {
        sandbox(node, 'down')
      } catch (error) {
        console.error(`cleanup warning for ${node.name}: ${error.message}`)
      }
    }
  }
}

await main()

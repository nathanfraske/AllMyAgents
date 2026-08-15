import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DurableRunController,
  DurableRunStore,
  captureRunProvenance,
  type DurableRunStartInput,
} from './durableRuns.js'

const opened: Database.Database[] = []
const temporary: string[] = []
const controllers: DurableRunController[] = []

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.shutdown()
  for (const db of opened.splice(0)) db.close()
  for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-durable-runs-'))
  temporary.push(dir)
  return dir
}

function harness(): { db: Database.Database; store: DurableRunStore; cwd: string } {
  const cwd = tempDir()
  const db = new Database(':memory:')
  opened.push(db)
  return { db, store: new DurableRunStore(db), cwd }
}

function input(cwd: string, suffix = ''): DurableRunStartInput {
  return {
    projectId: 'project-1',
    sessionId: `manager${suffix}`,
    actorSessionId: `manager${suffix}`,
    actorLabel: 'Manager',
    targetSessionId: `manager${suffix}`,
    kind: 'test',
    executable: process.execPath,
    args: ['-e', 'console.log("durable output")'],
    cwd,
    resources: ['project:project-1:checkout:primary'],
    timeoutMs: 10_000,
  }
}

async function waitForTerminal(store: DurableRunStore, id: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const state = store.get(id)?.state
    if (state && !['queued', 'running'].includes(state)) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('run did not become terminal')
}

describe('DurableRunStore', () => {
  it('serializes conflicting resources and releases the lease only at a terminal boundary', async () => {
    const { store, cwd } = harness()
    const firstInput = input(cwd, '-1')
    const secondInput = input(cwd, '-2')
    const first = store.create(firstInput, await captureRunProvenance(firstInput))
    const second = store.create(secondInput, await captureRunProvenance(secondInput))

    expect(store.tryClaim(first.id)).toBe(true)
    expect(store.tryClaim(second.id)).toBe(false)
    expect(store.finish(first.id, { state: 'succeeded', exitCode: 0 })?.state).toBe('succeeded')
    expect(store.tryClaim(second.id)).toBe(true)
  })

  it('claims disjoint device roots concurrently so a manager can partition remote work', async () => {
    const { store, cwd } = harness()
    const firstInput = {
      ...input(cwd, '-1'),
      resources: ['project:project-1:remote:site-a:root-a'],
    }
    const secondInput = {
      ...input(cwd, '-2'),
      resources: ['project:project-1:remote:site-b:root-b'],
    }
    const first = store.create(firstInput, await captureRunProvenance(firstInput))
    const second = store.create(secondInput, await captureRunProvenance(secondInput))

    expect(store.tryClaim(first.id)).toBe(true)
    expect(store.tryClaim(second.id)).toBe(true)
    expect(store.get(first.id)?.state).toBe('running')
    expect(store.get(second.id)?.state).toBe('running')
  })

  it('makes an interrupted outcome explicit and safely releases abandoned claims', async () => {
    const { store, cwd } = harness()
    const firstInput = input(cwd, '-1')
    const secondInput = input(cwd, '-2')
    const first = store.create(firstInput, await captureRunProvenance(firstInput))
    const second = store.create(secondInput, await captureRunProvenance(secondInput))
    expect(store.tryClaim(first.id)).toBe(true)

    expect(store.reconcileInterrupted()).toEqual([
      expect.objectContaining({ id: first.id, state: 'outcome_unknown' }),
    ])
    expect(store.tryClaim(second.id)).toBe(true)
    expect(store.get(first.id)).toMatchObject({
      state: 'outcome_unknown',
      error: expect.stringMatching(/outcome was observed/i),
    })
  })
})

describe('DurableRunController', () => {
  it('returns a durable handle immediately and retains exact terminal state plus cursor-paged logs', async () => {
    const { db, store, cwd } = harness()
    const events: Array<{ sessionId: string | null; kind: string; payload: unknown }> = []
    const controller = new DurableRunController(
      store,
      {
        db,
        append: (sessionId, kind, payload) => events.push({ sessionId, kind, payload }),
      },
      path.join(tempDir(), 'logs'),
    )
    controllers.push(controller)
    controller.activate()

    const run = await controller.start(input(cwd))
    expect(['running', 'succeeded']).toContain(run.state)
    await waitForTerminal(store, run.id)

    const inspected = controller.inspect({ projectId: 'project-1', runId: run.id })
    expect(inspected.runs[0]).toMatchObject({ state: 'succeeded', exitCode: 0 })
    expect(inspected.logs).toMatchObject({
      stdout: expect.stringContaining('durable output'),
      stdoutComplete: true,
      stderrComplete: true,
    })
    expect(events.map((event) => event.kind)).toEqual(
      expect.arrayContaining(['run/queued', 'run/started', 'run/succeeded']),
    )
  })

  it('uses the same leased run handle for a remote target and retains transfer telemetry', async () => {
    const { db, store, cwd } = harness()
    const controller = new DurableRunController(
      store,
      { db, append: () => undefined },
      path.join(tempDir(), 'logs'),
    )
    controllers.push(controller)
    controller.setRemoteExecutor(async () => ({
      ok: true,
      stdout: 'remote build complete\n',
      stderr: '',
      exitCode: 0,
      telemetry: { routeMs: 3, networkMs: 7, targetMs: 31, roundTripMs: 44, transferBytes: 128 },
    }))
    controller.activate()
    const remoteInput: DurableRunStartInput = {
      ...input(cwd),
      executable: '(remote shell)',
      args: [],
      resources: ['project:project-1:remote:site-a:root-a'],
      executionTarget: {
        kind: 'remote',
        siteId: 'site-a',
        rootId: 'root-a',
        command: 'npm test',
        cwd: 'checkout-a',
      },
      executionEnvironment: {
        platform: 'linux',
        architecture: 'riscv64',
        cwd: '/home/runner/checkout-a',
        environmentId: 'host',
        observedAt: '2026-08-15T00:00:00.000Z',
        fingerprintSha256: 'a'.repeat(64),
        hostname: 'Frask-Risk-Box',
        shell: '/bin/sh',
        cpuCount: 8,
        totalMemoryBytes: 15 * 1024 * 1024 * 1024,
        transport: 'myownmesh-rpc',
        nodeKind: 'lightweight-testbed',
        buildId: 'payload-1',
      },
    }

    const run = await controller.start(remoteInput)
    await waitForTerminal(store, run.id)
    const inspected = controller.inspect({ projectId: 'project-1', runId: run.id })
    expect(inspected.runs[0]).toMatchObject({
      state: 'succeeded',
      commandSummary: 'npm test',
      executionTarget: { kind: 'remote', siteId: 'site-a', rootId: 'root-a' },
      result: { telemetry: { roundTripMs: 44, transferBytes: 128 } },
      provenance: {
        platform: 'linux',
        architecture: 'riscv64',
        cwd: '/home/runner/checkout-a',
        environmentScope: 'execution',
        environmentSha256: 'a'.repeat(64),
        execution: {
          environmentId: 'host',
          hostname: 'Frask-Risk-Box',
          transport: 'myownmesh-rpc',
        },
        source: {
          platform: process.platform,
          architecture: process.arch,
          cwd,
        },
      },
    })
    expect(inspected.logs?.stdout).toContain('remote build complete')
  })
})

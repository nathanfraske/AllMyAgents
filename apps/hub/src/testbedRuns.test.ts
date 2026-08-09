import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { TestbedRunStore } from './testbedRuns.js'

describe('TestbedRunStore', () => {
  it('durably attributes a remote execution and records its terminal telemetry', () => {
    const db = new Database(':memory:')
    const runs = new TestbedRunStore(db)
    const started = runs.start({
      projectId: 'project-1',
      replicaId: 'replica-remote',
      sessionId: 'session-1',
      agentId: 'agent-1',
      profileId: 'codex-a',
      command: '  pnpm   test  ',
      baseCommit: 'abc123',
    })

    expect(started).toMatchObject({
      projectId: 'project-1',
      replicaId: 'replica-remote',
      agentId: 'agent-1',
      state: 'running',
      commandSummary: 'pnpm test',
      baseCommit: 'abc123',
    })
    expect(started.commandSha256).toHaveLength(64)

    const finished = runs.finish(started.id, {
      ok: true,
      exitCode: 0,
      telemetry: { roundTripMs: 123.4, targetMs: 100 },
    })
    expect(finished).toMatchObject({
      id: started.id,
      state: 'succeeded',
      exitCode: 0,
      telemetry: { roundTripMs: 123.4, targetMs: 100 },
    })
    expect(runs.listProject('project-1')).toEqual([finished])
  })

  it('records typed transport failures without losing the run identity', () => {
    const db = new Database(':memory:')
    const runs = new TestbedRunStore(db)
    const started = runs.start({
      projectId: 'project-1',
      replicaId: 'replica-remote',
      sessionId: 'session-1',
      agentId: 'agent-1',
      profileId: 'claude-a',
      command: 'make test',
    })

    expect(runs.finish(started.id, {
      ok: false,
      error: 'route unavailable',
      failure: { stage: 'route' },
    })).toMatchObject({
      state: 'failed',
      failureStage: 'route',
      error: 'route unavailable',
    })
  })

  it('marks source-restart outcomes unknown instead of leaving them running forever', () => {
    const db = new Database(':memory:')
    const runs = new TestbedRunStore(db)
    const started = runs.start({
      projectId: 'project-1',
      replicaId: 'replica-remote',
      sessionId: 'session-1',
      agentId: 'agent-1',
      profileId: 'codex-a',
      command: 'pnpm test',
    })

    expect(runs.reconcileInterrupted()).toEqual([
      expect.objectContaining({
        id: started.id,
        state: 'cancelled',
        failureStage: 'source-restart',
        error: expect.stringContaining('outcome was observed'),
      }),
    ])
    expect(runs.reconcileInterrupted()).toEqual([])
  })
})

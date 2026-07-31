import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentBus } from './bus.js'
import type { Executor } from './executor.js'
import { InstructionStore } from './instructions.js'
import { Journal } from './journal.js'
import { MemoryStore } from './memory.js'
import { PracticeStore } from './practices.js'
import { ProjectStore } from './projects.js'
import { SessionManager } from './sessions.js'
import { SessionStore } from './store.js'
import type { LiveSession } from './workerProtocol.js'
import { ApprovalService } from './approvals.js'
import { UsageMonitor } from './usage.js'
import { WorkspaceManager } from './workspace.js'
import { QuestionService } from './questions.js'

const cleanups: Array<() => void> = []

afterEach(async () => {
  await new Promise<void>((resolve) => setImmediate(resolve))
  while (cleanups.length) cleanups.pop()?.()
})

describe('completion during a hub gap', () => {
  it('requests buffered output even when the surviving worker now reports the turn idle', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-gap-complete-'))
    const journal = new Journal(path.join(tmp, 'hub.db'))
    const store = new SessionStore(journal.db)
    const sessionId = 'finished-during-gap'
    const live: LiveSession[] = [{ sessionId, status: 'idle', lastWseq: 5 }]
    const attachCalls: Array<Record<string, number>> = []
    let sessions!: SessionManager
    const executor: Executor = {
      startThread: async () => 'unused',
      runTurn: async () => {},
      steer: async () => {},
      interrupt: async () => {},
      stopSession: async () => {},
      readCodexLimits: async () => ({}),
      listLive: async () => live,
      attach: async (since) => {
        attachCalls.push(since)
        // Model the socket race this path must tolerate: the same gap event arrives once through replay
        // and once live. The hub's never-decreasing wseq guard must journal it exactly once.
        sessions.ingestWorkerEvent(sessionId, 4, 'claude/assistant', { message: 'completed in gap' })
        sessions.ingestWorkerEvent(sessionId, 4, 'claude/assistant', { message: 'completed in gap' })
      },
      isBusy: () => false,
    }
    sessions = new SessionManager(
      journal,
      store,
      new Map([['claude-test', { id: 'claude-test', provider: 'claude' as const, dir: tmp }]]),
      new ApprovalService(journal),
      new UsageMonitor(journal, [], {}),
      new WorkspaceManager(path.join(tmp, 'worktrees')),
      new ProjectStore(journal.db),
      new InstructionStore(journal.db),
      new AgentBus(journal.db),
      new MemoryStore(journal.db),
      new PracticeStore(journal.db),
      { busCanUseRiskyTools: false, autoApprovePractices: false },
      false,
      tmp,
      new QuestionService(journal),
      executor
    )
    store.upsert({
      id: sessionId,
      profileId: 'claude-test',
      provider: 'claude',
      cwd: tmp,
      status: 'active',
      createdAt: new Date().toISOString(),
    })
    sessions.loadRecords()
    sessions.ingestWorkerEvent(sessionId, 3, 'claude/assistant', { message: 'already durable' })
    cleanups.push(() => {
      journal.db.close()
      fs.rmSync(tmp, { recursive: true, force: true })
    })

    await sessions.attachWorker()

    expect(attachCalls).toEqual([{ [sessionId]: 3 }])
    expect(
      [...journal.replay(0)].filter((event) =>
        event.sessionId === sessionId &&
        event.kind === 'claude/assistant' &&
        (event.payload as { message?: string }).message === 'completed in gap'
      )
    ).toHaveLength(1)
    expect(sessions.list().find((s) => s.id === sessionId)?.status).toBe('idle')
  })
})

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentBus } from './bus.js'
import type { Executor } from './executor.js'
import { InstructionStore } from './instructions.js'
import { Journal } from './journal.js'
import { MemoryStore } from './memory.js'
import { PracticeStore } from './practices.js'
import { ProjectStore } from './projects.js'
import { SessionManager } from './sessions.js'
import { SessionStore } from './store.js'
import { ApprovalService } from './approvals.js'
import { UsageMonitor } from './usage.js'
import { WorkspaceManager } from './workspace.js'
import type { WorkerSessionSpec } from './workerProtocol.js'

const cleanups: Array<() => void> = []

afterEach(async () => {
  await new Promise<void>((resolve) => setImmediate(resolve))
  vi.restoreAllMocks()
  while (cleanups.length) cleanups.pop()?.()
})

describe('per-project executable-config trust seam', () => {
  it('copies only the ProjectStore decision into every worker session spec', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-project-trust-'))
    const journal = new Journal(path.join(tmp, 'hub.db'))
    const projects = new ProjectStore(journal.db)
    const trusted = projects.create('trusted', tmp)
    const untrustedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-project-untrusted-'))
    const untrusted = projects.create('untrusted', untrustedDir)
    const isConfigTrusted = vi.fn((projectId: string) => projectId === trusted.id)
    ;(projects as ProjectStore & { isConfigTrusted(projectId: string): boolean }).isConfigTrusted = isConfigTrusted
    const specs: WorkerSessionSpec[] = []
    const executor: Executor = {
      startThread: async () => 'unused',
      runTurn: async (spec) => {
        specs.push(spec)
      },
      steer: async () => {},
      interrupt: async () => {},
      stopSession: async () => {},
      readCodexLimits: async () => ({}),
      listLive: async () => [],
      attach: async () => {},
      isBusy: () => false,
    }
    const sessions = new SessionManager(
      journal,
      new SessionStore(journal.db),
      new Map([['claude-test', { id: 'claude-test', provider: 'claude' as const, dir: tmp }]]),
      new ApprovalService(journal),
      new UsageMonitor(journal, [], {}),
      new WorkspaceManager(path.join(tmp, 'worktrees')),
      projects,
      new InstructionStore(journal.db),
      new AgentBus(journal.db),
      new MemoryStore(journal.db),
      new PracticeStore(journal.db),
      { busCanUseRiskyTools: false, autoApprovePractices: false },
      false,
      tmp,
      executor
    )
    cleanups.push(() => {
      journal.db.close()
      fs.rmSync(tmp, { recursive: true, force: true })
      fs.rmSync(untrustedDir, { recursive: true, force: true })
    })

    await sessions.create('claude-test', {
      projectId: trusted.id,
      cwd: trusted.path,
      prompt: 'trusted turn',
      useWorktree: false,
    })
    await sessions.create('claude-test', {
      projectId: untrusted.id,
      cwd: untrusted.path,
      prompt: 'untrusted turn',
      useWorktree: false,
    })

    expect(isConfigTrusted).toHaveBeenCalledWith(trusted.id)
    expect(isConfigTrusted).toHaveBeenCalledWith(untrusted.id)
    expect(specs.map((spec) => spec.trustProjectConfig)).toEqual([true, false])
  })
})

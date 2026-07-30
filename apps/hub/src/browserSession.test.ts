import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ApprovalService } from './approvals.js'
import { AgentBus } from './bus.js'
import { InstructionStore } from './instructions.js'
import { Journal } from './journal.js'
import { MemoryStore } from './memory.js'
import { PracticeStore } from './practices.js'
import { ProjectStore } from './projects.js'
import { SessionManager } from './sessions.js'
import { SessionStore } from './store.js'
import type { SessionRecord } from './types.js'
import { UsageMonitor } from './usage.js'
import { WorkspaceManager } from './workspace.js'
import { QuestionService } from './questions.js'

const SAFE = { busCanUseRiskyTools: false, autoApprovePractices: false }

describe('SessionManager browser turn provenance', () => {
  let tmp = ''
  let journal: Journal | undefined

  afterEach(() => {
    journal?.db.close()
    journal = undefined
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('a teammate-message turn cannot browse even when the operator enabled the chat', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-browser-gate-'))
    journal = new Journal(path.join(tmp, 'hub.db'))
    const store = new SessionStore(journal.db)
    const record: SessionRecord = {
      id: 'session-a',
      profileId: 'claude-a',
      provider: 'claude',
      cwd: tmp,
      status: 'active',
      browserEnabled: true,
      createdAt: new Date().toISOString(),
    }
    store.upsert(record)
    const manager = new SessionManager(
      journal,
      store,
      new Map(),
      new ApprovalService(journal),
      new UsageMonitor(journal, [], {}),
      new WorkspaceManager(path.join(tmp, 'worktrees')),
      new ProjectStore(journal.db),
      new InstructionStore(journal.db),
      new AgentBus(journal.db),
      new MemoryStore(journal.db),
      new PracticeStore(journal.db),
      SAFE,
      false,
      tmp,
      new QuestionService(journal),
    )
    manager.loadRecords()
    const provenance = manager as unknown as {
      busTurnSessions: Set<string>
      operatorTurnSessions: Set<string>
    }
    provenance.busTurnSessions.add(record.id)
    provenance.operatorTurnSessions.add(record.id)

    await expect(manager.browserExecute(record.id, 'navigate', { url: 'https://example.com' }))
      .resolves.toEqual([{
        type: 'text',
        text: 'Browser access is not available during a teammate-message turn.',
      }])
  })

  it('an enabled operator turn reports the missing desktop before requesting an origin approval', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-browser-headless-'))
    journal = new Journal(path.join(tmp, 'hub.db'))
    const store = new SessionStore(journal.db)
    const record: SessionRecord = {
      id: 'session-headless',
      profileId: 'claude-a',
      provider: 'claude',
      cwd: tmp,
      status: 'active',
      browserEnabled: true,
      createdAt: new Date().toISOString(),
    }
    store.upsert(record)
    const approvals = new ApprovalService(journal)
    const manager = new SessionManager(
      journal,
      store,
      new Map(),
      approvals,
      new UsageMonitor(journal, [], {}),
      new WorkspaceManager(path.join(tmp, 'worktrees')),
      new ProjectStore(journal.db),
      new InstructionStore(journal.db),
      new AgentBus(journal.db),
      new MemoryStore(journal.db),
      new PracticeStore(journal.db),
      SAFE,
      false,
      tmp,
      new QuestionService(journal),
    )
    manager.loadRecords()
    const provenance = manager as unknown as { operatorTurnSessions: Set<string> }
    provenance.operatorTurnSessions.add(record.id)

    await expect(manager.browserExecute(record.id, 'navigate', { url: 'https://example.com' }))
      .resolves.toEqual([{
        type: 'text',
        text: 'Browser unavailable: this hub was started without an authenticated desktop browser broker.',
      }])
    expect(approvals.pending()).toHaveLength(0)
  })
})

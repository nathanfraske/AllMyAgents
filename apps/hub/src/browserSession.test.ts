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
import { BrowserBroker } from './browserBroker.js'
import { BROWSER_PROTOCOL_VERSION, type BrowserCommand } from './browserProtocol.js'

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

  it('uses one host-described approval then imports and reads a download only in its owning session', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-browser-download-'))
    journal = new Journal(path.join(tmp, 'hub.db'))
    const store = new SessionStore(journal.db)
    const owner: SessionRecord = {
      id: 'session-owner',
      profileId: 'claude-a',
      provider: 'claude',
      cwd: tmp,
      status: 'active',
      browserEnabled: true,
      browserDownloadsEnabled: true,
      browserOriginGrants: ['https://example.com'],
      createdAt: new Date().toISOString(),
    }
    const other: SessionRecord = {
      ...owner,
      id: 'session-other',
    }
    store.upsert(owner)
    store.upsert(other)
    const commands: BrowserCommand[] = []
    const hello = {
      protocolVersion: BROWSER_PROTOCOL_VERSION,
      desktopInstanceId: 'desktop-browser-test',
    }
    const broker = new BrowserBroker({
      transport: {
        hello: async () => hello,
        nextEvent: async (signal) =>
          await new Promise((_, reject) =>
            signal.addEventListener('abort', () => reject(new Error('stopped')))),
        command: async (command) => {
          commands.push(command)
          return {
            hello,
            result: command.operation === 'download_prepare'
              ? {
                  id: command.id,
                  protocolVersion: BROWSER_PROTOCOL_VERSION,
                  ok: true,
                  data: {
                    token: 'action_0123456789abcdef',
                    origin: 'https://example.com',
                    destinationOrigin: 'https://example.com',
                    pageGeneration: 'page_0123456789abcdef',
                    page: 'https://example.com/files',
                    descriptor: {
                      kind: 'link',
                      name: 'notes',
                      href: 'https://example.com/notes.txt',
                    },
                  },
                }
              : {
                  id: command.id,
                  protocolVersion: BROWSER_PROTOCOL_VERSION,
                  ok: true,
                  content: [],
                  data: {
                    name: 'notes.txt',
                    mime: 'text/plain',
                    origin: 'https://example.com',
                    bytesBase64: Buffer.from('bounded browser download').toString('base64'),
                  },
                },
          }
        },
      },
    })
    await broker.refresh()
    const approvals = new ApprovalService(journal)
    const approvalRequests: { kind: string; payload: unknown }[] = []
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
      undefined,
      undefined,
      broker,
    )
    approvals.setPendingListener((approval) => {
      approvalRequests.push({ kind: approval.kind, payload: approval.payload })
      approvals.resolve(approval.id, true)
    })
    manager.loadRecords()
    const provenance = manager as unknown as { operatorTurnSessions: Set<string> }
    provenance.operatorTurnSessions.add(owner.id)
    provenance.operatorTurnSessions.add(other.id)

    const downloaded = await manager.browserExecute(owner.id, 'download', {
      ref: 'el_0123456789abcdef',
      pageGeneration: 'page_0123456789abcdef',
      targetSummary: 'Download notes',
    })
    const parsed = JSON.parse(downloaded[0]?.type === 'text' ? downloaded[0].text : '{}') as {
      attachmentId: string
    }
    expect(commands.map((command) => command.operation)).toEqual([
      'download_prepare',
      'download_commit',
    ])
    expect(approvalRequests).toEqual([{
      kind: 'browser/download',
      payload: expect.objectContaining({
        origin: 'https://example.com',
        target: { kind: 'link', name: 'notes', href: 'https://example.com/notes.txt' },
      }),
    }])
    await expect(manager.browserExecute(owner.id, 'download_read', {
      attachmentId: parsed.attachmentId,
    })).resolves.toEqual([{
      type: 'text',
      text: expect.stringContaining('bounded browser download'),
    }])
    await expect(manager.browserExecute(other.id, 'download_read', {
      attachmentId: parsed.attachmentId,
    })).resolves.toEqual([{
      type: 'text',
      text: 'Download read refused: this attachment is unknown or belongs to another chat.',
    }])
  })

  it('combines new destination-origin grants with exact click and tab approvals', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-browser-combined-approval-'))
    journal = new Journal(path.join(tmp, 'hub.db'))
    const store = new SessionStore(journal.db)
    const record: SessionRecord = {
      id: 'session-combined',
      profileId: 'claude-a',
      provider: 'claude',
      cwd: tmp,
      status: 'active',
      browserEnabled: true,
      browserTabsEnabled: true,
      browserDownloadsEnabled: true,
      browserOriginGrants: ['https://93.184.216.34'],
      createdAt: new Date().toISOString(),
    }
    store.upsert(record)
    const commands: BrowserCommand[] = []
    const hello = {
      protocolVersion: BROWSER_PROTOCOL_VERSION,
      desktopInstanceId: 'desktop-combined-test',
    }
    const broker = new BrowserBroker({
      transport: {
        hello: async () => hello,
        nextEvent: async (signal) =>
          await new Promise((_, reject) =>
            signal.addEventListener('abort', () => reject(new Error('stopped')))),
        command: async (command) => {
          commands.push(command)
          const href =
            command.operation === 'tab_open_prepare'
              ? String(command.arguments.url)
              : command.operation === 'download_prepare'
                ? command.arguments.ref === 'el_download_approve'
                  ? 'https://4.4.4.4/file.txt'
                  : 'https://6.6.6.6/denied.txt'
              : command.arguments.ref === 'el_same_0123456789'
                ? 'https://93.184.216.34/same'
                : command.arguments.ref === 'el_cross_01234567'
                  ? 'https://1.1.1.1/cross'
                  : 'https://8.8.8.8/denied'
          const destinationOrigin = new URL(href).origin
          return {
            hello,
            result:
              command.operation === 'click_prepare' || command.operation === 'tab_open_prepare'
                || command.operation === 'download_prepare'
                ? {
                    id: command.id,
                    protocolVersion: BROWSER_PROTOCOL_VERSION,
                    ok: true,
                    data: {
                      token: `action_${commands.length.toString().padStart(16, '0')}`,
                      origin: 'https://93.184.216.34',
                      destinationOrigin,
                      pageGeneration: 'page_0123456789abcdef',
                      page: 'https://93.184.216.34/page',
                      descriptor: {
                        kind: command.operation === 'tab_open_prepare' ? 'new-tab' : 'link',
                        name: String(command.arguments.targetSummary ?? 'link'),
                        href,
                      },
                    },
                  }
                : command.operation === 'download_commit'
                  ? {
                      id: command.id,
                      protocolVersion: BROWSER_PROTOCOL_VERSION,
                      ok: true,
                      content: [],
                      data: {
                        name: 'file.txt',
                        mime: 'text/plain',
                        origin: 'https://4.4.4.4',
                        bytesBase64: Buffer.from('cross-origin download').toString('base64'),
                      },
                    }
                : {
                    id: command.id,
                    protocolVersion: BROWSER_PROTOCOL_VERSION,
                    ok: true,
                    content: [{ type: 'text', text: 'committed' }],
                  },
          }
        },
      },
    })
    await broker.refresh()
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
      undefined,
      undefined,
      broker,
    )
    manager.loadRecords()
    const prompts: { kind: string; payload: unknown }[] = []
    approvals.setPendingListener((approval) => {
      prompts.push({ kind: approval.kind, payload: approval.payload })
      approvals.resolve(approval.id, prompts.length !== 3 && prompts.length !== 6)
    })
    ;(manager as unknown as { operatorTurnSessions: Set<string> })
      .operatorTurnSessions.add(record.id)

    await manager.browserExecute(record.id, 'click', {
      ref: 'el_same_0123456789',
      pageGeneration: 'page_0123456789abcdef',
      targetSummary: 'Same origin',
    })
    await manager.browserExecute(record.id, 'click', {
      ref: 'el_cross_01234567',
      pageGeneration: 'page_0123456789abcdef',
      targetSummary: 'Cross origin',
    })
    const grantsAfterApproved = manager.browserStatus(record.id).publicOriginGrants
    expect(grantsAfterApproved).toContain('https://1.1.1.1')

    await manager.browserExecute(record.id, 'click', {
      ref: 'el_denied_0123456',
      pageGeneration: 'page_0123456789abcdef',
      targetSummary: 'Denied origin',
    })
    expect(manager.browserStatus(record.id).publicOriginGrants).not.toContain('https://8.8.8.8')

    await manager.browserExecute(record.id, 'tab_open', {
      url: 'https://9.9.9.9/new',
      targetSummary: 'Approved tab',
    })
    expect(manager.browserStatus(record.id).publicOriginGrants).toContain('https://9.9.9.9')

    await manager.browserExecute(record.id, 'download', {
      ref: 'el_download_approve',
      pageGeneration: 'page_0123456789abcdef',
      targetSummary: 'Approved CDN download',
    })
    expect(manager.browserStatus(record.id).publicOriginGrants).toContain('https://4.4.4.4')

    await manager.browserExecute(record.id, 'download', {
      ref: 'el_download_denied',
      pageGeneration: 'page_0123456789abcdef',
      targetSummary: 'Denied CDN download',
    })
    expect(manager.browserStatus(record.id).publicOriginGrants).not.toContain('https://6.6.6.6')
    expect(prompts.map((prompt) => prompt.kind)).toEqual([
      'browser/action',
      'browser/action',
      'browser/action',
      'browser/tab-open',
      'browser/download',
      'browser/download',
    ])
    expect(prompts).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ grantsDestinationOrigin: null }),
      }),
      expect.objectContaining({
        payload: expect.objectContaining({ grantsDestinationOrigin: 'https://1.1.1.1' }),
      }),
      expect.objectContaining({
        payload: expect.objectContaining({ grantsDestinationOrigin: 'https://8.8.8.8' }),
      }),
      expect.objectContaining({
        payload: expect.objectContaining({ grantsDestinationOrigin: 'https://9.9.9.9' }),
      }),
      expect.objectContaining({
        payload: expect.objectContaining({ grantsDestinationOrigin: 'https://4.4.4.4' }),
      }),
      expect.objectContaining({
        payload: expect.objectContaining({ grantsDestinationOrigin: 'https://6.6.6.6' }),
      }),
    ])
    expect(commands.filter((command) => command.operation.endsWith('_commit'))).toHaveLength(4)
    const crossCommit = commands.find((command) =>
      command.operation === 'click_commit' &&
      Array.isArray(command.arguments.allowedOrigins) &&
      command.arguments.allowedOrigins.includes('https://1.1.1.1'))
    expect(crossCommit).toBeTruthy()
    const downloadCommit = commands.find((command) =>
      command.operation === 'download_commit' &&
      Array.isArray(command.arguments.allowedOrigins) &&
      command.arguments.allowedOrigins.includes('https://4.4.4.4'))
    expect(downloadCommit).toBeTruthy()
  })
})

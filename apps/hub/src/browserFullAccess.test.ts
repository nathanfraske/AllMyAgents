import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
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

const cleanups: (() => void)[] = []
afterEach(() => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0)) cleanup() })

function fixture(mode: 'safe' | 'edits' | 'full' = 'full') {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-browser-full-'))
  const journal = new Journal(path.join(tmp, 'hub.db'))
  const store = new SessionStore(journal.db)
  store.upsert({
    id: 'browser-owner', profileId: 'p1', provider: 'claude', cwd: tmp, status: 'active',
    permissionMode: mode, browserEnabled: true, browserTabsEnabled: true,
    browserDownloadsEnabled: true, createdAt: new Date().toISOString(),
  })
  const commands: BrowserCommand[] = []
  const hello = { protocolVersion: BROWSER_PROTOCOL_VERSION, desktopInstanceId: 'full-access-test' }
  let prepareHook = () => {}
  let rejectCommit = false
  const broker = new BrowserBroker({ transport: {
    hello: async () => hello,
    nextEvent: async (signal) => await new Promise((_, reject) =>
      signal.addEventListener('abort', () => reject(new Error('stopped')))),
    command: async (command) => {
      commands.push(command)
      const href = command.operation === 'tab_open_prepare' ? String(command.arguments.url)
        : command.operation === 'download_prepare' ? 'https://1.1.1.1/notes.txt' : undefined
      const base = { id: command.id, protocolVersion: BROWSER_PROTOCOL_VERSION, ok: true }
      if (command.operation.endsWith('_prepare')) {
        prepareHook()
        return { hello, result: { ...base, data: {
          token: `action_${commands.length.toString().padStart(16, '0')}`,
          origin: 'https://1.1.1.1', page: 'https://1.1.1.1/page',
          pageGeneration: 'page_0123456789abcdef',
          ...(href ? { destinationOrigin: new URL(href).origin } : {}),
          descriptor: { kind: href ? 'link' : 'button', name: 'Next page', ...(href ? { href } : {}) },
        } } }
      }
      if (rejectCommit && command.operation.endsWith('_commit')) throw new Error('Page changed; expired native token')
      return { hello, result: { ...base, content: [{ type: 'text' as const, text: 'performed' }],
        ...(command.operation === 'download_commit' ? { data: {
          name: 'notes.txt', mime: 'text/plain', origin: 'https://1.1.1.1',
          bytesBase64: Buffer.from('fixture download').toString('base64'),
        } } : {}),
      } }
    },
  } })
  const approvals = new ApprovalService(journal)
  const sessions = new SessionManager(journal, store, new Map(), approvals,
    new UsageMonitor(journal, [], {}), new WorkspaceManager(path.join(tmp, 'worktrees')),
    new ProjectStore(journal.db), new InstructionStore(journal.db), new AgentBus(journal.db),
    new MemoryStore(journal.db), new PracticeStore(journal.db),
    { busCanUseRiskyTools: false, autoApprovePractices: false, fullAccessAnyOrigin: true },
    false, tmp, new QuestionService(journal), undefined, undefined, broker)
  sessions.loadRecords()
  const state = sessions as unknown as {
    sessions: Map<string, SessionRecord>; operatorTurnSessions: Set<string>; busTurnSessions: Set<string>
  }
  state.operatorTurnSessions.add('browser-owner')
  const record = state.sessions.get('browser-owner')!
  approvals.setAutoApprove((...args) => sessions.isAutoApproved(...args))
  const prompts: string[] = []
  approvals.setPendingListener((request) => { prompts.push(request.kind); approvals.resolve(request.id, false) })
  cleanups.push(() => { journal.db.close(); fs.rmSync(tmp, { recursive: true, force: true }) })
  return { sessions, record, state, commands, approvals, prompts, journal,
    prepareHook: (fn: () => void) => { prepareHook = fn },
    rejectCommit: () => { rejectCommit = true },
    click: () => sessions.browserExecute(record.id, 'click', {
      ref: 'el_0123456789abcdef', pageGeneration: 'page_0123456789abcdef', targetSummary: 'Next page',
    }),
  }
}

describe('Browser Full Access', () => {
  it('performs repeated native clicks with no operator prompt and audits every decision', async () => {
    const h = fixture()
    expect(await h.click()).toEqual([{ type: 'text', text: 'performed' }])
    expect(await h.click()).toEqual([{ type: 'text', text: 'performed' }])
    expect(h.prompts).toEqual([])
    expect(h.commands.map(c => c.operation)).toEqual(['click_prepare', 'click_commit', 'click_prepare', 'click_commit'])
    const rows = h.journal.db.prepare('SELECT kind, decider FROM approval_decisions').all()
    expect(rows).toEqual(Array(2).fill({ kind: 'browser/action', decider: 'policy:auto-approve' }))
  })

  it('covers public navigation, tab creation and inert downloads without repeated prompts', async () => {
    const h = fixture()
    await h.sessions.browserExecute(h.record.id, 'navigate', { url: 'https://1.1.1.1' })
    await h.sessions.browserExecute(h.record.id, 'tab_open', { url: 'https://8.8.8.8', targetSummary: 'New tab' })
    const result = await h.sessions.browserExecute(h.record.id, 'download', {
      ref: 'el_0123456789abcdef', pageGeneration: 'page_0123456789abcdef', targetSummary: 'Notes',
    })
    expect(result[0].type === 'text' && JSON.parse(result[0].text).attachmentId).toBeTruthy()
    expect(h.prompts).toEqual([])
    expect(h.commands.map(c => c.operation)).toContain('tab_open_commit')
    expect(h.sessions.browserStatus(h.record.id).publicOriginGrants).toEqual(['https://1.1.1.1', 'https://8.8.8.8'])
  })

  it.each(['safe', 'edits'] as const)('%s retains the exact-target prompt', async (mode) => {
    const h = fixture(mode)
    await h.click()
    expect(h.prompts).toEqual(['browser/action'])
    expect(h.commands.map(c => c.operation)).toEqual(['click_prepare'])
  })

  it.each(['disabled', 'unknown', 'bus', 'ambiguous'] as const)('does not bypass %s browser authority, even with any-origin danger flag', async (origin) => {
    const h = fixture()
    if (origin === 'disabled') h.record.browserEnabled = false
    if (origin === 'unknown' || origin === 'bus') h.state.operatorTurnSessions.clear()
    if (origin === 'bus' || origin === 'ambiguous') h.state.busTurnSessions.add(h.record.id)
    expect(h.sessions.isAutoApproved(h.record.id, 'browser/action', {})).toBe(false)
    await h.click()
    expect(h.commands).toEqual([])
    expect(h.prompts).toEqual([])
  })

  it('does not carry another chat’s grant, widen a manager ceiling, or allow unknown browser kinds', () => {
    const h = fixture()
    expect(h.sessions.isAutoApproved('other-chat', 'browser/action', {})).toBe(false)
    expect(h.sessions.isAutoApproved(h.record.id, 'browser/unknown', {})).toBe(false)
    expect(h.sessions.isAutoApproved(h.record.id, 'browser/action', { matchedAskRule: 'ask' })).toBe(false)
    h.record.managerRootSessionId = 'manager'
    h.state.sessions.set('manager', { ...h.record, id: 'manager', isProjectManager: true, managerMaxChildPermissionMode: 'edits' })
    expect(h.sessions.isAutoApproved(h.record.id, 'browser/action', {})).toBe(false)
  })

  it('keeps local-network, tabs, and downloads as separate grants', async () => {
    const h = fixture()
    h.record.browserTabsEnabled = false
    h.record.browserDownloadsEnabled = false
    for (const kind of ['browser/tab-open', 'browser/download']) {
      expect(h.sessions.isAutoApproved(h.record.id, kind, {})).toBe(false)
    }
    const local = await h.sessions.browserExecute(h.record.id, 'navigate', { url: 'http://127.0.0.1:5286' })
    expect(local).toEqual([{ type: 'text', text: expect.stringContaining('Local network & dev servers is off') }])
    await h.sessions.browserExecute(h.record.id, 'download', {})
    await h.sessions.browserExecute(h.record.id, 'tab_open', { url: 'https://1.1.1.1', targetSummary: 'New tab' })
    expect(h.commands).toEqual([])
    expect(h.prompts).toEqual([])
  })

  it('rechecks a Full Access downgrade before committing the prepared token', async () => {
    const h = fixture()
    const request = h.approvals.request.bind(h.approvals)
    vi.spyOn(h.approvals, 'request').mockImplementation((...args) => {
      const result = request(...args)
      h.record.permissionMode = 'safe'
      return result
    })
    expect(await h.click()).toEqual([{ type: 'text', text: expect.stringContaining('Full Access was revoked') }])
    expect(h.commands.map(c => c.operation)).toEqual(['click_prepare'])
  })

  it('rechecks browser revocation after native preparation', async () => {
    const h = fixture()
    h.prepareHook(() => { h.record.browserEnabled = false })
    await h.click()
    expect(h.commands.map(c => c.operation)).toEqual(['click_prepare'])
  })

  it.each(['tab_open', 'download'] as const)('rechecks the separate %s grant after prepare without prompting', async (operation) => {
    const h = fixture()
    h.prepareHook(() => {
      h.record.browserTabsEnabled = false
      h.record.browserDownloadsEnabled = false
    })
    await h.sessions.browserExecute(h.record.id, operation, {
      url: 'https://1.1.1.1', ref: 'el_0123456789abcdef',
      pageGeneration: 'page_0123456789abcdef', targetSummary: 'Fixture action',
    })
    expect(h.commands.map(c => c.operation)).toEqual([`${operation}_prepare`])
    expect(h.prompts).toEqual([])
  })

  it('does not bypass native token expiry or retry a failed commit', async () => {
    const h = fixture()
    h.rejectCommit()
    expect(await h.click()).toEqual([{ type: 'text', text: expect.stringContaining('expired native token') }])
    expect(h.commands.map(c => c.operation)).toEqual(['click_prepare', 'click_commit'])
  })
})

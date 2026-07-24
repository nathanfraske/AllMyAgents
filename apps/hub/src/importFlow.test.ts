import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Journal } from './journal.js'
import { SessionStore } from './store.js'
import { ProjectStore } from './projects.js'
import { ApprovalService } from './approvals.js'
import { UsageMonitor } from './usage.js'
import { WorkspaceManager } from './workspace.js'
import { InstructionStore } from './instructions.js'
import { AgentBus } from './bus.js'
import { MemoryStore } from './memory.js'
import { SessionManager } from './sessions.js'
import { encodeClaudeCwd } from './importScan.js'
import type { HubEvent, Profile } from './types.js'

// End-to-end integration of the import path against real hub plumbing (Journal + SessionStore +
// ProjectStore + SessionManager) on temp resources — no vendor processes, no network. Verifies the
// part that makes imports appear: adopt → persist → journal session/created + session/titled, plus
// dedupe. (Actually RESUMING an adopted vendor session still needs a live run — see the report.)
describe('SessionManager.importChats (integration)', () => {
  let tmp: string
  let target: string
  let sessions: SessionManager
  let store: SessionStore
  let journal: Journal
  let projectId: string
  const events: HubEvent[] = []

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-flow-'))
    target = path.join(tmp, 'MyApp')
    fs.mkdirSync(target, { recursive: true }) // ProjectStore.create requires the folder to exist

    // Fixture Claude profile with one real transcript whose cwd is the target folder.
    const claudeDir = path.join(tmp, 'profiles', 'claude-a')
    const projDir = path.join(claudeDir, 'projects', encodeClaudeCwd(target))
    fs.mkdirSync(projDir, { recursive: true })
    fs.writeFileSync(
      path.join(projDir, '11111111-1111-1111-1111-111111111111.jsonl'),
      [
        JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'Refactor the auth module' }] }, cwd: target, sessionId: '11111111-1111-1111-1111-111111111111' }),
        JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-4-8', content: [{ type: 'text', text: 'ok' }] }, sessionId: '11111111-1111-1111-1111-111111111111' }),
      ].join('\n')
    )

    const profiles: Profile[] = [{ id: 'claude-a', provider: 'claude', dir: claudeDir }]
    const profileMap = new Map(profiles.map((p) => [p.id, p]))

    journal = new Journal(path.join(tmp, 'hub.db'))
    store = new SessionStore(journal.db)
    const projects = new ProjectStore(journal.db)
    const approvals = new ApprovalService(journal)
    const usage = new UsageMonitor(journal, profiles, {})
    const workspace = new WorkspaceManager(path.join(tmp, 'data', 'worktrees'))
    const instructions = new InstructionStore(journal.db)
    const bus = new AgentBus(journal.db)
    const memory = new MemoryStore(journal.db)
    sessions = new SessionManager(journal, store, profileMap, approvals, usage, workspace, projects, instructions, bus, memory, tmp)

    projectId = projects.create('MyApp', target).id
    journal.on('event', (e) => events.push(e))
  })

  afterAll(() => {
    journal.db.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('previews the folder and finds the importable chat', async () => {
    const scan = await sessions.scanForImport(target)
    expect(scan.chats.map((c) => c.vendorSessionId)).toEqual(['11111111-1111-1111-1111-111111111111'])
    expect(scan.chats[0]!.alreadyImported).toBe(false)
    expect(scan.byProfile).toEqual({ 'claude-a': 1 })
  })

  it('adopts the selected chat: persisted record + journal events, filed under the project', async () => {
    const res = await sessions.importChats(projectId, target, ['11111111-1111-1111-1111-111111111111'])
    expect(res.imported).toHaveLength(1)
    expect(res.skipped).toBe(0)
    const rec = res.imported[0]!
    expect(rec.provider).toBe('claude')
    expect(rec.profileId).toBe('claude-a')
    expect(rec.vendorSessionId).toBe('11111111-1111-1111-1111-111111111111') // the resume id
    expect(rec.cwd).toBe(target) // resumes in place — no worktree
    expect(rec.worktree).toBeUndefined()
    expect(rec.projectId).toBe(projectId)
    expect(rec.status).toBe('idle')
    expect(rec.imported).toBe(true)
    expect(rec.title).toBe('Refactor the auth module') // deriveTitle(firstUserMessage)
    expect(rec.model).toBe('claude-opus-4-8')

    // In the live roster + persisted snapshot (so boot() restores it after a hub restart).
    expect(sessions.list().some((s) => s.id === rec.id)).toBe(true)
    expect(store.all().some((s) => s.id === rec.id)).toBe(true)

    // Journaled over the same path the web roster replays: created then titled.
    const kinds = events.filter((e) => e.sessionId === rec.id).map((e) => e.kind)
    expect(kinds).toContain('session/created')
    expect(kinds).toContain('session/titled')
  })

  it('dedupes: re-importing the same vendor session is skipped, not duplicated', async () => {
    const before = sessions.list().length
    const res = await sessions.importChats(projectId, target, ['11111111-1111-1111-1111-111111111111'])
    expect(res.imported).toHaveLength(0)
    expect(res.skipped).toBe(1)
    expect(sessions.list().length).toBe(before) // no second record

    // And the fresh scan now marks it already-imported.
    const scan = await sessions.scanForImport(target)
    expect(scan.chats[0]!.alreadyImported).toBe(true)
    expect(scan.byProfile).toEqual({}) // nothing left to import
  })

  it('reports vendorSessionIds it could not find', async () => {
    const res = await sessions.importChats(projectId, target, ['does-not-exist'])
    expect(res.notFound).toEqual(['does-not-exist'])
    expect(res.imported).toHaveLength(0)
  })
})

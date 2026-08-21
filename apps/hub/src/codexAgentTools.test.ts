import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { Journal } from './journal.js'
import { SessionStore } from './store.js'
import { ProjectStore } from './projects.js'
import { ApprovalService } from './approvals.js'
import { UsageMonitor } from './usage.js'
import { WorkspaceManager } from './workspace.js'
import { InstructionStore } from './instructions.js'
import { AgentBus } from './bus.js'
import { MemoryStore } from './memory.js'
import { PracticeStore } from './practices.js'
import { SessionManager } from './sessions.js'
import type { Profile, SessionRecord, SessionStatus } from './types.js'
import { QuestionService } from './questions.js'

// Build a SessionManager on an in-memory DB (real hub plumbing; no vendor processes / network), plus
// the store + stores we assert against. The Codex agent-tool path (execAgentTool) is exercised WITHOUT
// a live hub or codex: we inject session records into the store and load them into the manager.
function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-codex-tools-'))
  const db = new Database(':memory:')
  const journal = new Journal(':memory:')
  const store = new SessionStore(journal.db)
  const projects = new ProjectStore(journal.db)
  const approvals = new ApprovalService(journal)
  const profiles: Profile[] = [{ id: 'codex-a', provider: 'codex', dir: path.join(tmp, 'codex-a') }]
  const usage = new UsageMonitor(journal, profiles, {})
  const workspace = new WorkspaceManager(path.join(tmp, 'worktrees'))
  const instructions = new InstructionStore(journal.db)
  const bus = new AgentBus(db)
  const memory = new MemoryStore(db)
  const practices = new PracticeStore(db)
  const sessions = new SessionManager(
    journal, store, new Map(profiles.map((p) => [p.id, p])), approvals, usage, workspace, projects, instructions,
    bus, memory, practices, { busCanUseRiskyTools: false, autoApprovePractices: false }, false, tmp,
    new QuestionService(journal)
  )
  const inject = (records: SessionRecord[]) => {
    for (const r of records) store.upsert(r)
    sessions.loadRecords()
  }
  const cleanup = () => {
    journal.db.close()
    db.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
  return { sessions, approvals, journal, bus, memory, practices, inject, cleanup }
}

function codexRec(id: string, cwd: string, opts: { projectId?: string; status?: SessionStatus } = {}): SessionRecord {
  return {
    id,
    profileId: 'codex-a',
    provider: 'codex',
    projectId: opts.projectId,
    cwd,
    status: opts.status ?? 'active',
    createdAt: new Date().toISOString(),
  }
}

describe('SessionManager.execAgentTool — the Codex agent-tool path (cwd → session attribution)', () => {
  it('attributes a call to the Codex session whose cwd matches (provenance = that session)', async () => {
    const { sessions, memory, inject, cleanup } = setup()
    try {
      inject([
        codexRec('sess-A', '/work/a', { projectId: 'proj1' }),
        codexRec('sess-B', '/work/b', { projectId: 'proj1' }),
      ])
      await sessions.execAgentTool('codex-a', '/work/a', 'memory_write', { title: 'from A', body: 'x', scope: 'account' })
      await sessions.execAgentTool('codex-a', '/work/b', 'memory_write', { title: 'from B', body: 'y', scope: 'account' })
      const notes = memory.list({ scopes: ['account:codex-a'] })
      const byTitle = Object.fromEntries(notes.map((n) => [n.title, n.fromSession]))
      // Same profile (account scope shared), but each note is attributed to the RIGHT session by cwd.
      expect(byTitle['from A']).toBe('sess-A')
      expect(byTitle['from B']).toBe('sess-B')
    } finally {
      cleanup()
    }
  })

  it('refuses (does not mis-attribute) when no live session matches the cwd', async () => {
    const { sessions, inject, cleanup } = setup()
    try {
      inject([codexRec('sess-A', '/work/a', { projectId: 'proj1' })])
      const out = await sessions.execAgentTool('codex-a', '/work/nowhere', 'list_agents', {})
      expect(out).toMatch(/Not attributed/)
    } finally {
      cleanup()
    }
  })

  it('enforces the SAME same-project bus ACL as Claude: cross-project send is denied', async () => {
    const { sessions, inject, cleanup } = setup()
    try {
      inject([
        codexRec('sess-A', '/work/a', { projectId: 'proj1' }),
        codexRec('sess-C', '/work/c', { projectId: 'proj2' }), // different project
      ])
      const out = await sessions.execAgentTool('codex-a', '/work/a', 'send_message', { to_session: 'sess-C', body: 'hi' })
      expect(out).toBe('Not sent: cross-project messaging is not allowed')
    } finally {
      cleanup()
    }
  })

  it('delivers a same-project message on the bus (attributed to the sender session)', async () => {
    const { sessions, bus, inject, cleanup } = setup()
    try {
      inject([
        codexRec('sess-A', '/work/a', { projectId: 'proj1' }),
        // Recipient kept 'active' so bus delivery does not spawn a real codex turn (only idle sessions
        // are injected a turn); the message still fans out + queues, which is what we assert.
        codexRec('sess-B', '/work/b', { projectId: 'proj1', status: 'active' }),
      ])
      const out = await sessions.execAgentTool('codex-a', '/work/a', 'send_message', { to_session: 'sess-B', body: 'ping' })
      expect(out).toBe('Delivered to 1 agent(s).')
      const inbox = bus.inbox('sess-B')
      expect(inbox.map((m) => m.body)).toContain('ping')
      expect(inbox[0]!.fromSession).toBe('sess-A')
    } finally {
      cleanup()
    }
  })

  it('runs an own-account practice write through the real wiring (immediate, journaled)', async () => {
    const { sessions, practices, inject, cleanup } = setup()
    try {
      inject([codexRec('sess-A', '/work/a', { projectId: 'proj1' })])
      const out = await sessions.execAgentTool('codex-a', '/work/a', 'practice_write', { title: 'use pnpm', body: 'always pnpm' })
      expect(out).toMatch(/Recorded a account:codex-a practice/)
      const rows = practices.list({ scopes: ['account:codex-a'] })
      expect(rows.map((p) => p.title)).toContain('use pnpm')
      expect(rows[0]!.fromSession).toBe('sess-A')
    } finally {
      cleanup()
    }
  })

  it('tiebreaks a shared cwd on the lone active session, and refuses when still ambiguous', async () => {
    const { sessions, memory, inject, cleanup } = setup()
    try {
      // Two Codex sessions on one profile sharing a dir (the non-worktree/imported edge). Only ONE is
      // mid-turn (active) — a tool call happens during a turn — so it resolves to that one.
      inject([
        codexRec('sess-D', '/work/shared', { projectId: 'proj1', status: 'active' }),
        codexRec('sess-E', '/work/shared', { projectId: 'proj1', status: 'idle' }),
      ])
      const out = await sessions.execAgentTool('codex-a', '/work/shared', 'memory_write', { title: 'shared', body: 'z', scope: 'account' })
      expect(out).toMatch(/Saved to/)
      expect(memory.list({ scopes: ['account:codex-a'] })[0]!.fromSession).toBe('sess-D')

      // Make BOTH active → genuinely ambiguous → refuse rather than mis-attribute.
      inject([
        codexRec('sess-D', '/work/shared', { projectId: 'proj1', status: 'active' }),
        codexRec('sess-E', '/work/shared', { projectId: 'proj1', status: 'active' }),
      ])
      const denied = await sessions.execAgentTool('codex-a', '/work/shared', 'list_agents', {})
      expect(denied).toMatch(/Not attributed/)
    } finally {
      cleanup()
    }
  })

  it('uses a pending approval id to attribute only its owning manager when manager and child share Codex cwd', async () => {
    const { sessions, approvals, journal, inject, cleanup } = setup()
    try {
      inject([
        {
          ...codexRec('manager', '/work/shared', { projectId: 'proj1', status: 'active' }),
          isProjectManager: true,
          managerCanApproveChildren: true,
          managerAllowedTools: ['shell'],
        },
        {
          ...codexRec('child', '/work/shared', { projectId: 'proj1', status: 'active' }),
          parentSessionId: 'manager',
          permissionMode: 'safe',
        },
      ])
      const pending = approvals.request('child', 'codex/item/commandExecution/requestApproval', {
        toolName: 'commandExecution',
        command: 'git status --short',
      })
      const approvalId = approvals.pending()[0]!.id

      const decided = await sessions.execAgentTool(
        'codex-a',
        '/work/shared',
        'decide_child_approval',
        { approval_id: approvalId, approve: true },
      )

      expect(decided).toMatch(`Approved child approval ${approvalId}`)
      await expect(pending).resolves.toBe(true)
      expect(journal.replay(0)).toContainEqual(expect.objectContaining({
        sessionId: 'manager',
        kind: 'manager/child-approval-decided',
        payload: expect.objectContaining({ approvalId, childSessionId: 'child' }),
      }))

      // The approval handle narrows only this exact decision. No other ambiguous tool call is re-attributed.
      const unrelated = await sessions.execAgentTool('codex-a', '/work/shared', 'list_agents', {})
      expect(unrelated).toMatch(/Not attributed/)
    } finally {
      cleanup()
    }
  })
})

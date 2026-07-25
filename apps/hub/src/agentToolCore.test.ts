import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { MemoryStore } from './memory.js'
import { PracticeStore } from './practices.js'
import { AGENT_TOOLS, runAgentTool, type AgentServices } from './agentToolCore.js'
import type { SessionIdentity } from './identity.js'
import type { BusAddress } from './bus.js'
import type { DangerFlags } from './types.js'

const SAFE: DangerFlags = { busCanUseRiskyTools: false, autoApprovePractices: false }

const idA: SessionIdentity = { sessionId: 's1', profileId: 'a1', provider: 'codex', projectId: 'p1', label: 'alpha' }
const idNoProject: SessionIdentity = { sessionId: 's2', profileId: 'a2', provider: 'codex', label: 'beta' }

interface Harness {
  services: AgentServices
  memory: MemoryStore
  practices: PracticeStore
  sent: { to: BusAddress; subject?: string; body: string }[]
  journaled: { kind: string; payload: unknown }[]
  approvals: { kind: string; payload: unknown }[]
}

function makeHarness(opts: {
  roster?: { sessionId: string; label: string; provider: string; status: string }[]
  inbox?: { fromLabel: string; fromSession: string; subject: string | null; body: string }[]
  sendResult?: { ok: boolean; delivered: number; error?: string }
  approve?: boolean
  isBusTurn?: boolean
  danger?: DangerFlags
} = {}): Harness {
  const memory = new MemoryStore(new Database(':memory:'))
  const practices = new PracticeStore(new Database(':memory:'))
  const sent: Harness['sent'] = []
  const journaled: Harness['journaled'] = []
  const approvals: Harness['approvals'] = []
  const services: AgentServices = {
    send: (_from, to, subject, body) => {
      sent.push({ to, subject, body })
      return opts.sendResult ?? { ok: true, delivered: 1 }
    },
    inbox: () => (opts.inbox ?? []) as never,
    roster: () => opts.roster ?? [],
    memory,
    practices,
    requireApproval: async (_id, kind, payload) => {
      approvals.push({ kind, payload })
      return opts.approve ?? true
    },
    isBusTurn: () => opts.isBusTurn ?? false,
    danger: () => opts.danger ?? SAFE,
    journal: (_sid, kind, payload) => journaled.push({ kind, payload }),
  }
  return { services, memory, practices, sent, journaled, approvals }
}

describe('AGENT_TOOLS surface (provider-agnostic core shared by Claude + Codex)', () => {
  it('exposes exactly the 10 mcp__allmyagents__ tools, each with a description + schema', () => {
    expect(AGENT_TOOLS.map((t) => t.name)).toEqual([
      'list_agents',
      'send_message',
      'read_messages',
      'memory_write',
      'memory_search',
      'memory_read',
      'practice_write',
      'practice_edit',
      'practice_read',
      'practice_list',
    ])
    for (const t of AGENT_TOOLS) {
      expect(t.description.length).toBeGreaterThan(10)
      expect(typeof t.schema).toBe('object')
      expect(typeof t.run).toBe('function')
    }
  })

  it('runAgentTool throws on an unknown tool and reports bad args as a model-readable string', async () => {
    const h = makeHarness()
    await expect(runAgentTool('does_not_exist', {}, { identity: idA, services: h.services })).rejects.toThrow(/unknown agent tool/)
    // memory_write requires title + body; missing them yields a friendly validation message, not a throw.
    const msg = await runAgentTool('memory_write', { title: 'only title' }, { identity: idA, services: h.services })
    expect(msg).toMatch(/Invalid arguments for memory_write/)
  })
})

describe('list_agents / read_messages', () => {
  it('list_agents renders the roster, or a friendly empty message', async () => {
    const empty = makeHarness({ roster: [] })
    expect(await runAgentTool('list_agents', {}, { identity: idA, services: empty.services })).toBe(
      'No other agents are currently on your team.'
    )
    const h = makeHarness({ roster: [{ sessionId: 'abcd1234ef', label: 'worker', provider: 'claude', status: 'idle' }] })
    const out = await runAgentTool('list_agents', {}, { identity: idA, services: h.services })
    expect(out).toContain('worker')
    expect(out).toContain('abcd1234ef') // FULL session id — teammates need the whole id to address a reply (Bug2)
    expect(out).toContain('claude, idle')
  })

  it('read_messages formats newest-first, or reports none', async () => {
    const empty = makeHarness({ inbox: [] })
    expect(await runAgentTool('read_messages', {}, { identity: idA, services: empty.services })).toBe('No messages.')
    const h = makeHarness({ inbox: [{ fromLabel: 'brains', fromSession: 'deadbeefxx', subject: 'hi', body: 'ping' }] })
    const out = await runAgentTool('read_messages', {}, { identity: idA, services: h.services })
    expect(out).toContain('from brains (deadbeefxx)') // FULL sender session id (Bug2), not truncated
    expect(out).toContain('hi')
    expect(out).toContain('ping')
  })
})

describe('send_message (bus addressing)', () => {
  it('addresses a specific teammate when to_session is given', async () => {
    const h = makeHarness({ sendResult: { ok: true, delivered: 1 } })
    const out = await runAgentTool('send_message', { to_session: 'peer99', body: 'hello' }, { identity: idA, services: h.services })
    expect(out).toBe('Delivered to 1 agent(s).')
    expect(h.sent[0]!.to).toEqual({ kind: 'session', id: 'peer99' })
    expect(h.sent[0]!.body).toBe('hello')
  })

  it('broadcasts to the project when to_session is omitted', async () => {
    const h = makeHarness({ sendResult: { ok: true, delivered: 3 } })
    const out = await runAgentTool('send_message', { body: 'team update' }, { identity: idA, services: h.services })
    expect(out).toBe('Delivered to 3 agent(s).')
    expect(h.sent[0]!.to).toEqual({ kind: 'project', id: 'p1' })
  })

  it('refuses a broadcast when the caller is not in a project (no fan-out target)', async () => {
    const h = makeHarness()
    const out = await runAgentTool('send_message', { body: 'no project' }, { identity: idNoProject, services: h.services })
    expect(out).toMatch(/not in a project/)
    expect(h.sent).toHaveLength(0)
  })

  it('surfaces a send failure verbatim (e.g. the cross-project ACL denial)', async () => {
    const h = makeHarness({ sendResult: { ok: false, delivered: 0, error: 'cross-project messaging is not allowed' } })
    const out = await runAgentTool('send_message', { to_session: 'x', body: 'y' }, { identity: idA, services: h.services })
    expect(out).toBe('Not sent: cross-project messaging is not allowed')
  })
})

describe('memory tools (scope resolution + readable-scope enforcement)', () => {
  it('memory_write defaults to the project shelf when in a project, and account otherwise', async () => {
    const inProject = makeHarness()
    await runAgentTool('memory_write', { title: 'decision', body: 'use vitest' }, { identity: idA, services: inProject.services })
    expect(inProject.memory.list({ scopes: ['project:p1'] }).map((m) => m.title)).toEqual(['decision'])

    const noProject = makeHarness()
    await runAgentTool('memory_write', { title: 'solo', body: 'note' }, { identity: idNoProject, services: noProject.services })
    expect(noProject.memory.list({ scopes: ['account:a2'] }).map((m) => m.title)).toEqual(['solo'])
  })

  it('memory_write honors an explicit account scope + records provenance', async () => {
    const h = makeHarness()
    await runAgentTool('memory_write', { title: 't', body: 'b', scope: 'account' }, { identity: idA, services: h.services })
    const m = h.memory.list({ scopes: ['account:a1'] })[0]!
    expect(m.fromSession).toBe('s1')
    expect(m.fromProfile).toBe('a1')
  })

  it('memory_search + memory_read only see the caller readable scopes', async () => {
    const h = makeHarness()
    // Visible to idA (account:a1) and an out-of-scope one (account:other).
    const mine = h.memory.write({ scope: 'account:a1', title: 'mine', body: 'visible secret token' })
    h.memory.write({ scope: 'account:other', title: 'theirs', body: 'visible secret token' })
    const found = await runAgentTool('memory_search', { query: 'secret' }, { identity: idA, services: h.services })
    expect(found).toContain('mine')
    expect(found).not.toContain('theirs')
    // memory_read of the out-of-scope id is refused.
    const other = h.memory.list()[0]!.scope === 'account:other' ? h.memory.list()[0]! : h.memory.list()[1]!
    const denied = await runAgentTool('memory_read', { id: other.id }, { identity: idA, services: h.services })
    expect(denied).toMatch(/Not found, or outside your access/)
    const ok = await runAgentTool('memory_read', { id: mine.id }, { identity: idA, services: h.services })
    expect(ok).toContain('visible secret token')
  })
})

describe('practice tools (the gate is enforced inside the shared body → identical for both providers)', () => {
  it('own-account practice writes immediately, no operator prompt', async () => {
    const h = makeHarness()
    const out = await runAgentTool('practice_write', { title: 'pnpm', body: 'always pnpm' }, { identity: idA, services: h.services })
    expect(out).toMatch(/Recorded a account:a1 practice/)
    expect(h.approvals).toHaveLength(0)
    expect(h.practices.list({ scopes: ['account:a1'] })).toHaveLength(1)
  })

  it('above-account writes wait on operator approval; a decline records nothing', async () => {
    const approved = makeHarness({ approve: true })
    const okOut = await runAgentTool('practice_write', { title: 'x', body: 'y', scope: 'project' }, { identity: idA, services: approved.services })
    expect(approved.approvals[0]!.kind).toBe('practice/write')
    expect(okOut).toMatch(/Recorded a project:p1 practice/)

    const declined = makeHarness({ approve: false })
    const noOut = await runAgentTool('practice_write', { title: 'x', body: 'y', scope: 'project' }, { identity: idA, services: declined.services })
    expect(noOut).toMatch(/operator declined/)
    expect(declined.practices.list({ scopes: ['project:p1'] })).toHaveLength(0)
  })

  it('a bus-caused turn is hard-denied — even own-account — and journals the auto-deny', async () => {
    const h = makeHarness({ isBusTurn: true })
    const out = await runAgentTool('practice_write', { title: 'x', body: 'y' }, { identity: idA, services: h.services })
    expect(out).toMatch(/a turn caused by a teammate message cannot write practices/)
    expect(h.practices.list()).toHaveLength(0)
    expect(h.journaled.some((j) => j.kind === 'approval/auto-denied-bus')).toBe(true)
  })

  it('practice_edit reuses the same gate; practice_read/list are scope-clamped', async () => {
    const h = makeHarness({ approve: true })
    const p = h.practices.write({ scope: 'project:p1', title: 'old', body: 'body' })
    const edited = await runAgentTool('practice_edit', { id: p.id, title: 'new' }, { identity: idA, services: h.services })
    expect(edited).toMatch(/Updated practice/)
    expect(h.approvals[0]!.kind).toBe('practice/edit')
    expect(h.practices.get(p.id)!.title).toBe('new')

    // An out-of-scope practice is invisible to read/edit.
    const hidden = h.practices.write({ scope: 'project:other', title: 'hidden', body: 'z' })
    expect(await runAgentTool('practice_read', { id: hidden.id }, { identity: idA, services: h.services })).toMatch(/Not found/)
    const listed = await runAgentTool('practice_list', {}, { identity: idA, services: h.services })
    expect(listed).toContain('new')
    expect(listed).not.toContain('hidden')
  })
})

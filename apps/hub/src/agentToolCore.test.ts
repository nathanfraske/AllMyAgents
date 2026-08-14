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
  sent: { to: BusAddress; subject?: string; body: string; wake?: boolean; attentionRequired?: boolean }[]
  journaled: { kind: string; payload: unknown }[]
  approvals: { kind: string; payload: unknown }[]
  browserCalls: { sessionId: string; operation: string; args: Record<string, unknown> }[]
}

function makeHarness(opts: {
  roster?: { sessionId: string; label: string; provider: string; status: string }[]
  inbox?: { fromLabel: string; fromSession: string; subject: string | null; body: string }[]
  sendResult?: { ok: boolean; delivered: number; deferred?: number; error?: string }
  approve?: boolean
  isBusTurn?: boolean
  danger?: DangerFlags
  peek?: { found: boolean; summary?: string }
  childStatus?: { ok: boolean; summary?: string; error?: string }
  manageTeam?: { ok: boolean; summary?: string; error?: string }
  manageChild?: { ok: boolean; summary?: string; error?: string }
} = {}): Harness {
  const memory = new MemoryStore(new Database(':memory:'))
  const practices = new PracticeStore(new Database(':memory:'))
  const sent: Harness['sent'] = []
  const journaled: Harness['journaled'] = []
  const approvals: Harness['approvals'] = []
  const browserCalls: Harness['browserCalls'] = []
  const services: AgentServices = {
    send: (_from, to, subject, body, wake, attentionRequired) => {
      sent.push({ to, subject, body, wake, attentionRequired })
      return opts.sendResult ?? { ok: true, delivered: 1 }
    },
    inbox: () => (opts.inbox ?? []) as never,
    roster: () => opts.roster ?? [],
    peek: (_caller, _target) => opts.peek ?? { found: false },
    childStatus: () => opts.childStatus ?? { ok: false, error: 'not a project manager' },
    manageTeam: () => opts.manageTeam ?? { ok: false, error: 'not a project manager' },
    manageChild: () => opts.manageChild ?? { ok: false, error: 'not a project manager' },
    browser: async (sessionId, operation, args) => {
      browserCalls.push({ sessionId, operation, args })
      return [{ type: 'text', text: 'browser unavailable in test' }]
    },
    remoteDevices: async () => [],
    remoteExecute: async () => ({ ok: false, error: 'remote device unavailable in test' }),
    remotePrepareProjectLocation: async () => ({ ok: false, error: 'remote project preparation unavailable in test' }),
    overseerControl: async () => ({ ok: false, error: 'not the overseer in test' }),
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
  return { services, memory, practices, sent, journaled, approvals, browserCalls }
}

describe('AGENT_TOOLS surface (provider-agnostic core shared by Claude + Codex)', () => {
  it('exposes the manager tools alongside the existing provider-agnostic tools', () => {
    expect(AGENT_TOOLS.map((t) => t.name)).toEqual([
      'list_agents',
      'send_message',
      'read_messages',
      'peek_agent',
      'child_status',
      'manage_team',
      'manage_child',
      'spawn_agent',
      'set_child_authority',
      'decide_child_approval',
      'assign_child_task',
      'start_run',
      'inspect_runs',
      'control_run',
      'query_team',
      'memory_write',
      'memory_search',
      'memory_read',
      'practice_write',
      'practice_edit',
      'practice_read',
      'practice_list',
      'browser_navigate',
      'browser_read_page',
      'browser_click',
      'browser_tabs',
      'browser_open_tab',
      'browser_switch_tab',
      'browser_close_tab',
      'browser_download',
      'browser_download_read',
      'browser_screenshot',
      'browser_status',
      'remote_list_devices',
      'remote_ping',
      'remote_inspect_environment',
      'remote_inspect_git',
      'remote_prepare_project_location',
      'remote_list_files',
      'remote_read_file',
      'remote_create_directory',
      'remote_write_file',
      'remote_exec',
      'overseer_control',
    ])
    for (const t of AGENT_TOOLS) {
      expect(t.description.length).toBeGreaterThan(10)
      expect(typeof t.schema).toBe('object')
      expect(typeof t.run).toBe('function')
    }
  })

  it('self-gates a remote durable run and forwards the exact target after approval', async () => {
    const h = makeHarness({ approve: true })
    let received: Parameters<NonNullable<AgentServices['startRun']>>[1] | undefined
    h.services.startRun = async (_callerSessionId, input) => {
      received = input
      return {
        ok: true,
        run: {
          id: 'run-1',
          projectId: 'p1',
          sessionId: 's1',
          actorSessionId: 's1',
          actorLabel: 'alpha',
          targetSessionId: 's1',
          executionTarget: { kind: 'remote', siteId: 'site-a', rootId: 'root-a', command: 'npm test' },
          kind: 'test',
          state: 'queued',
          executable: '(remote shell)',
          args: [],
          cwd: '.',
          commandSummary: 'npm test',
          commandSha256: 'hash',
          resources: ['remote-root'],
          provenance: {
            version: 1,
            capturedAt: new Date(0).toISOString(),
            platform: 'win32',
            architecture: 'x64',
            cwd: '.',
            commandSha256: 'hash',
            environmentScope: 'source-hub',
            environmentSha256: 'env-hash',
            environmentKeys: [],
            lockfiles: [],
          },
          createdAt: new Date(0).toISOString(),
          timeoutMs: 1_000,
          cancelRequested: false,
          stdoutBytes: 0,
          stderrBytes: 0,
          logsTruncated: false,
        },
      }
    }
    const out = await runAgentTool('start_run', {
      kind: 'test',
      remote_device_id: 'site-a',
      remote_root_id: 'root-a',
      remote_command: 'npm test',
      resources: ['gpu-0'],
    }, { identity: idA, services: h.services })

    expect(out).toContain('run-1')
    expect(h.approvals).toMatchObject([{ kind: 'allmyagents/run', payload: { toolName: 'start_run' } }])
    expect(received).toMatchObject({
      kind: 'test',
      resources: ['gpu-0'],
      remote: { deviceId: 'site-a', rootId: 'root-a', command: 'npm test' },
    })
  })

  it('does not let a teammate-caused turn launch a durable run', async () => {
    const h = makeHarness({ isBusTurn: true, approve: true })
    let called = false
    h.services.startRun = async () => {
      called = true
      return { ok: false }
    }
    const out = await runAgentTool('start_run', {
      kind: 'test',
      executable: process.execPath,
    }, { identity: idA, services: h.services })
    expect(out).toMatch(/teammate-caused turn/i)
    expect(called).toBe(false)
    expect(h.approvals).toEqual([])
  })

  it('does not expose any tool that can grant or revoke the project-manager role', () => {
    expect(AGENT_TOOLS.map((t) => t.name)).not.toContain('set_project_manager')
    expect(AGENT_TOOLS.map((t) => t.name)).not.toContain('configure_project_manager')
  })

  it('runAgentTool throws on an unknown tool and reports bad args as a model-readable string', async () => {
    const h = makeHarness()
    await expect(runAgentTool('does_not_exist', {}, { identity: idA, services: h.services })).rejects.toThrow(/unknown agent tool/)
    // memory_write requires title + body; missing them yields a friendly validation message, not a throw.
    const msg = await runAgentTool('memory_write', { title: 'only title' }, { identity: idA, services: h.services })
    expect(msg).toMatch(/Invalid arguments for memory_write/)
  })
})

describe('Agent Browser semantic actions', () => {
  it('forwards only exact opaque click identity plus the bounded approval summary', async () => {
    const h = makeHarness()
    await runAgentTool(
      'browser_click',
      {
        ref: 'el_0123456789abcdef',
        page_generation: 'page_0123456789abcdef',
        target_summary: 'Submit checkout',
      },
      { identity: idA, services: h.services },
    )
    expect(h.browserCalls).toEqual([{
      sessionId: 's1',
      operation: 'click',
      args: {
        ref: 'el_0123456789abcdef',
        pageGeneration: 'page_0123456789abcdef',
        targetSummary: 'Submit checkout',
      },
    }])
  })

  it('does not offer raw selectors, JavaScript, coordinates, paths, or reusable download grants', () => {
    const selected = AGENT_TOOLS.filter((tool) => [
      'browser_click',
      'browser_open_tab',
      'browser_download',
      'browser_download_read',
    ].includes(tool.name))
    const schema = JSON.stringify(selected.map((tool) => tool.schema))
    for (const forbidden of ['selector', 'javascript', 'coordinate', 'x', 'y', 'path', 'grantToken']) {
      expect(schema).not.toContain(`"${forbidden}"`)
    }
  })
})

describe('remote testbed tools', () => {
  it('reveals only the roots and capabilities granted to this chat', async () => {
    const h = makeHarness()
    h.services.remoteDevices = async () => [{
      siteId: 'site-a',
      label: 'Test Device',
      connected: true,
      platform: 'linux',
      arch: 'arm64',
      hostname: 'lab',
      roots: [{
        id: 'root-a',
        label: 'Workspace',
        path: '/operator/private/path',
        read: true,
        write: false,
        terminal: false,
        grantedCapabilities: ['read'],
      }],
    }]
    const out = await runAgentTool('remote_list_devices', {}, { identity: idA, services: h.services })
    expect(out).toContain('Test Device')
    expect(out).toContain('root-a')
    expect(out).not.toContain('/operator/private/path')
  })

  it('hard-denies remote execution on teammate-caused turns unless the operator enabled risky bus tools', async () => {
    const h = makeHarness({ isBusTurn: true })
    let called = false
    h.services.remoteExecute = async () => {
      called = true
      return { ok: true, stdout: 'should not run', exitCode: 0 }
    }
    const out = await runAgentTool('remote_exec', {
      device_id: 'site-a', root_id: 'root-a', command: 'echo unsafe',
    }, { identity: idA, services: h.services })
    expect(out).toMatch(/unavailable on a teammate-caused turn/u)
    expect(called).toBe(false)
  })

  it('renders bounded Git readiness from the fixed remote inspection action', async () => {
    const h = makeHarness()
    h.services.remoteExecute = async (_sessionId, _siteId, action) => {
      expect(action).toEqual({ op: 'git_inspect', rootId: 'root-a' })
      return {
        ok: true,
        git: {
          status: 'dirty', gitAvailable: true, isRepository: true, complete: true, clean: false,
          headCommit: 'a'.repeat(40), headRef: 'main', trackedChanges: 2, untrackedFiles: 1,
          observedAt: new Date().toISOString(),
        },
      }
    }
    const out = await runAgentTool('remote_inspect_git', {
      device_id: 'site-a', root_id: 'root-a',
    }, { identity: idA, services: h.services })
    expect(out).toContain('Git dirty')
    expect(out).toContain('tracked changes 2')
    expect(out).toContain('untracked files 1')
  })

  it('derives project preparation through the hub instead of accepting model-selected Git inputs', async () => {
    const h = makeHarness()
    h.services.remotePrepareProjectLocation = async (sessionId, siteId, rootId) => {
      expect({ sessionId, siteId, rootId }).toEqual({ sessionId: idA.sessionId, siteId: 'site-a', rootId: 'root-a' })
      return {
        ok: true,
        git: {
          status: 'ready', gitAvailable: true, isRepository: true, complete: true, clean: true,
          detached: true, headCommit: 'a'.repeat(40), repository: 'github.com/acme/repo',
          observedAt: new Date().toISOString(),
        },
      }
    }
    const tool = AGENT_TOOLS.find((candidate) => candidate.name === 'remote_prepare_project_location')!
    expect(Object.keys(tool.schema)).toEqual(['device_id', 'root_id'])
    const out = await runAgentTool('remote_prepare_project_location', {
      device_id: 'site-a', root_id: 'root-a',
    }, { identity: idA, services: h.services })
    expect(out).toContain(`prepared at ${'a'.repeat(40)}`)
    expect(out).toContain('github.com/acme/repo')
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

describe('peek_agent (read-only teammate activity)', () => {
  it('renders the hub-built activity summary for a valid teammate', async () => {
    const h = makeHarness({ peek: { found: true, summary: 'worker (claude) is actively working — last activity 3s ago (claude/assistant)' } })
    const out = await runAgentTool('peek_agent', { to_session: 'peer99' }, { identity: idA, services: h.services })
    expect(out).toBe('worker (claude) is actively working — last activity 3s ago (claude/assistant)')
  })

  it('passes an explicit deep-view request through to the ownership-checking hub seam', async () => {
    let seen: unknown
    const h = makeHarness({ peek: { found: true, summary: 'full child transcript' } })
    h.services.peek = (_caller, _target, options) => {
      seen = options
      return { found: true, summary: 'full child transcript' }
    }
    const out = await runAgentTool(
      'peek_agent',
      { to_session: 'child99', view: 'transcript', after_seq: 41 },
      { identity: idA, services: h.services }
    )
    expect(out).toBe('full child transcript')
    expect(seen).toEqual({ view: 'transcript', afterSeq: 41 })
  })

  it('reports a friendly miss when the target is unknown / cross-project (found:false)', async () => {
    const h = makeHarness({ peek: { found: false } })
    const out = await runAgentTool('peek_agent', { to_session: 'nope' }, { identity: idA, services: h.services })
    expect(out).toMatch(/No agent is visible/)
  })
})

describe('child_status (manager lifecycle tally)', () => {
  it('renders the hub-built direct-child tally', async () => {
    const summary = 'Children: 2 running, 1 idle, 1 stopped, 1 errored.'
    const h = makeHarness({ childStatus: { ok: true, summary } })
    expect(await runAgentTool('child_status', {}, { identity: idA, services: h.services })).toBe(summary)
  })
})

describe('manage_team (durable manager lineups)', () => {
  it('returns the hub-authored team summary', async () => {
    const summary = 'Manager teams: 2; active team id: team-a.'
    const h = makeHarness({ manageTeam: { ok: true, summary } })
    expect(
      await runAgentTool('manage_team', { operation: 'list' }, { identity: idA, services: h.services }),
    ).toBe(summary)
  })
})

describe('manage_child (durable manager identity)', () => {
  it('forwards role repair and returns the hub-authored continuity result', async () => {
    const summary = 'Updated Corbato durable role to journal continuity specialist.'
    const h = makeHarness({ manageChild: { ok: true, summary } })
    expect(
      await runAgentTool(
        'manage_child',
        {
          operation: 'set_role',
          child_session: 'child-1',
          role: 'journal continuity specialist',
          reason: 'repair a legacy general role',
        },
        { identity: idA, services: h.services },
      ),
    ).toBe(summary)
  })

  it('keeps the legacy retire verb model-readable but describes it as disabled', () => {
    const tool = AGENT_TOOLS.find((candidate) => candidate.name === 'manage_child')!
    expect(tool.description).toMatch(/legacy.*retired records.*New retirement is disabled/is)
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

  it('can queue a non-urgent message without waking an idle recipient', async () => {
    const h = makeHarness({ sendResult: { ok: true, delivered: 1 } })
    const out = await runAgentTool(
      'send_message',
      { to_session: 'peer99', body: 'checkpoint only', wake: false },
      { identity: idA, services: h.services },
    )
    expect(out).toBe('Queued for 1 agent(s) without starting an idle turn.')
    expect(h.sent[0]?.wake).toBe(false)
  })

  it('marks an actionable direct handoff as audited attention-required mail', async () => {
    const h = makeHarness({ sendResult: { ok: true, delivered: 1 } })
    const out = await runAgentTool(
      'send_message',
      { to_session: 'peer99', body: 'Operator-requested handoff.', attention_required: true },
      { identity: idA, services: h.services },
    )
    expect(out).toBe('Delivered as attention-required mail to 1 agent(s).')
    expect(h.sent[0]?.attentionRequired).toBe(true)
  })

  it('rejects the contradictory attention-required plus wake=false combination before sending', async () => {
    const h = makeHarness()
    const out = await runAgentTool(
      'send_message',
      { to_session: 'peer99', body: 'Contradictory delivery.', wake: false, attention_required: true },
      { identity: idA, services: h.services },
    )
    expect(out).toMatch(/cannot be combined/u)
    expect(h.sent).toHaveLength(0)
  })

  it('reports automatic high-context deferral as queued rather than failed', async () => {
    const h = makeHarness({
      sendResult: { ok: true, delivered: 1, deferred: 1, error: 'Held one expensive idle wake.' },
    })
    const out = await runAgentTool(
      'send_message',
      { to_session: 'peer99', body: 'new note' },
      { identity: idA, services: h.services },
    )
    expect(out).toMatch(/1 high-context idle recipient.*Held one expensive idle wake/is)
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

import { describe, expect, it, vi } from 'vitest'
import { WorkPlans, workToolNeedsTask, type WorkPlanRecord, type WorkPlanInput } from './workPlan.js'
import { buildTaskBoard, taskBoardItemsFromEvents } from './taskBoard.js'

function harness() {
  const records = new Map<string, WorkPlanRecord>([['manager', { id: 'manager', lastOperatorInput: { seq: 10, at: 'now' } }], ['child', { id: 'child' }]])
  const operator = new Set(['manager'])
  const allowed = new Set(['manager:child'])
  const events: Array<{ sessionId: string; kind: string; ts: string; payload: unknown }> = []
  const outstanding = vi.fn(() => false)
  let enabled = true
  const host = { enabled: () => enabled, record: (id: string) => records.get(id), isOperatorTurn: (id: string) => operator.has(id),
    canAssign: (from: string, to: string) => allowed.has(`${from}:${to}`), save: vi.fn(), outstanding,
    audit: (sessionId: string, kind: string, payload: unknown) => { events.push({ sessionId, kind, payload, ts: 'now' }) } }
  let plans = new WorkPlans(host)
  const change = (input: WorkPlanInput, id = 'manager') => {
    const current = plans.read(id).plan
    return plans.change(id, { planId: current?.id, expectedRevision: current?.revision, ...input })
  }
  const create = (child = false) => change({ operation: 'create', steps: [{ title: 'Ship requested change', doneWhen: 'Required gates and release verified' },
    ...(child ? [{ title: 'Independent fixture', doneWhen: 'Exact regression passes', ownerSessionId: 'child' }] : [])] }).plan!
  return { records, operator, allowed, events, outstanding, change, create, get plans() { return plans },
    restart: () => { for (const [id, r] of records) records.set(id, structuredClone(r)); plans = new WorkPlans(host) }, disable: () => { enabled = false } }
}

describe('durable work lifecycle', () => {
  it('requires an active immutable outcome, then closes work without blocking status, help or a quiet handoff', () => {
    const h = harness()
    expect(h.plans.gate('manager', 'start_run', {})).toContain('Task-first')
    const p = h.create(), taskId = p.steps[0]!.id
    expect(h.plans.gate('manager', 'start_run', {})).toContain('No active task')
    h.change({ operation: 'update', taskId, status: 'in_progress' })
    expect(h.plans.gate('manager', 'start_run', {})).toBeUndefined()
    expect(() => h.change({ operation: 'update', taskId, status: 'completed' })).toThrow('evidence')
    h.change({ operation: 'update', taskId, status: 'completed', evidence: 'run-123 succeeded; exact release verified' })
    h.change({ operation: 'finish' })
    expect(h.plans.gate('manager', 'start_run', {})).toContain('complete')
    expect(h.plans.gate('manager', 'send_message', { wake: true })).toContain('complete')
    for (const [name, args] of [['inspect_runs', {}], ['report_tool_failure', {}], ['publish_artifact', {}], ['decide_child_approval', {}], ['send_message', { wake: false }], ['control_run', { operation: 'cancel' }]] as const) {
      expect(h.plans.gate('manager', name, args)).toBeUndefined()
    }
    expect(() => h.create()).toThrow('fresh admitted operator')
    expect(h.plans.gate('manager', 'Read', { path: 'repeat-the-audit' })).toContain('complete')
    expect(h.plans.gate('manager', 'WebSearch', { query: 'another review' })).toContain('complete')
    expect(() => h.change({ operation: 'update', taskId, status: 'in_progress' })).toThrow('reopened')
  })

  it('survives compaction/restart and does not treat native plans, new wording, or teammate mail as a new operator request', () => {
    const h = harness(), original = h.create()
    h.restart()
    expect(h.plans.read('manager').plan).toEqual(original)
    h.operator.clear()
    expect(() => h.change({ operation: 'append', steps: [{ title: 'Audit the audit', doneWhen: 'Keep reviewing' }] })).toThrow('operator')
    h.operator.add('manager')
    expect(() => h.change({ operation: 'append', steps: [{ title: 'Audit the audit', doneWhen: 'Keep reviewing' }] })).toThrow('fresh')
    h.records.get('manager')!.lastOperatorInput!.seq++
    h.change({ operation: 'append', steps: [{ title: 'New operator request', doneWhen: 'New result' }] })
    const next = h.plans.read('manager').plan!
    expect(next.steps[0]).toEqual(original.steps[0])
    expect(next.steps).toHaveLength(2)
  })

  it('rejects stale revisions and does not permit parallel task expansion or multiple active tasks for an owner', () => {
    const h = harness(), p = h.create(), taskId = p.steps[0]!.id
    h.change({ operation: 'update', taskId, status: 'in_progress' })
    expect(() => h.plans.change('manager', { operation: 'update', planId: p.id, expectedRevision: 1, taskId, status: 'blocked' })).toThrow('Stale')
    h.records.get('manager')!.lastOperatorInput!.seq++
    const next = h.change({ operation: 'append', steps: [{ title: 'Another outcome', doneWhen: 'Done' }] }).plan!
    expect(() => h.change({ operation: 'update', taskId: next.steps[1]!.id, status: 'in_progress' })).toThrow('current task')
  })

  it('binds dedicated workers without private parent text, grants, self-replacement, sibling writes or stale manager authority', () => {
    const h = harness(), p = h.create(true), taskId = p.steps[1]!.id
    const childView = h.plans.read('child')
    expect(childView.assignedTaskId).toBe(taskId)
    expect(JSON.stringify(childView)).not.toContain('Ship requested change')
    expect(() => h.change({ operation: 'create', steps: [{ title: 'Rogue', doneWhen: 'Self-grant' }] }, 'child')).toThrow('operator')
    expect(() => h.change({ operation: 'update', taskId: p.steps[0]!.id, status: 'completed', evidence: 'claimed' }, 'child')).toThrow('outside')
    h.change({ operation: 'update', taskId, status: 'in_progress' }, 'child')
    expect(h.plans.gate('child', 'remote_exec', {})).toBeUndefined()
    h.allowed.clear()
    expect(h.plans.gate('child', 'remote_exec', {})).toContain('revoked')
    expect(JSON.stringify(h.events.filter(e => e.sessionId === 'child'))).not.toContain('Ship requested change')
  })

  it('does not call running or outcome-unknown work complete, cancel it, or replay it', () => {
    const h = harness(), p = h.create(), taskId = p.steps[0]!.id
    h.outstanding.mockReturnValue(true)
    expect(() => h.change({ operation: 'update', taskId, status: 'completed', evidence: 'not really done' })).toThrow('uncertain')
    expect(h.plans.read('manager').plan!.steps[0]!.status).toBe('pending')
    h.outstanding.mockReturnValue(false)
    h.change({ operation: 'update', taskId, status: 'completed', evidence: 'terminal receipt' })
    h.outstanding.mockReturnValue(true)
    expect(() => h.change({ operation: 'finish' })).toThrow(/reconcile/i)
  })

  it('delegates an existing outcome once and permits its exact handoff without inventing coordination work', () => {
    const h = harness(), p = h.create(), task = p.steps[0]!
    h.change({ operation: 'assign', taskId: task.id, ownerSessionId: 'child' })
    expect(h.plans.read('child').plan!.steps[0]).toEqual({ ...task, ownerSessionId: 'child' })
    expect(h.plans.gate('manager', 'send_message', { to_session: 'child', wake: true })).toBeUndefined()
    expect(h.plans.gate('manager', 'send_message', { to_session: 'unrelated', wake: true })).toContain('No active task')
    expect(h.plans.gate('manager', 'send_message', { wake: true })).toContain('No active task')
    expect(() => h.change({ operation: 'assign', taskId: task.id, ownerSessionId: 'child' })).toThrow('dedicated owner')
    h.change({ operation: 'update', taskId: task.id, status: 'completed', evidence: 'exact fixture passed' }, 'child')
    expect(h.plans.gate('manager', 'send_message', { to_session: 'child', wake: true })).toContain('complete')
  })

  it('keeps adopted assignment identity and amendment revision through execution snapshots', () => {
    const id = 'manager:existing'
    const events = [
      { kind: 'manager/task-assigned', ts: 'first', payload: { id, title: 'Existing scope', status: 'in_progress', managerSessionId: 'manager', revision: 4 } },
      { kind: 'session/work-plan', ts: 'later', payload: { revision: 1, steps: [{ id, title: 'Existing scope', doneWhen: 'Original outcome', status: 'completed' }] } },
    ]
    const board = buildTaskBoard(taskBoardItemsFromEvents(events))
    expect(board.tasks).toHaveLength(1)
    expect(board.tasks[0]).toMatchObject({ id, origin: 'manager', assignedBySessionId: 'manager', revision: 4, status: 'completed' })
  })

  it('preserves operator opt-out and allows a fresh operator task after completion without changing historical tasks', () => {
    const h = harness(), p = h.create(), taskId = p.steps[0]!.id
    h.change({ operation: 'update', taskId, status: 'completed', evidence: 'verified result' })
    h.change({ operation: 'finish' })
    h.records.get('manager')!.lastOperatorInput!.seq++
    expect(h.plans.gate('manager', 'Read', { path: 'answer-new-operator-question' })).toBeUndefined()
    const next = h.create()
    expect(next.id).not.toBe(p.id)
    expect(h.plans.gate('manager', 'Bash', {})).toContain('active task')
    h.disable()
    expect(h.plans.gate('manager', 'Bash', {})).toBeUndefined()
  })

  it('keeps execution tasks visible and immutable through native snapshot replacement and forged native task updates', () => {
    const h = harness(), p = h.create()
    const board = buildTaskBoard([...taskBoardItemsFromEvents(h.events),
      { kind: 'tool', ts: 'later', toolName: 'update_plan', toolInput: { plan: [{ step: 'expanded audit', status: 'in_progress' }] } },
      { kind: 'tool', ts: 'later', toolName: 'TaskUpdate', toolInput: { taskId: p.steps[0]!.id, subject: 'forged rewrite', status: 'completed' } }])
    expect(board.tasks.find(t => t.id === p.steps[0]!.id)).toMatchObject({ title: 'Ship requested change', status: 'pending', origin: 'contract' })
    expect(h.plans.gate('manager', 'start_run', {})).toContain('active task')
  })

  it('does not confuse a permission exception, mutating list operation, or opaque alias with a recovery tool', () => {
    expect(workToolNeedsTask('mcp__allmyagents__overseer_control', { operation: 'approve' })).toBe(false)
    expect(workToolNeedsTask('mcp__allmyagents__overseer_control', { operation: 'configure_approval_policy' })).toBe(true)
    expect(workToolNeedsTask('manage_artifacts', { operation: 'delete' })).toBe(true)
    expect(workToolNeedsTask('send_message', { wake: false, attention_required: true })).toBe(true)
    expect(workToolNeedsTask('Bash', { command: 'echo harmless' })).toBe(true)
    expect(workToolNeedsTask('mcp__other__task_plan', { operation: 'create' })).toBe(true)
  })
})

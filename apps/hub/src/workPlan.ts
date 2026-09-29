import { randomUUID } from 'node:crypto'

export type WorkStatus = 'pending' | 'in_progress' | 'blocked' | 'completed'
export interface WorkStep {
  id: string
  title: string
  doneWhen: string
  ownerSessionId: string
  status: WorkStatus
  evidence?: string
}
export interface WorkPlan {
  id: string
  revision: number
  /** Authenticated, admitted operator input; never a vendor plan or a bus message. */
  inputSeq: number
  createdAt: string
  status: 'active' | 'completed'
  steps: WorkStep[]
}
export interface WorkBinding { sessionId: string; planId: string; taskId: string }
export interface WorkPlanInput {
  operation: 'read' | 'create' | 'append' | 'assign' | 'update' | 'finish'
  planId?: string
  expectedRevision?: number
  steps?: Array<{ title: string; doneWhen: string; ownerSessionId?: string }>
  taskId?: string
  ownerSessionId?: string
  status?: WorkStatus
  evidence?: string
}
export interface WorkPlanRecord {
  id: string
  workPlan?: WorkPlan
  workBinding?: WorkBinding
  lastOperatorInput?: { seq: number; at: string }
}
interface Host {
  enabled(): boolean
  record(id: string): WorkPlanRecord | undefined
  isOperatorTurn(id: string): boolean
  canAssign(from: string, to: string): boolean
  save(record: WorkPlanRecord): void
  audit(id: string, kind: string, payload: unknown): void
  /** Checks outstanding external work before closing; does not cancel or replay it. */
  outstanding(id: string, since: string): boolean
}
const bounded = (s: unknown, max: number): s is string => typeof s === 'string' && !!s.trim() && s.length <= max

// Recovery/status/reporting operations, NOT an authority allowlist. Their ordinary resource/approval checks
// always run. No opaque shell, connector or unknown tool can acquire work authority through this set.
const OBSERVE = new Set([
  'task_plan', 'report_tool_failure', 'publish_artifact', 'decide_child_approval', 'list_agents', 'peek_agent', 'child_status', 'read_messages',
  'inspect_runs', 'query_team', 'memory_search', 'memory_read', 'practice_read', 'practice_list',
  'remote_list_devices', 'remote_ping', 'remote_inspect_environment', 'remote_inspect_git',
  'remote_list_files', 'remote_read_file', 'browser_status', 'browser_tabs', 'browser_read_page',
  'browser_screenshot', 'browser_download_read', 'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch',
  'AskUserQuestion', 'request_user_input', 'request_user_input_async', 'update_plan', 'TodoWrite',
  'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'get_goal', 'view_image',
])
// Finishing leaves a reporting/recovery lane, not an open-ended read/audit loop. A fresh direct
// operator question may still use the normal read-only lane without inventing another project.
const AFTER_COMPLETION = new Set([
  'task_plan', 'report_tool_failure', 'publish_artifact', 'decide_child_approval', 'inspect_runs',
  'read_messages', 'child_status', 'list_agents', 'peek_agent', 'get_goal', 'TaskList', 'TaskGet',
  'AskUserQuestion', 'request_user_input', 'request_user_input_async',
  'send_message', 'control_run', 'monitor_ci', 'manage_artifacts', 'overseer_control',
])
export function workToolNeedsTask(tool: string, args: unknown): boolean {
  const name = tool.replace(/^mcp__allmyagents__/, '')
  const a = args && typeof args === 'object' ? args as Record<string, unknown> : {}
  if (OBSERVE.has(name)) return false
  if (name === 'control_run' && ['wait', 'cancel'].includes(String(a.operation))) return false
  if (name === 'send_message' && a.wake === false && a.attention_required !== true) return false
  if (['monitor_ci', 'manage_artifacts'].includes(name) && a.operation === 'list') return false
  if (name === 'overseer_control' && ['inspect_approval', 'approve', 'get_approval_policy', 'status', 'failure_context', 'guide', 'get_operating_mode', 'github_repositories', 'get_github_automation_policy', 'list_overseer_peers', 'list_team_presets'].includes(String(a.operation))) return false
  return true
}

/** Deterministic lifecycle ledger. No inference, new permissions, timers, or agent judge. */
export class WorkPlans {
  constructor(private readonly host: Host) {}

  private resolve(id: string) {
    const record = this.host.record(id)
    if (!record) throw new Error('Task session is unavailable.')
    const binding = record.workBinding
    if (binding) {
      const owner = this.host.record(binding.sessionId)
      const plan = owner?.workPlan
      if (!owner || !plan || plan.id !== binding.planId || !this.host.canAssign(owner.id, id)) {
        throw new Error('Task assignment is stale or its manager authority was revoked. Ask the operator; do not replace it.')
      }
      const step = plan.steps.find(s => s.id === binding.taskId && s.ownerSessionId === id)
      if (!step) throw new Error('Task assignment is no longer current.')
      return { record, owner, plan, step }
    }
    return { record, owner: record, plan: record.workPlan, step: undefined }
  }

  read(id: string): { plan?: WorkPlan; assignedTaskId?: string } {
    const { plan, step } = this.resolve(id)
    // A child sees its own assignment, not the operator's private parent-task text.
    return { plan: plan && structuredClone(step ? { ...plan, steps: [step] } : plan), ...(step ? { assignedTaskId: step.id } : {}) }
  }

  gate(id: string, tool: string, args: unknown): string | undefined {
    if (!this.host.enabled()) return
    const needsTask = workToolNeedsTask(tool, args)
    const name = tool.replace(/^mcp__allmyagents__/, '')
    try {
      const { record, plan, step } = this.resolve(id)
      const completed = plan?.status === 'completed' || step?.status === 'completed' || !!plan?.steps.every(s => s.status === 'completed')
      const freshOperator = this.host.isOperatorTurn(id) && (record.lastOperatorInput?.seq ?? 0) > (plan?.inputSeq ?? 0)
      if (!needsTask && (!completed || freshOperator || AFTER_COMPLETION.has(name))) return
      if (completed) return 'This task list is complete. Report the result and stop. A new operator request is required for new work; compaction or teammate mail cannot reopen it.'
      if (!plan) return 'Task-first: use task_plan to record the requested outcomes and completion criteria before work. A native checklist is not execution authority.'
      // A coordinator may delegate every outcome. Permit its exact recorded handoff without forcing
      // an artificial "coordinate the coordination" task; ordinary bus/grant checks still apply.
      const target = args && typeof args === 'object' ? (args as Record<string, unknown>).to_session : undefined
      if (!step && name === 'send_message' && typeof target === 'string' && this.host.canAssign(id, target)) {
        const binding = this.host.record(target)?.workBinding
        if (binding?.sessionId === id && binding.planId === plan.id && plan.steps.some(s => s.id === binding.taskId && s.ownerSessionId === target && s.status !== 'completed')) return
      }
      const active = step ? step.status === 'in_progress' : plan.steps.some(s => s.ownerSessionId === id && s.status === 'in_progress')
      if (!active) return 'No active task is assigned to you. Use task_plan to start an existing pending task, inspect the team result, or ask the operator; do not invent follow-up work.'
    } catch (error) {
      if (!needsTask && AFTER_COMPLETION.has(name)) return // Status/help remains available for a stale assignment.
      return (error as Error).message
    }
  }

  closed(id: string): boolean {
    if (!this.host.enabled()) return false
    try {
      const { plan, step } = this.resolve(id)
      return plan?.status === 'completed' || step?.status === 'completed' || !!plan?.steps.every(s => s.status === 'completed')
    } catch { return true }
  }

  change(id: string, input: WorkPlanInput): ReturnType<WorkPlans['read']> {
    if (input.operation === 'read') return this.read(id)
    const record = this.host.record(id)
    if (!record) throw new Error('Task session is unavailable.')
    const operator = this.host.isOperatorTurn(id)
    // A direct operator can give a worker independent work. Only creation from fresh admitted input
    // severs a prior binding; an ordinary child turn cannot self-grant a replacement assignment.
    const { owner, plan, step } = input.operation === 'create' && operator
      ? { owner: record, plan: record.workPlan, step: undefined } : this.resolve(id)
    if (input.operation !== 'create' && (!plan || input.planId !== plan.id || input.expectedRevision !== plan.revision)) {
      throw new Error('Stale task plan. Read once and use the exact plan id and revision; do not recreate it.')
    }
    if (input.operation === 'create' || input.operation === 'append') {
      const seq = record.lastOperatorInput?.seq ?? 0
      if (!operator || !seq || (plan && seq <= plan.inputSeq)) throw new Error('Only fresh admitted operator input can authorize a new task list or additional outcomes.')
      if (owner.id !== id) throw new Error('Only the plan owner can add outcomes.')
      if (input.operation === 'create' && plan?.status === 'active') throw new Error('An active plan already exists. Preserve its tasks; append only the new operator-requested outcomes.')
      if (input.operation === 'append' && plan?.status !== 'active') throw new Error('This plan is closed. A fresh operator request may create a new plan, not reopen this one.')
      if (!input.steps?.length || input.steps.length + (input.operation === 'append' ? plan!.steps.length : 0) > 24) throw new Error('Use 1–24 bounded outcomes, not an expanding activity log.')
      const assigned = new Set<string>()
      const nextSteps: WorkStep[] = input.steps.map(s => {
        if (!bounded(s.title, 500) || !bounded(s.doneWhen, 1000)) throw new Error('Each task needs a bounded title and completion criterion.')
        const target = s.ownerSessionId ?? id
        if (target !== id) {
          if (!this.host.canAssign(id, target)) throw new Error('Task owner is outside your managed hierarchy.')
          if (assigned.has(target)) throw new Error('Give each dedicated worker one bounded outcome at a time.')
          const worker = this.host.record(target)!
          if ((worker.workPlan || worker.workBinding) && !this.closed(target)) throw new Error('The worker already has active work; coordinate instead of replacing it.')
          assigned.add(target)
        }
        return { id: `work:${randomUUID()}`, title: s.title.trim(), doneWhen: s.doneWhen.trim(), ownerSessionId: target, status: 'pending' }
      })
      const next: WorkPlan = input.operation === 'append'
        ? { ...plan!, revision: plan!.revision + 1, inputSeq: seq, steps: [...plan!.steps, ...nextSteps] }
        : { id: randomUUID(), revision: 1, inputSeq: seq, createdAt: new Date().toISOString(), status: 'active', steps: nextSteps }
      record.workPlan = next
      if (input.operation === 'create') delete record.workBinding
      this.commit(record)
      for (const task of nextSteps) if (task.ownerSessionId !== id) {
        const worker = this.host.record(task.ownerSessionId)!
        worker.workBinding = { sessionId: id, planId: next.id, taskId: task.id }
        this.host.save(worker)
        this.host.audit(worker.id, 'session/work-assigned', { ...worker.workBinding, title: task.title, doneWhen: task.doneWhen })
      }
    } else {
      if (plan!.status === 'completed') throw new Error('Completed tasks cannot be reopened by agents.')
      const next = structuredClone(plan!)
      if (input.operation === 'finish') {
        if (owner.id !== id || next.steps.some(s => s.status !== 'completed')) throw new Error('Every assigned outcome must be completed before finishing the plan.')
        if ([...new Set(next.steps.map(s => s.ownerSessionId)), id].some(s => this.host.outstanding(s, next.createdAt))) throw new Error('External work is still running or uncertain. Reconcile it before claiming completion; never replay it.')
        next.status = 'completed'
      } else if (input.operation === 'assign') {
        const task = next.steps.find(s => s.id === input.taskId)
        const target = input.ownerSessionId
        if (owner.id !== id || !task || task.status !== 'pending' || !target || target === id || !this.host.canAssign(id, target)) throw new Error('Assign only an existing pending outcome to a dedicated managed owner.')
        if (task.ownerSessionId !== id) throw new Error('An assigned outcome already has a dedicated owner; do not redirect it through repeated delegation.')
        const worker = this.host.record(target)!
        if ((worker.workPlan || worker.workBinding) && !this.closed(target)) throw new Error('The worker already has active work.')
        task.ownerSessionId = target
        worker.workBinding = { sessionId: id, planId: next.id, taskId: task.id }
        this.host.save(worker)
      } else if (input.operation === 'update') {
        const task = next.steps.find(s => s.id === input.taskId)
        if (!task || (step && step.id !== task.id) || (owner.id !== id && task.ownerSessionId !== id)) throw new Error('Task is outside your assignment.')
        if (task.ownerSessionId !== id && !this.host.canAssign(id, task.ownerSessionId)) throw new Error('The task owner is unavailable or currently has direct operator work. Coordinate without overriding it.')
        if (!input.status || !['pending', 'in_progress', 'blocked', 'completed'].includes(input.status)) throw new Error('Invalid task status.')
        if (task.status === 'completed') throw new Error('Completed tasks are locked; report new evidence to the operator instead of reopening them.')
        if (input.status === 'completed' && !bounded(input.evidence, 1500)) throw new Error('Completion requires a bounded evidence reference or result, not a new review loop.')
        if (input.status === 'completed' && this.host.outstanding(task.ownerSessionId, next.createdAt)) throw new Error('The owner still has running or uncertain external work; reconcile before completion.')
        if (input.status === 'in_progress' && next.steps.some(s => s.id !== task.id && s.ownerSessionId === task.ownerSessionId && s.status === 'in_progress')) throw new Error('Finish or block the current task before starting another.')
        task.status = input.status
        if (input.evidence) task.evidence = input.evidence.slice(0, 1500)
      } else throw new Error('Unknown task operation.')
      next.revision++
      owner.workPlan = next
      this.commit(owner)
    }
    return this.read(id)
  }

  private commit(owner: WorkPlanRecord): void {
    this.host.save(owner)
    this.host.audit(owner.id, 'session/work-plan', structuredClone(owner.workPlan))
    for (const id of new Set(owner.workPlan!.steps.map(s => s.ownerSessionId))) if (id !== owner.id) {
      this.host.audit(id, 'session/work-plan', structuredClone({ ...owner.workPlan!, steps: owner.workPlan!.steps.filter(s => s.ownerSessionId === id) }))
    }
  }
}

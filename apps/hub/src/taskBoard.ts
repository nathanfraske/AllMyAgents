/**
 * The agent's TASK BOARD, derived from its own tool calls.
 *
 * When an agent plans work it calls a task tool — `TaskCreate`/`TaskUpdate` or `TodoWrite` on Claude,
 * and `update_plan` on Codex. Claude calls are already journaled as ordinary tool items. Codex 0.145
 * emits `turn/plan/updated`; the store normalizes that durable event into a board-only `update_plan`
 * tool item. Three shapes exist in the wild, so this reduces all of them into one model:
 *
 *   - `TodoWrite` sends a SNAPSHOT of the whole list on every call → replace the board.
 *   - Codex `update_plan` also sends the WHOLE plan on every notification → replace the board.
 *   - `TaskCreate` / `TaskUpdate` are INCREMENTAL → apply in order.
 *
 * Pure + structural so it is unit-testable without the store or a live hub.
 */

export interface TaskBoardItem {
  kind: string
  ts: string
  toolName?: string
  toolInput?: unknown
  toolResult?: string
}

export interface BoardTask {
  id: string
  title: string
  /** Vendor-ish but normalized where possible: pending | in_progress | completed. */
  status: string
  createdAt: string
  updatedAt: string
  /** Who put this item on the shared board. Agent-authored task tools remain the default. */
  origin: 'agent' | 'manager'
  assignedBySessionId?: string
  assignedByLabel?: string
}

export interface BoardChange {
  ts: string
  kind: 'created' | 'updated' | 'snapshot'
  taskId?: string
  title?: string
  status?: string
}

export interface TaskBoard {
  tasks: BoardTask[]
  /** Every mutation in order — "the task history" behind the current board. */
  changes: BoardChange[]
  source: 'todo' | 'plan' | 'task' | 'manager' | 'mixed' | 'none'
}

export interface TaskBoardEvent {
  ts: string
  kind: string
  payload: unknown
}

const CREATE_TOOLS = new Set(['TaskCreate'])
const UPDATE_TOOLS = new Set(['TaskUpdate'])
const TODO_SNAPSHOT_TOOLS = new Set(['TodoWrite'])
const PLAN_SNAPSHOT_TOOLS = new Set(['update_plan'])
const MANAGER_TASK_TOOL = 'ManagerTask'

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

function records(v: unknown): Record<string, unknown>[] {
  if (Array.isArray(v)) return v.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object')
  if (typeof v !== 'string') return []
  try {
    const parsed: unknown = JSON.parse(v)
    return Array.isArray(parsed)
      ? parsed.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object')
      : []
  } catch {
    return []
  }
}

/** Titles from a create call, tolerating the several shapes these tools accept. */
function titlesFromCreate(input: Record<string, unknown>): string[] {
  const single = str(input.subject) ?? str(input.title) ?? str(input.description)
  if (single) return [single]
  // Some callers pass a list (occasionally as a JSON-encoded string).
  const raw = input.taskTitles ?? input.titles ?? input.tasks
  if (Array.isArray(raw)) return raw.map((t) => str(t) ?? '').filter(Boolean)
  const asStr = str(raw)
  if (asStr) {
    try {
      const parsed: unknown = JSON.parse(asStr)
      if (Array.isArray(parsed)) return parsed.map((t) => str(t) ?? '').filter(Boolean)
    } catch {
      return [asStr]
    }
  }
  return []
}

export function buildTaskBoard(items: readonly TaskBoardItem[]): TaskBoard {
  const tasks = new Map<string, BoardTask>()
  const changes: BoardChange[] = []
  let source: TaskBoard['source'] = 'none'
  let seq = 0

  for (const it of items) {
    if (it.kind !== 'tool' || !it.toolName) continue
    const input = (it.toolInput ?? {}) as Record<string, unknown>

    if (it.toolName === MANAGER_TASK_TOOL) {
      const id = str(input.id)
      const title = str(input.title)
      const status = str(input.status) ?? 'pending'
      if (!id || !title) continue
      source = source === 'none' || source === 'manager' ? 'manager' : 'mixed'
      const existing = tasks.get(id)
      tasks.set(id, {
        id,
        title,
        status,
        createdAt: existing?.createdAt ?? it.ts,
        updatedAt: it.ts,
        origin: 'manager',
        assignedBySessionId: str(input.managerSessionId),
        assignedByLabel: str(input.managerLabel),
      })
      changes.push({
        ts: it.ts,
        kind: existing ? 'updated' : 'created',
        taskId: id,
        title,
        status,
      })
      continue
    }

    if (TODO_SNAPSHOT_TOOLS.has(it.toolName) || PLAN_SNAPSHOT_TOOLS.has(it.toolName)) {
      const isPlan = PLAN_SNAPSHOT_TOOLS.has(it.toolName)
      const rows = records(isPlan ? input.plan : input.todos)
      const snapshotSource = isPlan ? 'plan' : 'todo'
      source = [...tasks.values()].some((task) => task.origin === 'manager') ? 'mixed' : snapshotSource
      // A vendor snapshot replaces the AGENT'S board. Manager assignments are a separate audited input
      // to that same board and remain until the manager completes/abandons them.
      for (const [id, task] of tasks) if (task.origin === 'agent') tasks.delete(id)
      rows.forEach((t, i) => {
        const id = `${isPlan ? 'plan' : 'todo'}:${i}`
        const title = str(t.step) ?? str(t.content) ?? str(t.activeForm) ?? `task ${i + 1}`
        const rawStatus = str(t.status) ?? 'pending'
        const status = rawStatus === 'inProgress' ? 'in_progress' : rawStatus
        tasks.set(id, { id, title, status, createdAt: it.ts, updatedAt: it.ts, origin: 'agent' })
      })
      changes.push({ ts: it.ts, kind: 'snapshot' })
      continue
    }

    if (CREATE_TOOLS.has(it.toolName)) {
      const titles = titlesFromCreate(input)
      if (!titles.length) continue
      if (source === 'none') source = 'task'
      else if (source === 'manager') source = 'mixed'
      // Prefer an id the tool reported back ("Created task #7"); otherwise number them in creation order,
      // which is how these harnesses id them anyway.
      const reported = /#(\d+)/.exec(it.toolResult ?? '')?.[1]
      for (const title of titles) {
        const id = titles.length === 1 && reported ? reported : String(++seq)
        if (reported && titles.length === 1) seq = Math.max(seq, Number(reported))
        tasks.set(id, { id, title, status: 'pending', createdAt: it.ts, updatedAt: it.ts, origin: 'agent' })
        changes.push({ ts: it.ts, kind: 'created', taskId: id, title })
      }
      continue
    }

    if (UPDATE_TOOLS.has(it.toolName)) {
      const id = str(input.taskId) ?? (typeof input.taskId === 'number' ? String(input.taskId) : undefined)
      const status = str(input.status)
      if (!id) continue
      const existing = tasks.get(id)
      if (existing) {
        if (status) existing.status = status
        if (str(input.subject)) existing.title = str(input.subject)!
        existing.updatedAt = it.ts
      }
      // Recorded even when the task predates the visible history, so the timeline stays honest.
      changes.push({ ts: it.ts, kind: 'updated', taskId: id, status })
      continue
    }
  }

  return { tasks: [...tasks.values()], changes, source }
}

/**
 * Normalize the hub's durable vendor/audit events into the exact item stream consumed by the reducer.
 * Both `peek_agent tasks` and the web store use these same tool shapes.
 */
export function taskBoardItemsFromEvents(events: readonly TaskBoardEvent[]): TaskBoardItem[] {
  const items: TaskBoardItem[] = []
  const byToolUse = new Map<string, TaskBoardItem>()
  for (const event of events) {
    const payload = (event.payload ?? {}) as Record<string, unknown>
    if (event.kind === 'claude/assistant') {
      const message = payload.message as { content?: unknown[] } | undefined
      for (const raw of message?.content ?? []) {
        const block = raw as { type?: string; id?: string; name?: string; input?: unknown }
        if (block.type !== 'tool_use' || !block.name) continue
        const item: TaskBoardItem = {
          kind: 'tool',
          ts: event.ts,
          toolName: block.name,
          toolInput: block.input,
        }
        items.push(item)
        if (block.id) byToolUse.set(block.id, item)
      }
      continue
    }
    if (event.kind === 'claude/user') {
      const message = payload.message as { content?: unknown[] } | undefined
      for (const raw of message?.content ?? []) {
        const block = raw as {
          type?: string
          tool_use_id?: string
          content?: unknown
        }
        if (block.type !== 'tool_result' || !block.tool_use_id) continue
        const item = byToolUse.get(block.tool_use_id)
        if (item) item.toolResult = typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
      }
      continue
    }
    if (event.kind === 'codex/turn/plan/updated') {
      items.push({ kind: 'tool', ts: event.ts, toolName: 'update_plan', toolInput: event.payload })
      continue
    }
    if (event.kind === 'manager/task-assigned') {
      items.push({ kind: 'tool', ts: event.ts, toolName: MANAGER_TASK_TOOL, toolInput: event.payload })
    }
  }
  return items
}

/** Counts for the collapsed strip above the composer. */
export function summarizeBoard(board: TaskBoard): { total: number; done: number; active: number; pending: number } {
  let done = 0
  let active = 0
  let pending = 0
  for (const t of board.tasks) {
    if (t.status === 'completed' || t.status === 'done') done++
    else if (t.status === 'in_progress' || t.status === 'active') active++
    else pending++
  }
  return { total: board.tasks.length, done, active, pending }
}

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
  source: 'todo' | 'plan' | 'task' | 'none'
}

const CREATE_TOOLS = new Set(['TaskCreate'])
const UPDATE_TOOLS = new Set(['TaskUpdate'])
const TODO_SNAPSHOT_TOOLS = new Set(['TodoWrite'])
const PLAN_SNAPSHOT_TOOLS = new Set(['update_plan'])

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

    if (TODO_SNAPSHOT_TOOLS.has(it.toolName) || PLAN_SNAPSHOT_TOOLS.has(it.toolName)) {
      const isPlan = PLAN_SNAPSHOT_TOOLS.has(it.toolName)
      const rows = records(isPlan ? input.plan : input.todos)
      source = isPlan ? 'plan' : 'todo'
      tasks.clear() // a snapshot IS the board
      rows.forEach((t, i) => {
        const id = `${isPlan ? 'plan' : 'todo'}:${i}`
        const title = str(t.step) ?? str(t.content) ?? str(t.activeForm) ?? `task ${i + 1}`
        const rawStatus = str(t.status) ?? 'pending'
        const status = rawStatus === 'inProgress' ? 'in_progress' : rawStatus
        tasks.set(id, { id, title, status, createdAt: it.ts, updatedAt: it.ts })
      })
      changes.push({ ts: it.ts, kind: 'snapshot' })
      continue
    }

    if (CREATE_TOOLS.has(it.toolName)) {
      const titles = titlesFromCreate(input)
      if (!titles.length) continue
      if (source === 'none') source = 'task'
      // Prefer an id the tool reported back ("Created task #7"); otherwise number them in creation order,
      // which is how these harnesses id them anyway.
      const reported = /#(\d+)/.exec(it.toolResult ?? '')?.[1]
      for (const title of titles) {
        const id = titles.length === 1 && reported ? reported : String(++seq)
        if (reported && titles.length === 1) seq = Math.max(seq, Number(reported))
        tasks.set(id, { id, title, status: 'pending', createdAt: it.ts, updatedAt: it.ts })
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

import { describe, it, expect } from 'vitest'
import { buildTaskBoard, summarizeBoard, type TaskBoardItem } from './taskBoard'

const tool = (toolName: string, toolInput: unknown, over: Partial<TaskBoardItem> = {}): TaskBoardItem => ({
  kind: 'tool',
  ts: '2026-07-25T10:00:00.000Z',
  toolName,
  toolInput,
  ...over,
})

describe('buildTaskBoard — TaskCreate / TaskUpdate (incremental)', () => {
  it('creates tasks and applies a later status update', () => {
    const board = buildTaskBoard([
      tool('TaskCreate', { subject: 'Ship the panel', description: '…' }, { toolResult: 'Created task #1' }),
      tool('TaskCreate', { subject: 'Ship the board' }, { toolResult: 'Created task #2' }),
      tool('TaskUpdate', { taskId: '1', status: 'completed' }, { ts: '2026-07-25T10:05:00.000Z' }),
    ])
    expect(board.source).toBe('task')
    expect(board.tasks.map((t) => `${t.id}:${t.title}:${t.status}`)).toEqual([
      '1:Ship the panel:completed',
      '2:Ship the board:pending',
    ])
    expect(board.tasks[0]!.updatedAt).toBe('2026-07-25T10:05:00.000Z')
  })

  it('accepts a numeric taskId', () => {
    const board = buildTaskBoard([
      tool('TaskCreate', { subject: 'x' }, { toolResult: 'Created task #1' }),
      tool('TaskUpdate', { taskId: 1, status: 'in_progress' }),
    ])
    expect(board.tasks[0]!.status).toBe('in_progress')
  })

  it('numbers tasks in creation order when the tool reports no id', () => {
    const board = buildTaskBoard([tool('TaskCreate', { subject: 'a' }), tool('TaskCreate', { subject: 'b' })])
    expect(board.tasks.map((t) => t.id)).toEqual(['1', '2'])
  })

  it('tolerates a list-shaped create, including a JSON-encoded one', () => {
    const board = buildTaskBoard([tool('TaskCreate', { taskTitles: '["one","two","three"]' })])
    expect(board.tasks.map((t) => t.title)).toEqual(['one', 'two', 'three'])
  })

  it('records history for an update to a task older than the visible history', () => {
    const board = buildTaskBoard([tool('TaskUpdate', { taskId: '99', status: 'completed' })])
    expect(board.tasks).toEqual([])
    expect(board.changes).toEqual([
      { ts: '2026-07-25T10:00:00.000Z', kind: 'updated', taskId: '99', status: 'completed' },
    ])
  })

  it('keeps the full change history behind the board', () => {
    const board = buildTaskBoard([
      tool('TaskCreate', { subject: 'a' }),
      tool('TaskUpdate', { taskId: '1', status: 'in_progress' }),
      tool('TaskUpdate', { taskId: '1', status: 'completed' }),
    ])
    expect(board.changes.map((c) => c.kind)).toEqual(['created', 'updated', 'updated'])
    expect(board.tasks[0]!.status).toBe('completed')
  })
})

describe('buildTaskBoard — TodoWrite (snapshot)', () => {
  it('replaces the whole board on each snapshot', () => {
    const board = buildTaskBoard([
      tool('TodoWrite', { todos: [{ content: 'old one', status: 'completed' }] }),
      tool('TodoWrite', {
        todos: [
          { content: 'first', status: 'completed' },
          { content: 'second', status: 'in_progress' },
        ],
      }),
    ])
    expect(board.source).toBe('todo')
    expect(board.tasks.map((t) => t.title)).toEqual(['first', 'second'])
    expect(board.changes.map((c) => c.kind)).toEqual(['snapshot', 'snapshot'])
  })

  it('lets an empty snapshot clear the board', () => {
    const board = buildTaskBoard([
      tool('TodoWrite', { todos: [{ content: 'keep me', status: 'pending' }] }),
      tool('TodoWrite', { todos: [] }),
    ])
    expect(board.source).toBe('todo')
    expect(board.tasks).toEqual([])
    expect(board.changes.map((c) => c.kind)).toEqual(['snapshot', 'snapshot'])
  })

  it('accepts the JSON-encoded todos snapshot emitted by the live Claude SDK', () => {
    const board = buildTaskBoard([
      tool('TodoWrite', {
        todos:
          '[{"content":"State alpha","status":"completed","activeForm":"Stating alpha"},' +
          '{"content":"State beta","status":"in_progress","activeForm":"Stating beta"}]',
      }),
    ])

    expect(board.source).toBe('todo')
    expect(board.tasks.map((t) => `${t.title}:${t.status}`)).toEqual([
      'State alpha:completed',
      'State beta:in_progress',
    ])
  })
})

describe('buildTaskBoard — Codex update_plan (snapshot)', () => {
  it('replaces the whole board and normalizes Codex statuses', () => {
    const board = buildTaskBoard([
      tool('update_plan', {
        explanation: 'Start the audit',
        plan: [
          { step: 'Inspect package.json', status: 'inProgress' },
          { step: 'Inspect the web package', status: 'pending' },
        ],
      }),
      tool('update_plan', {
        explanation: 'First step finished',
        plan: [
          { step: 'Inspect package.json', status: 'completed' },
          { step: 'Inspect the web package', status: 'inProgress' },
          { step: 'Summarize both findings', status: 'pending' },
        ],
      }),
    ])

    expect(board.source).toBe('plan')
    expect(board.tasks.map((t) => `${t.title}:${t.status}`)).toEqual([
      'Inspect package.json:completed',
      'Inspect the web package:in_progress',
      'Summarize both findings:pending',
    ])
    expect(board.changes.map((c) => c.kind)).toEqual(['snapshot', 'snapshot'])
  })
})

describe('non-task tools + summary', () => {
  it('ignores ordinary tool calls entirely', () => {
    const board = buildTaskBoard([tool('Bash', { command: 'ls' }), tool('Read', { file_path: '/x' })])
    expect(board).toEqual({ tasks: [], changes: [], source: 'none' })
  })

  it('keeps manager assignments on the same board without letting agent snapshots erase them', () => {
    const board = buildTaskBoard([
      tool('ManagerTask', {
        id: 'manager:1',
        title: 'Own parser.ts',
        status: 'in_progress',
        managerSessionId: 'manager',
        managerLabel: 'Curie',
      }),
      tool('update_plan', {
        plan: [{ step: 'Run parser tests', status: 'pending' }],
      }),
    ])
    expect(board.source).toBe('mixed')
    expect(board.tasks).toEqual([
      expect.objectContaining({
        id: 'manager:1',
        title: 'Own parser.ts',
        origin: 'manager',
        assignedByLabel: 'Curie',
      }),
      expect.objectContaining({ title: 'Run parser tests', origin: 'agent' }),
    ])
  })

  it('summarizes for the collapsed strip', () => {
    const board = buildTaskBoard([
      tool('TodoWrite', {
        todos: [
          { content: 'a', status: 'completed' },
          { content: 'b', status: 'in_progress' },
          { content: 'c', status: 'pending' },
          { content: 'd', status: 'pending' },
        ],
      }),
    ])
    expect(summarizeBoard(board)).toEqual({ total: 4, done: 1, active: 1, pending: 2 })
  })
})

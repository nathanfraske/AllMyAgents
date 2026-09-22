import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { Journal } from './journal.js'
import { readTaskBoardEvents } from './journalTasks.js'
import { buildTaskBoard, taskBoardItemsFromEvents } from './taskBoard.js'

it('recovers complete task state across restart and partial index backfill, hydrating only task blocks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-task-projection-'))
  const file = path.join(root, 'journal.db')
  let journal = new Journal(file)
  try {
    journal.append('s', 'claude/assistant', { message: { content: [
      { type: 'text', text: 'unrelated '.repeat(100_000) },
      { type: 'tool_use', id: 'create', name: 'TaskCreate', input: { subject: 'Durable vendor task' } },
      { type: 'tool_use', id: 'shell', name: 'Bash', input: { command: 'not a task' } },
    ] } })
    journal.append('s', 'claude/user', { message: { content: [
      { type: 'tool_result', tool_use_id: 'shell', content: 'huge output '.repeat(100_000) },
      { type: 'tool_result', tool_use_id: 'create', content: 'Created task #7' },
    ] } })
    journal.append('s', 'claude/assistant', { message: { content: [
      { type: 'tool_use', id: 'update', name: 'TaskUpdate', input: { taskId: '7', status: 'completed' } },
    ] } })
    journal.append('s', 'manager/task-assigned', { id: 'manager:m', title: 'Manager task', managerSessionId: 'manager' })
    journal.append('other', 'manager/task-assigned', { id: 'manager:hidden', title: 'Other project' })
    journal.append('s', 'claude/user', { message: { content: 'Ordinary operator input is not a task block' } })
    journal.append('s', 'claude/assistant', { message: { content: [null, 'odd block', 17] } })
    const decode = vi.fn((payload: string) => JSON.parse(payload))
    expect(readTaskBoardEvents(journal.db, 's', decode)).toHaveLength(4)
    expect(decode.mock.calls.every(([payload]) => payload.length < 500)).toBe(true)
    const expected = buildTaskBoard(taskBoardItemsFromEvents(journal.taskBoardEventsForSession('s')))
    expect(expected.tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: '7', status: 'completed' }),
      expect.objectContaining({ id: 'manager:m', origin: 'manager' }),
    ]))
    journal.db.close()
    journal = new Journal(file)
    // Simulate a legacy journal whose ordinary post-ready session-index backfill has not completed.
    journal.db.exec('DELETE FROM journal_session_event_index; UPDATE journal_session_index_state SET scanned_through = 0')
    expect(buildTaskBoard(taskBoardItemsFromEvents(journal.taskBoardEventsForSession('s')))).toEqual(expected)
    while (!journal.backfillSessionEventIndex(2).complete) { /* small, resumable batches */ }
    expect(buildTaskBoard(taskBoardItemsFromEvents(journal.taskBoardEventsForSession('s')))).toEqual(expected)
  } finally {
    journal.db.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

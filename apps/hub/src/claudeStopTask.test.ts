import { describe, expect, it, vi } from 'vitest'
import { ClaudeDriver } from './adapters/claude.js'

describe('Claude sub-agent stop', () => {
  it('uses the SDK task control without interrupting the parent query', async () => {
    const driver = new ClaudeDriver('unused', 'C:/work', vi.fn())
    const query = { stopTask: vi.fn().mockResolvedValue(undefined), interrupt: vi.fn() }
    ;(
      driver as unknown as {
        active: { query: typeof query; input: object }
      }
    ).active = { query, input: {} }

    await (driver as unknown as { stopTask(taskId: string): Promise<void> }).stopTask('task-1')

    expect(query.stopTask).toHaveBeenCalledWith('task-1')
    expect(query.interrupt).not.toHaveBeenCalled()
  })
})

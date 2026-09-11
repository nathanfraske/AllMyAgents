import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexClient } from './adapters/codex.js'

afterEach(() => vi.useRealTimers())

describe('native goal waiting without model polling', () => {
  it('parks an active goal with a status-only update, preserving unfinished work and its accounting', async () => {
    const events = vi.fn()
    const client = new CodexClient('unused', events)
    const goal = { status: 'active', objective: 'Finish integration', tokenBudget: 50000, tokensUsed: 1234, timeUsedSeconds: 80 }
    const before = { ...goal }
    const request = vi.spyOn(client, 'request').mockImplementation(async (method, params) => {
      if (method === 'thread/goal/get') return { goal: { ...goal } }
      if (method === 'thread/goal/set') { Object.assign(goal, params); return { goal: { ...goal } } }
      return {}
    })
    await client.pauseAutonomousGoal('thread-1')
    expect(request.mock.calls).toEqual([
      ['thread/goal/get', { threadId: 'thread-1' }, 5000],
      ['thread/goal/set', { threadId: 'thread-1', status: 'paused' }, 5000],
    ])
    expect(goal).toMatchObject({ ...before, status: 'paused' })
    expect(events).toHaveBeenCalledWith('codex/goal-wait-paused', { threadId: 'thread-1', status: 'paused' })
    // A real completion notice remains a legitimate explicit turn; never reactivate a goal behind
    // the operator's back or replace the unfinished objective to manufacture completion.
    await client.sendTurn('thread-1', 'Durable run succeeded. Inspect the result and continue.')
    expect(request).toHaveBeenLastCalledWith('turn/start', expect.objectContaining({ threadId: 'thread-1' }))
    expect(goal.status).toBe('paused')
    await client.pauseAutonomousGoal('thread-1')
    expect(request.mock.calls.filter(([method]) => method === 'thread/goal/set')).toHaveLength(1)
    expect(request.mock.calls.some(([method]) => /interrupt|clear/.test(method))).toBe(false)
  })

  it.each([null, 'paused', 'blocked', 'complete', 'usageLimited', 'budgetLimited'])('leaves non-active goal %s unchanged', async status => {
    const client = new CodexClient('unused', vi.fn())
    const request = vi.spyOn(client, 'request').mockResolvedValue({ goal: status === null ? null : { status } })
    await client.pauseAutonomousGoal('thread-1')
    expect(request).toHaveBeenCalledTimes(1)
  })

  it.each([undefined, {}, { goal: {} }, { goal: { status: 'new-provider-state' } }])('rejects unobservable state instead of claiming to wait: %j', async result => {
    const client = new CodexClient('unused', vi.fn())
    vi.spyOn(client, 'request').mockResolvedValue(result)
    await expect(client.pauseAutonomousGoal('thread-1')).rejects.toThrow('unavailable')
  })

  it('does not confirm parking when the vendor rejects or fails to acknowledge the update', async () => {
    const events = vi.fn()
    const client = new CodexClient('unused', events)
    vi.spyOn(client, 'request').mockResolvedValueOnce({ goal: { status: 'active' } }).mockResolvedValueOnce({ goal: { status: 'active' } })
    await expect(client.pauseAutonomousGoal('thread-1')).rejects.toThrow('not confirmed')
    expect(events).not.toHaveBeenCalled()
  })

  it('bounds an unanswered native request and removes its pending entry', async () => {
    vi.useFakeTimers()
    const client = new CodexClient('unused', vi.fn())
    const pending = client.pauseAutonomousGoal('thread-1')
    const rejected = expect(pending).rejects.toThrow('do not assume the operation failed or retry blindly')
    await vi.advanceTimersByTimeAsync(5000)
    await rejected
    expect((client as unknown as { pending: Map<number, unknown> }).pending.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})

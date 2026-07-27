import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import AgentPanel from './AgentPanel.svelte'
import type { ThreadItem } from './store.svelte'
import { saveOpenAgentPanels } from './uiState'

const apiMock = vi.hoisted(() => ({
  interruptAgent: vi.fn(),
}))

vi.mock('./api', async (orig) => {
  const actual = await orig<typeof import('./api')>()
  return { ...actual, api: { ...actual.api, ...apiMock } }
})

function spawn(outcome?: 'completed' | 'failed' | 'stopped'): ThreadItem[] {
  return [
    {
      key: 'tool:spawn-1',
      kind: 'tool',
      ts: '2026-07-27T00:00:00.000Z',
      toolName: 'Agent',
      toolUseId: 'spawn-1',
      toolInput: { description: 'slow audit', subagent_type: 'Explore' },
      agentTaskId: 'task-1',
      agentOutcome: outcome,
      agentOutcomeTs: outcome ? '2026-07-27T00:00:05.000Z' : undefined,
    },
  ]
}

beforeEach(() => {
  localStorage.clear()
  saveOpenAgentPanels(['s1'])
  apiMock.interruptAgent.mockReset()
})
afterEach(() => cleanup())

describe('per-sub-agent stop', () => {
  it('stops only the selected Claude task and reports the terminal outcome as stopped, not done', async () => {
    apiMock.interruptAgent.mockResolvedValue({ ok: true })
    const view = render(AgentPanel, {
      props: { items: spawn(), sessionId: 's1', provider: 'claude' },
    })

    await fireEvent.click(screen.getByTitle('Stop slow audit'))
    expect(apiMock.interruptAgent).toHaveBeenCalledWith('s1', 'task-1', 'slow audit')

    await view.rerender({ items: spawn('stopped'), sessionId: 's1', provider: 'claude' })
    expect(screen.getByText('stopped')).toBeTruthy()
    expect(screen.queryByText('done')).toBeNull()
  })
})

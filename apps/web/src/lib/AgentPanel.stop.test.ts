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

function nestedSpawn(): ThreadItem[] {
  return [
    {
      key: 'tool:parent',
      kind: 'tool',
      ts: '2026-07-27T00:00:00.000Z',
      toolName: 'Agent',
      toolUseId: 'parent',
      toolInput: { description: 'parent audit' },
    },
    {
      key: 'tool:child',
      kind: 'tool',
      ts: '2026-07-27T00:00:01.000Z',
      toolName: 'Agent',
      toolUseId: 'child',
      agentId: 'parent',
      toolInput: { description: 'nested verifier' },
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

  it('labels a nested worker with the worker that spawned it', () => {
    const { container } = render(AgentPanel, {
      props: { items: nestedSpawn(), sessionId: 's1', provider: 'codex' },
    })

    const lineage = (container as HTMLElement).querySelector('[title="Spawned by parent audit"]')
    expect(lineage?.textContent).toMatch(/under\s*parent audit/i)
    expect(lineage?.closest('.run')?.classList.contains('nested')).toBe(true)
  })
})

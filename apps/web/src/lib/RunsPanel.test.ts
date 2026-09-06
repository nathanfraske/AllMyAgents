import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import RunsPanel from './RunsPanel.svelte'
import { api, type DurableRunInfo } from './api'
import { store } from './store.svelte'

vi.mock('./api', async (original) => {
  const actual = await original<typeof import('./api')>()
  return { ...actual, api: { ...actual.api, durableRuns: vi.fn(), durableRun: vi.fn() } }
})

function run(id: string, projectId: string, actorLabel: string, state: DurableRunInfo['state'] = 'running'): DurableRunInfo {
  return {
    id, projectId, actorLabel, actorSessionId: `actor-${id}`, sessionId: `actor-${id}`, targetSessionId: `actor-${id}`,
    kind: 'build', state, executionTarget: { kind: 'local' }, commandSummary: `build ${id}`,
    createdAt: new Date().toISOString(), timeoutMs: 3_600_000, stdoutBytes: 0, stderrBytes: 0, logsTruncated: false,
  }
}

beforeEach(() => {
  vi.mocked(api.durableRuns).mockReset()
  vi.mocked(api.durableRun).mockReset().mockResolvedValue({ ok: true, runs: [], logs: {
    stdout: 'Retained output', stderr: '', nextStdoutCursor: 15, nextStderrCursor: 0, stdoutComplete: true, stderrComplete: true,
  } })
  store.projects = [{ id: 'p-a', name: 'Alpha' }, { id: 'p-b', name: 'Beta' }] as typeof store.projects
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('durable run panel', () => {
  it('keeps active work grouped by project and attributed to its actor, with completed work collapsed', async () => {
    const live = [run('a', 'p-a', 'Allen'), run('b', 'p-b', 'Euler'), run('c', 'p-a', 'Hoare')]
    const completed = run('old', 'p-b', 'Noether', 'succeeded')
    vi.mocked(api.durableRuns).mockImplementation(async (_id, options) => ({ ok: true,
      runs: options?.states?.includes('running') ? live : [completed] }))
    const rendered = render(RunsPanel, { props: { sessionId: 'overseer', open: true } })
    const alpha = await rendered.findByRole('region', { name: 'Alpha' })
    const beta = rendered.getByRole('region', { name: 'Beta' })
    expect(within(alpha).getByText('build a')).toBeTruthy()
    expect(within(alpha).getByText('build c')).toBeTruthy()
    expect(within(alpha).getByText('Allen · local')).toBeTruthy()
    expect(within(alpha).queryByText('build b')).toBeNull()
    expect(within(beta).getByText('Euler · local')).toBeTruthy()
    expect(rendered.queryByText('build old')).toBeNull()
    await fireEvent.click(rendered.getByRole('button', { name: 'Completed · 1' }))
    expect(rendered.getByText('Beta · Noether')).toBeTruthy()
    await fireEvent.click(within(alpha).getByRole('button', { name: /build a/ }))
    expect(await rendered.findByText('Retained output')).toBeTruthy()
    expect(api.durableRuns).toHaveBeenCalledWith('overseer', { states: ['queued', 'running'], limit: 200 })
  })

  it('shows only the active count on its compact tab and terminal state wins overlapping snapshots', async () => {
    vi.mocked(api.durableRuns).mockImplementation(async (_id, options) => ({ ok: true,
      runs: options?.states?.includes('running') ? [run('a', 'p-a', 'Allen'), run('b', 'p-b', 'Euler')]
        : [run('a', 'p-a', 'Allen', 'succeeded')] }))
    const count = vi.fn()
    const rendered = render(RunsPanel, { props: { sessionId: 'overseer', onactivecount: count } })
    await waitFor(() => expect(count).toHaveBeenLastCalledWith(1))
    expect(rendered.getByRole('button', { name: 'Open project runs' }).textContent?.trim()).toBe('1')
  })
})

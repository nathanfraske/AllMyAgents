import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import TaskStrip from './TaskStrip.svelte'
import { api } from './api'
import type { TaskBoardItem } from './taskBoard'

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const item = (toolName: string, toolInput: unknown, ts = '2026-07-27T12:00:00.000Z'): TaskBoardItem => ({
  kind: 'tool',
  ts,
  toolName,
  toolInput,
})

describe('TaskStrip vendor plans', () => {
  it('shows host execution outcomes and their exact completion evidence independently of provider checklists', async () => {
    render(TaskStrip, { items: [item('WorkPlan', { revision: 2, steps: [{ id: 'work:1', title: 'Requested outcome',
      status: 'completed', doneWhen: 'Exact regression passes', evidence: 'run-123 passed' }] }), item('update_plan', { plan: [] })] })
    await fireEvent.click(screen.getByRole('button', { name: /Tasks/ }))
    expect(screen.getByText('execution task')).toBeTruthy()
    expect(screen.getByText('Requested outcome').getAttribute('title')).toBe('Done when: Exact regression passes\nEvidence: run-123 passed')
  })

  it('states that an empty board means no tasks were reported', async () => {
    render(TaskStrip, { props: { items: [] } })
    expect(screen.getByText('No tasks reported')).toBeTruthy()
    await fireEvent.click(screen.getByRole('button', { name: /Tasks/ }))
    expect(screen.getByText(/does not mean the agent has no work/)).toBeTruthy()
  })

  it('labels manager assignments separately from agent-reported work', async () => {
    render(TaskStrip, {
      props: {
        items: [
          item('ManagerTask', {
            id: 'manager:1',
            title: 'Own parser.ts',
            status: 'pending',
            managerSessionId: 'manager',
            managerLabel: 'Curie',
          }),
          item('TaskCreate', { subject: 'Run tests' }),
        ],
      },
    })
    await fireEvent.click(screen.getByRole('button', { name: /Tasks/ }))
    expect(screen.getByText('manager assigned')).toBeTruthy()
    expect(screen.getByText('agent reported')).toBeTruthy()
  })

  it('updates from Codex snapshots and reconstructs the latest board after a fresh render', async () => {
    const first = item('update_plan', {
      plan: [
        { step: 'State alpha', status: 'inProgress' },
        { step: 'State beta', status: 'pending' },
      ],
    })
    const finished = item(
      'update_plan',
      {
        plan: [
          { step: 'State alpha', status: 'completed' },
          { step: 'State beta', status: 'completed' },
        ],
      },
      '2026-07-27T12:01:00.000Z',
    )
    const view = render(TaskStrip, { props: { items: [first] } })
    expect(screen.getByText(/0\/2 done/)).toBeTruthy()

    await view.rerender({ items: [first, finished] })
    expect(screen.getByText(/2\/2 done/)).toBeTruthy()
    cleanup()

    render(TaskStrip, { props: { items: [first, finished] } })
    expect(screen.getByText(/2\/2 done/)).toBeTruthy()
    await fireEvent.click(screen.getByRole('button', { name: /Tasks/ }))
    expect(screen.getByText('State alpha')).toBeTruthy()
    expect(screen.getByText('State beta')).toBeTruthy()
  })

  it('renders the JSON-encoded TodoWrite snapshot from Claude', async () => {
    render(TaskStrip, {
      props: {
        items: [
          item('TodoWrite', {
            todos:
              '[{"content":"State alpha","status":"completed"},' +
              '{"content":"State beta","status":"in_progress"}]',
          }),
        ],
      },
    })

    expect(screen.getByText(/1\/2 done/)).toBeTruthy()
    await fireEvent.click(screen.getByRole('button', { name: /Tasks/ }))
    expect(screen.getByText('State beta')).toBeTruthy()
    expect(screen.getByText('in progress')).toBeTruthy()
  })
})

it('retains earlier completion evidence when a later plan replaces completed steps', async () => {
  render(TaskStrip, { items: [
    { kind: 'tool', toolName: 'update_plan', ts: '2026-09-28T00:00:00Z', toolInput: { plan: [{ step: 'Verify parser', status: 'completed' }] } },
    { kind: 'tool', toolName: 'update_plan', ts: '2026-09-28T00:01:00Z', toolInput: { plan: [{ step: 'Report result', status: 'pending' }] } },
  ] })
  await fireEvent.click(screen.getByText('Tasks'))
  await fireEvent.click(screen.getByText(/show history/))
  expect(screen.getByLabelText('Earlier completion reports').textContent).toContain('Verify parser')
  expect(screen.getByText('Report result')).toBeTruthy()
  expect(screen.getByText(/not independent verification/)).toBeTruthy()
})

it('pins operator amendments to the displayed assignment revision and does not automatically retry a stale change', async () => {
  const amend = vi.spyOn(api, 'amendTask').mockResolvedValueOnce({ error: 'Stale task revision' }).mockResolvedValue({ ok: true })
  render(TaskStrip, { sessionId: 'child', items: [{ kind: 'tool', toolName: 'ManagerTask', ts: '2026-09-28T00:00:00Z',
    toolInput: { id: 'manager:1', title: 'Fix parser', status: 'completed', managerSessionId: 'manager', revision: 2 } }] })
  await fireEvent.click(screen.getByText('Tasks'))
  await fireEvent.click(screen.getByText('Revise assignment'))
  expect((screen.getByText('Save revision') as HTMLButtonElement).disabled).toBe(true)
  await fireEvent.input(screen.getByLabelText('Amendment reason'), { target: { value: 'New parser failure' } })
  await fireEvent.change(screen.getByLabelText('Assignment status'), { target: { value: 'pending' } })
  await fireEvent.click(screen.getByText('Save revision'))
  expect(amend).toHaveBeenCalledTimes(1)
  expect(amend).toHaveBeenCalledWith('child', { taskId: 'manager:1', expectedRevision: 2, title: 'Fix parser', status: 'pending', changeReason: 'New parser failure' })
  expect(screen.getByRole('alert').textContent).toContain('Stale')
  await fireEvent.click(screen.getByText('Cancel'))
  expect(amend).toHaveBeenCalledTimes(1)
})

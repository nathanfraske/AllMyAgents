import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import TaskStrip from './TaskStrip.svelte'
import type { TaskBoardItem } from './taskBoard'

afterEach(cleanup)

const item = (toolName: string, toolInput: unknown, ts = '2026-07-27T12:00:00.000Z'): TaskBoardItem => ({
  kind: 'tool',
  ts,
  toolName,
  toolInput,
})

describe('TaskStrip vendor plans', () => {
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

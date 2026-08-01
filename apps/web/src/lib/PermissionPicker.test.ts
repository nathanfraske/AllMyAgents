import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import PermissionPicker from './PermissionPicker.svelte'

const apiMock = vi.hoisted(() => ({ setMode: vi.fn(), allowTool: vi.fn() }))

vi.mock('./api', async (original) => {
  const actual = await original<typeof import('./api')>()
  return { ...actual, api: { ...actual.api, ...apiMock } }
})

beforeEach(() => {
  apiMock.setMode.mockReset().mockResolvedValue({ ok: true })
  apiMock.allowTool.mockReset().mockResolvedValue({ ok: true })
})

afterEach(cleanup)

describe('managed permission boundaries', () => {
  it('explains a child ceiling and makes crossing it an explicit operator override', async () => {
    const onchange = vi.fn()
    render(PermissionPicker, {
      props: {
        sessionId: 'child',
        mode: 'safe',
        ceiling: 'safe',
        managedScope: 'child',
        managedBy: 'Noether',
        onchange,
      },
    })

    await fireEvent.click(screen.getByTitle('Permission mode: Safe'))
    expect(screen.getByText(/Noether may set this child up to safe/i)).toBeTruthy()

    await fireEvent.click(screen.getByRole('button', { name: 'Override permission to Full access as operator' }))
    expect(apiMock.setMode).toHaveBeenCalledWith('child', 'full', true)
    expect(onchange).toHaveBeenCalledWith('full', true)
  })

  it('keeps a rejected override open and reports why it had no effect', async () => {
    apiMock.setMode.mockResolvedValue({ error: 'operator device token required' })
    render(PermissionPicker, {
      props: {
        sessionId: 'manager',
        mode: 'safe',
        ceiling: 'safe',
        managedScope: 'manager',
      },
    })

    await fireEvent.click(screen.getByTitle('Permission mode: Safe'))
    await fireEvent.click(screen.getByRole('button', { name: 'Override permission to Edits as operator' }))

    expect((await screen.findByRole('alert')).textContent).toContain(
      'Permission change failed: operator device token required',
    )
    expect(screen.getByText(/reusable operator grant is capped at safe/i)).toBeTruthy()
  })

  it('explains that a per-child operator ceiling is reusable only by that child manager', async () => {
    render(PermissionPicker, {
      props: {
        sessionId: 'child',
        mode: 'edits',
        ceiling: 'safe',
        managedScope: 'child',
        managedBy: 'Noether',
        operatorOverrideActive: true,
        operatorOverrideCeiling: 'full',
      },
    })

    await fireEvent.click(screen.getByTitle('Permission mode: Edits · operator override'))
    expect(screen.getByText(/explicitly extended this child to full/i)).toBeTruthy()
    expect(screen.getByText(/sibling grants are unchanged/i)).toBeTruthy()
  })
})

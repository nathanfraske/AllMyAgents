import { cleanup, fireEvent, render } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import PairingCodeInput from './PairingCodeInput.svelte'

afterEach(() => cleanup())

describe('PairingCodeInput', () => {
  it('renders eight accessible cells with the separator supplied by the control', () => {
    const { getAllByRole, container } = render(PairingCodeInput, { value: '' })
    expect(getAllByRole('textbox')).toHaveLength(8)
    expect(container.textContent).toContain('–')
  })

  it('uppercases valid characters, advances focus, and emits XXXX-XXXX', async () => {
    const changed = vi.fn()
    const { getAllByRole } = render(PairingCodeInput, { value: '', onchange: changed })
    const cells = getAllByRole('textbox') as HTMLInputElement[]

    await fireEvent.input(cells[0]!, { target: { value: 'a' } })
    expect(changed).toHaveBeenLastCalledWith('A')
    expect(document.activeElement).toBe(cells[1])

    await fireEvent.paste(cells[1]!, { clipboardData: { getData: () => 'bcd-efgh' } })
    expect(changed).toHaveBeenLastCalledWith('ABCD-EFGH')
  })

  it('pasting a complete code fills from the first cell and backspace walks backward', async () => {
    const changed = vi.fn()
    const view = render(PairingCodeInput, { value: '', onchange: changed })
    const cells = view.getAllByRole('textbox') as HTMLInputElement[]

    await fireEvent.paste(cells[5]!, { clipboardData: { getData: () => '2345-6789' } })
    expect(changed).toHaveBeenLastCalledWith('2345-6789')
    await view.rerender({ value: '2345-6789', onchange: changed })
    cells[7]!.focus()
    await fireEvent.keyDown(cells[7]!, { key: 'Backspace' })
    expect(changed).toHaveBeenLastCalledWith('2345-678')
  })

  it('submits on Enter only after all eight characters are present', async () => {
    const enter = vi.fn()
    const view = render(PairingCodeInput, { value: 'ABCD-EFG', onenter: enter })
    const cells = view.getAllByRole('textbox') as HTMLInputElement[]
    await fireEvent.keyDown(cells[7]!, { key: 'Enter' })
    expect(enter).not.toHaveBeenCalled()
    await view.rerender({ value: 'ABCD-EFGH', onenter: enter })
    await fireEvent.keyDown(cells[7]!, { key: 'Enter' })
    expect(enter).toHaveBeenCalledOnce()
  })
})

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import OverseerUiGuide from './OverseerUiGuide.svelte'

afterEach(() => cleanup())

describe('Overseer UI guide', () => {
  it('spotlights an allowlisted app anchor and remains dismissible', async () => {
    const anchor = document.createElement('button')
    anchor.dataset.overseerAnchor = 'accounts'
    anchor.getBoundingClientRect = vi.fn(() => ({
      x: 20, y: 30, width: 120, height: 40, top: 30, right: 140, bottom: 70, left: 20,
      toJSON: () => ({}),
    }))
    document.body.append(anchor)
    const ondismiss = vi.fn()

    const view = render(OverseerUiGuide, {
      props: {
        guide: { target: 'accounts', message: 'Sign in or re-authenticate here.', seq: 7 },
        ondismiss,
      },
    })

    expect(screen.getByText('Sign in or re-authenticate here.')).toBeTruthy()
    await fireEvent.click(screen.getByRole('button', { name: 'Dismiss Overseer guide' }))
    expect(ondismiss).toHaveBeenCalledOnce()
    anchor.remove()
    view.unmount()
  })
})

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import AgentPurposeInfo from './AgentPurposeInfo.svelte'

afterEach(cleanup)

describe('AgentPurposeInfo', () => {
  it('exposes the full purpose on hover/focus metadata and toggles a click popout', async () => {
    render(AgentPurposeInfo, {
      props: { agentName: 'Bose', purpose: 'Audit concurrency and reproduce races.' },
    })

    const trigger = screen.getByRole('button', {
      name: 'Bose purpose: Audit concurrency and reproduce races.',
    })
    expect(trigger.getAttribute('title')).toBe('Purpose: Audit concurrency and reproduce races.')
    expect(trigger.getAttribute('data-purpose')).toBe('Audit concurrency and reproduce races.')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('note')).toBeNull()

    await fireEvent.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('note').textContent).toMatch(/Purpose.*Audit concurrency and reproduce races\./u)

    await fireEvent.blur(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('note')).toBeNull()

    await fireEvent.click(trigger)

    await fireEvent.keyDown(trigger, { key: 'Escape' })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('note')).toBeNull()
  })
})

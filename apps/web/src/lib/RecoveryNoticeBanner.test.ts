// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tick } from 'svelte'
import RecoveryNoticeBanner from './RecoveryNoticeBanner.svelte'
import { store } from './store.svelte'

const notice = {
  planId: '11111111-1111-4111-8111-111111111111',
  generation: '7',
  snapshotMaxSeq: '420',
  snapshotEventHighWater: '425',
  quarantineDir: 'C:\\data\\journal-recovery\\quarantine\\11111111-1111-4111-8111-111111111111',
  recordedAt: '2026-07-29T00:00:00.000Z',
}

beforeEach(() => {
  store.recoveryNotices = [notice]
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  store.recoveryNotices = []
})

describe('RecoveryNoticeBanner', () => {
  it('renders bounded truthful recovery evidence with one polite status and a unique keyboard button', () => {
    render(RecoveryNoticeBanner)

    expect(screen.getAllByRole('status')).toHaveLength(1)
    expect(screen.getByText(/post-snapshot tail outcome unknown/i)).toBeTruthy()
    expect(screen.getByText(/no lost-row count is inferred/i)).toBeTruthy()
    expect(screen.getByText(notice.quarantineDir)).toBeTruthy()
    const button = screen.getByRole('button', {
      name: /dismiss recovery generation 7, incident 11111111/i,
    })
    expect(button.getAttribute('type')).toBe('button')
    expect(button.hasAttribute('disabled')).toBe(false)
  })

  it('keeps the notice visible and reports a scoped error when dismissal is not confirmed', async () => {
    vi.spyOn(store, 'dismissRecoveryNotice').mockResolvedValue(false)
    render(RecoveryNoticeBanner)

    await fireEvent.click(screen.getByRole('button'))

    expect(screen.getByText(/was not dismissed/i)).toBeTruthy()
    expect(screen.getByText(/post-snapshot tail outcome unknown/i)).toBeTruthy()
    expect(store.recoveryNotices).toEqual([notice])
  })

  it('removes the notice only after a confirmed dismissal', async () => {
    vi.spyOn(store, 'dismissRecoveryNotice').mockImplementation(async (planId) => {
      store.recoveryNotices = store.recoveryNotices.filter((item) => item.planId !== planId)
      return true
    })
    render(RecoveryNoticeBanner)

    await fireEvent.click(screen.getByRole('button'))

    expect(screen.queryByText(/post-snapshot tail outcome unknown/i)).toBeNull()
  })

  it('keeps the notice visible when dismissal transport rejects', async () => {
    vi.spyOn(store, 'dismissRecoveryNotice').mockRejectedValue(new Error('offline'))
    render(RecoveryNoticeBanner)

    await fireEvent.click(screen.getByRole('button'))

    expect(screen.getByText(/was not dismissed/i)).toBeTruthy()
    expect(screen.getByText(/post-snapshot tail outcome unknown/i)).toBeTruthy()
  })

  it('mutates the one live-region child for a same-count replacement incident', async () => {
    render(RecoveryNoticeBanner)
    await tick()
    const status = screen.getByRole('status')
    const firstChild = status.firstElementChild

    store.recoveryNotices = [
      {
        ...notice,
        planId: '22222222-2222-4222-8222-222222222222',
        generation: '8',
      },
    ]
    await tick()

    expect(screen.getAllByRole('status')).toHaveLength(1)
    expect(status.firstElementChild).not.toBe(firstChild)
    expect(status.textContent).toMatch(/new journal recovery notice/i)
  })
})

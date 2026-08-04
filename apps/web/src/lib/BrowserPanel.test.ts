import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import BrowserPanel from './BrowserPanel.svelte'
import { api } from './api'

vi.mock('./api', () => ({
  api: {
    browserStatus: vi.fn(async () => ({
      enabled: false,
      available: true,
      retainedProfile: false,
      publicOriginGrants: [],
      localNetworkEnabled: false,
      tabsEnabled: false,
      downloadsEnabled: false,
    })),
    setBrowserEnabled: vi.fn(async () => ({
      enabled: true,
      available: true,
      retainedProfile: false,
      publicOriginGrants: [],
      localNetworkEnabled: false,
      tabsEnabled: false,
      downloadsEnabled: false,
    })),
    showBrowser: vi.fn(async () => ({ ok: true })),
    clearBrowser: vi.fn(async () => ({ ok: true })),
    setBrowserLocalNetwork: vi.fn(),
    setBrowserTabs: vi.fn(),
    setBrowserDownloads: vi.fn(),
    revokeBrowserOrigin: vi.fn(),
  },
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('BrowserPanel', () => {
  it('uses a compact icon tab whose state label is available on hover and focus', () => {
    const { container } = render(BrowserPanel, {
      props: {
        sessionId: 'session-a',
        agentLabel: 'Hopper',
        open: false,
      },
    })

    expect(screen.getByRole('button', { name: 'Browser off' })).toBeTruthy()
    expect(container.querySelector('.tab-icon')).toBeTruthy()
    expect(container.querySelector('.tab-label')?.textContent).toBe('Browser off')
  })

  it('provides the browser capability and native-window actions inside the side popout', async () => {
    render(BrowserPanel, {
      props: {
        sessionId: 'session-a',
        agentLabel: 'Hopper',
        open: true,
      },
    })

    expect(screen.getByRole('complementary', { name: 'Browser' })).toBeTruthy()
    await fireEvent.click(screen.getByText('Off for this chat'))
    expect(api.setBrowserEnabled).toHaveBeenCalledWith('session-a', true)
    expect(await screen.findByText('Show browser window')).toBeTruthy()

    await fireEvent.click(screen.getByText('Show browser window'))
    expect(api.showBrowser).toHaveBeenCalledWith('session-a')
  })
})

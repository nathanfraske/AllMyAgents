import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import BrowserPicker from './BrowserPicker.svelte'
import { api } from './api'

vi.mock('./api', () => ({
  api: {
    browserStatus: vi.fn(async () => ({
      enabled: false,
      available: false,
      reason: 'Browser unavailable: this hub was started without an authenticated desktop browser broker.',
      retainedProfile: false,
      publicOriginGrants: [],
      localNetworkEnabled: false,
      tabsEnabled: false,
      downloadsEnabled: false,
    })),
    setBrowserEnabled: vi.fn(async (_id: string, enabled: boolean) => ({
      enabled,
      available: false,
      reason: 'Browser unavailable: this hub was started without an authenticated desktop browser broker.',
      retainedProfile: false,
      publicOriginGrants: [],
      localNetworkEnabled: false,
      tabsEnabled: false,
      downloadsEnabled: false,
    })),
    setBrowserLocalNetwork: vi.fn(async () => ({
      enabled: true, available: true, retainedProfile: true, publicOriginGrants: [], localNetworkEnabled: true, tabsEnabled: false, downloadsEnabled: false,
    })),
    setBrowserTabs: vi.fn(async () => ({
      enabled: true, available: true, retainedProfile: true, publicOriginGrants: [], localNetworkEnabled: false, tabsEnabled: true, downloadsEnabled: false,
    })),
    setBrowserDownloads: vi.fn(async () => ({
      enabled: true, available: true, retainedProfile: true, publicOriginGrants: [], localNetworkEnabled: false, tabsEnabled: false, downloadsEnabled: true,
    })),
    revokeBrowserOrigin: vi.fn(async () => ({
      enabled: true, available: true, retainedProfile: true, publicOriginGrants: [], localNetworkEnabled: false, tabsEnabled: false, downloadsEnabled: false,
    })),
    showBrowser: vi.fn(async () => ({ ok: true })),
    clearBrowser: vi.fn(async () => ({ ok: true })),
  },
}))

afterEach(() => cleanup())

describe('BrowserPicker', () => {
  it('is visibly off by default and shows the complete sign-in warning before enablement', async () => {
    render(BrowserPicker, {
      props: {
        sessionId: 'session-a',
        agentLabel: 'Hopper',
      },
    })

    expect(screen.getByText('Browser off')).toBeTruthy()
    const trigger = screen.getByRole('button', { name: 'Browser off' })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    await fireEvent.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(document.body.textContent).toContain(
      'This browser belongs only to Hopper. It does not use your normal browser logins. If you sign in here, this agent can read pages available to that signed-in session until you clear its browser data.',
    )
    expect(document.body.textContent).toContain(
      'Browser unavailable: this hub was started without an authenticated desktop browser broker.',
    )
  })

  it('keeps tabs and downloads as separate per-chat grants', async () => {
    render(BrowserPicker, {
      props: {
        sessionId: 'session-a',
        agentLabel: 'Hopper',
      },
    })

    await fireEvent.click(screen.getByTitle('Browser off for this chat'))
    await fireEvent.click(screen.getByText('Off for this chat'))
    const tabs = screen.getByText('Additional tabs').closest('button')
    const downloads = screen.getByText('Downloads').closest('button')
    expect(tabs).toBeTruthy()
    expect(downloads).toBeTruthy()
    await fireEvent.click(tabs!)
    await fireEvent.click(downloads!)
    expect(api.setBrowserTabs).toHaveBeenCalledWith('session-a', true)
    expect(api.setBrowserDownloads).toHaveBeenCalledWith('session-a', true)
  })
})

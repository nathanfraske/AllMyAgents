import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import BrowserPicker from './BrowserPicker.svelte'

vi.mock('./api', () => ({
  api: {
    browserStatus: vi.fn(async () => ({
      enabled: false,
      available: false,
      reason: 'Browser unavailable: this hub was started without an authenticated desktop browser broker.',
      retainedProfile: false,
      publicOriginGrants: [],
      localNetworkEnabled: false,
    })),
    setBrowserEnabled: vi.fn(async (_id: string, enabled: boolean) => ({
      enabled,
      available: false,
      reason: 'Browser unavailable: this hub was started without an authenticated desktop browser broker.',
      retainedProfile: false,
      publicOriginGrants: [],
      localNetworkEnabled: false,
    })),
    setBrowserLocalNetwork: vi.fn(async () => ({
      enabled: true, available: true, retainedProfile: true, publicOriginGrants: [], localNetworkEnabled: true,
    })),
    revokeBrowserOrigin: vi.fn(async () => ({
      enabled: true, available: true, retainedProfile: true, publicOriginGrants: [], localNetworkEnabled: false,
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
    await fireEvent.click(screen.getByTitle('Browser off for this chat'))
    expect(document.body.textContent).toContain(
      'This browser belongs only to Hopper. It does not use your normal browser logins. If you sign in here, this agent can read pages available to that signed-in session until you clear its browser data.',
    )
    expect(document.body.textContent).toContain(
      'Browser unavailable: this hub was started without an authenticated desktop browser broker.',
    )
  })
})

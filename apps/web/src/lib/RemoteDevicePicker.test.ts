import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import RemoteDevicePicker from './RemoteDevicePicker.svelte'
import type { RemoteDeviceGrant } from './api'

const apiMock = vi.hoisted(() => ({
  remoteDeviceCatalog: vi.fn(),
  setRemoteDeviceGrants: vi.fn(),
  authorizeRemoteDevice: vi.fn(),
}))

vi.mock('./api', async (original) => {
  const actual = await original<typeof import('./api')>()
  return { ...actual, api: { ...actual.api, ...apiMock } }
})

beforeEach(() => {
  apiMock.remoteDeviceCatalog.mockReset().mockResolvedValue([{
    siteId: 'device-a',
    label: 'Linux lab',
    paired: true,
    updatedAt: '2026-08-01T00:00:00.000Z',
    connected: true,
    capabilities: {
      enabled: true,
      platform: 'linux',
      arch: 'arm64',
      hostname: 'lab',
      roots: [{ id: 'root-a', label: 'Workspace', path: '/srv/work', read: true, write: true, terminal: false }],
    },
  }])
  apiMock.setRemoteDeviceGrants.mockReset().mockImplementation(async (id: string, grants: unknown[]) => ({
    id,
    profileId: 'codex-a',
    provider: 'codex',
    cwd: '/work',
    status: 'idle',
    createdAt: '2026-08-01T00:00:00.000Z',
    remoteDeviceGrants: grants,
  }))
  apiMock.authorizeRemoteDevice.mockReset().mockImplementation(async (id: string, siteId: string) => ({
    id,
    profileId: 'codex-a',
    provider: 'codex',
    cwd: '/work',
    status: 'idle',
    createdAt: '2026-08-01T00:00:00.000Z',
    remoteDeviceGrants: [{ siteId, rootIds: ['root-a'], capabilities: ['read', 'write'] }],
  }))
})

afterEach(cleanup)

describe('RemoteDevicePicker', () => {
  it('authorizes a whole testbed in one saved action without requiring root checkboxes', async () => {
    const onchange = vi.fn()
    render(RemoteDevicePicker, { props: { sessionId: 'session-a', grants: [], onchange } })

    await fireEvent.click(screen.getByTitle('Remote testbed access'))
    expect(await screen.findByText('Linux lab')).toBeTruthy()
    await fireEvent.click(screen.getByRole('button', { name: 'Authorize testbed' }))

    expect(apiMock.authorizeRemoteDevice).toHaveBeenCalledWith('session-a', 'device-a')
    expect(apiMock.setRemoteDeviceGrants).not.toHaveBeenCalled()
    expect(onchange).toHaveBeenCalled()
  })

  it('keeps unsupported operations disabled in the optional advanced editor', async () => {
    render(RemoteDevicePicker, { props: { sessionId: 'session-a', grants: [] } })
    await fireEvent.click(screen.getByTitle('Remote testbed access'))
    await screen.findByText('Linux lab')
    await fireEvent.click(screen.getByText('Advanced root controls'))
    expect(screen.getByText('Workspace')).toBeTruthy()
    expect((screen.getByLabelText('terminal') as HTMLInputElement).disabled).toBe(true)
  })

  it('preserves an existing grant for an offline paired target while saving another device', async () => {
    apiMock.remoteDeviceCatalog.mockResolvedValue([
      {
        siteId: 'device-offline', label: 'Offline lab', paired: true,
        updatedAt: '2026-08-01T00:00:00.000Z', connected: false, error: 'route offline',
      },
      ...(await apiMock.remoteDeviceCatalog.getMockImplementation()!()) as unknown[],
    ])
    const staleGrant: RemoteDeviceGrant = { siteId: 'device-offline', rootIds: ['old-root'], capabilities: ['read'] }
    render(RemoteDevicePicker, { props: { sessionId: 'session-a', grants: [staleGrant] } })

    await fireEvent.click(screen.getByTitle('Remote testbed access'))
    await screen.findByText('Offline lab')
    await fireEvent.click(screen.getAllByText('Advanced root controls').at(-1)!)
    await fireEvent.click(screen.getByLabelText('write'))
    await fireEvent.click(screen.getByRole('button', { name: 'Save advanced changes' }))

    await waitFor(() => expect(apiMock.setRemoteDeviceGrants).toHaveBeenCalled())
    expect(apiMock.setRemoteDeviceGrants.mock.calls[0]?.[1]).toEqual(expect.arrayContaining([
      staleGrant,
      { siteId: 'device-a', rootIds: ['root-a'], capabilities: ['write'] },
    ]))
  })
})

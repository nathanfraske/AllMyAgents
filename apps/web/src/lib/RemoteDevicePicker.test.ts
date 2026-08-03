import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import RemoteDevicePicker from './RemoteDevicePicker.svelte'
import type { RemoteDeviceGrant } from './api'

const apiMock = vi.hoisted(() => ({ remoteDeviceCatalog: vi.fn(), setRemoteDeviceGrants: vi.fn() }))

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
})

afterEach(cleanup)

describe('RemoteDevicePicker', () => {
  it('grants only a selected root/capability and never offers target-disabled operations', async () => {
    const onchange = vi.fn()
    render(RemoteDevicePicker, { props: { sessionId: 'session-a', grants: [], onchange } })

    await fireEvent.click(screen.getByTitle('Remote testbed access'))
    expect(await screen.findByText('Linux lab')).toBeTruthy()
    expect(screen.getByText('Workspace')).toBeTruthy()
    expect((screen.getByLabelText('terminal') as HTMLInputElement).disabled).toBe(true)
    await fireEvent.click(screen.getByLabelText('read'))
    await fireEvent.click(screen.getByRole('button', { name: 'Save grants' }))

    expect(apiMock.setRemoteDeviceGrants).toHaveBeenCalledWith('session-a', [{
      siteId: 'device-a', rootIds: ['root-a'], capabilities: ['read'],
    }])
    expect(onchange).toHaveBeenCalled()
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
    await fireEvent.click(screen.getByLabelText('write'))
    await fireEvent.click(screen.getByRole('button', { name: 'Save grants' }))

    await waitFor(() => expect(apiMock.setRemoteDeviceGrants).toHaveBeenCalled())
    expect(apiMock.setRemoteDeviceGrants.mock.calls[0]?.[1]).toEqual(expect.arrayContaining([
      staleGrant,
      { siteId: 'device-a', rootIds: ['root-a'], capabilities: ['write'] },
    ]))
  })
})

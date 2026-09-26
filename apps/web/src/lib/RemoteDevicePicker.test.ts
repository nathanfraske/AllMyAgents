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

  it('shows an authorization failure beside the clicked device without pretending it saved', async () => {
    apiMock.authorizeRemoteDevice.mockResolvedValue({ error: 'Old paired device is offline; permission save failed.' })
    const onchange = vi.fn()
    render(RemoteDevicePicker, { props: { sessionId: 'session-a', grants: [], onchange } })
    await fireEvent.click(screen.getByTitle('Remote testbed access'))
    await screen.findByText('Linux lab')
    const button = screen.getByRole('button', { name: 'Authorize testbed' })
    await fireEvent.click(button)

    const error = await screen.findByRole('alert')
    expect(error.textContent).toContain('permission save failed')
    expect(error.closest('.device')).toBe(button.closest('.device'))
    expect(onchange).not.toHaveBeenCalled()
    expect(screen.queryByText('Full testbed access is saved for this chat.')).toBeNull()
    expect(screen.getByRole('button', { name: 'Authorize testbed' })).toBeTruthy()
  })

  it('keeps unsaved checkbox edits when a chat refresh supplies equivalent grants', async () => {
    const existing: RemoteDeviceGrant = { siteId: 'device-a', rootIds: ['root-a'], capabilities: ['read'] }
    const { rerender } = render(RemoteDevicePicker, { props: { sessionId: 'session-a', grants: [existing] } })
    await fireEvent.click(screen.getByTitle('Remote testbed access'))
    await screen.findByText('Linux lab')
    await fireEvent.click(screen.getByText('Advanced root controls'))
    await fireEvent.click(screen.getByLabelText('write'))
    expect((screen.getByLabelText('write') as HTMLInputElement).checked).toBe(true)

    await rerender({ sessionId: 'session-a', grants: [{ ...existing, rootIds: [...existing.rootIds], capabilities: [...existing.capabilities] }] })

    expect((screen.getByLabelText('write') as HTMLInputElement).checked).toBe(true)
    expect(apiMock.setRemoteDeviceGrants).not.toHaveBeenCalled()
    await fireEvent.click(screen.getByRole('button', { name: 'Save advanced changes' }))
    await waitFor(() => expect(apiMock.setRemoteDeviceGrants).toHaveBeenCalledWith('session-a', [
      { siteId: 'device-a', rootIds: ['root-a'], capabilities: ['read', 'write'] },
    ]))
  })

  it('keeps first-time draft permissions across fresh empty grant arrays', async () => {
    const { rerender } = render(RemoteDevicePicker, { props: { sessionId: 'session-a', grants: [] } })
    await fireEvent.click(screen.getByTitle('Remote testbed access'))
    await screen.findByText('Linux lab')
    await fireEvent.click(screen.getByText('Advanced root controls'))
    await fireEvent.click(screen.getByLabelText('read'))

    await rerender({ sessionId: 'session-a', grants: [] })

    expect((screen.getByLabelText('read') as HTMLInputElement).checked).toBe(true)
    expect(apiMock.setRemoteDeviceGrants).not.toHaveBeenCalled()
  })

  it('ignores ordering and grouping changes in otherwise identical saved grants', async () => {
    const { rerender } = render(RemoteDevicePicker, { props: { sessionId: 'session-a', grants: [
      { siteId: 'device-a', rootIds: ['root-a', 'root-b'], capabilities: ['write', 'read'] },
    ] } })
    await fireEvent.click(screen.getByTitle('Remote testbed access'))
    await screen.findByText('Linux lab')
    await fireEvent.click(screen.getByText('Advanced root controls'))
    await fireEvent.click(screen.getByLabelText('read'))

    await rerender({ sessionId: 'session-a', grants: [
      { siteId: 'device-a', rootIds: ['root-b'], capabilities: ['read', 'write'] },
      { siteId: 'device-a', rootIds: ['root-a'], capabilities: ['read'] },
      { siteId: 'device-a', rootIds: ['root-a'], capabilities: ['write'] },
    ] })

    expect((screen.getByLabelText('read') as HTMLInputElement).checked).toBe(false)
    expect((screen.getByLabelText('write') as HTMLInputElement).checked).toBe(true)
  })

  it('still applies actual saved revocations instead of retaining stale draft authority', async () => {
    const { rerender } = render(RemoteDevicePicker, { props: { sessionId: 'session-a', grants: [
      { siteId: 'device-a', rootIds: ['root-a'], capabilities: ['read'] },
    ] } })
    await fireEvent.click(screen.getByTitle('Remote testbed access'))
    await screen.findByText('Linux lab')
    await fireEvent.click(screen.getByText('Advanced root controls'))
    await fireEvent.click(screen.getByLabelText('write'))

    await rerender({ sessionId: 'session-a', grants: [] })

    expect((screen.getByLabelText('read') as HTMLInputElement).checked).toBe(false)
    expect((screen.getByLabelText('write') as HTMLInputElement).checked).toBe(false)
    await fireEvent.click(screen.getByRole('button', { name: 'Save advanced changes' }))
    await waitFor(() => expect(apiMock.setRemoteDeviceGrants).toHaveBeenCalledWith('session-a', []))
  })

  it('does not carry an unsaved draft into a different chat with the same saved permissions', async () => {
    const { rerender } = render(RemoteDevicePicker, { props: { sessionId: 'session-a', grants: [] } })
    await fireEvent.click(screen.getByTitle('Remote testbed access'))
    await screen.findByText('Linux lab')
    await fireEvent.click(screen.getByText('Advanced root controls'))
    await fireEvent.click(screen.getByLabelText('write'))

    await rerender({ sessionId: 'session-b', grants: [] })

    expect((screen.getByLabelText('write') as HTMLInputElement).checked).toBe(false)
    expect(apiMock.setRemoteDeviceGrants).not.toHaveBeenCalled()
  })

  it('keeps a failed save visible and retains its draft across an unchanged refresh', async () => {
    apiMock.setRemoteDeviceGrants.mockResolvedValue({ error: 'remote device unavailable' })
    const onchange = vi.fn()
    const { rerender } = render(RemoteDevicePicker, { props: { sessionId: 'session-a', grants: [], onchange } })
    await fireEvent.click(screen.getByTitle('Remote testbed access'))
    await screen.findByText('Linux lab')
    await fireEvent.click(screen.getByText('Advanced root controls'))
    await fireEvent.click(screen.getByLabelText('write'))
    await fireEvent.click(screen.getByRole('button', { name: 'Save advanced changes' }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'remote device unavailable')

    await rerender({ sessionId: 'session-a', grants: [], onchange })

    expect((screen.getByLabelText('write') as HTMLInputElement).checked).toBe(true)
    expect(onchange).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toBe('remote device unavailable')
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

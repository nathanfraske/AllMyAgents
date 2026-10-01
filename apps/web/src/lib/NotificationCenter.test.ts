import { cleanup, render, waitFor } from '@testing-library/svelte'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import NotificationCenter from './NotificationCenter.svelte'
import { api, type NotificationRecord } from './api'
import { store } from './store.svelte'

const desktop = vi.fn(function () {})
const record: NotificationRecord = {
  id: 'failure-one', kind: 'tool-help-required', severity: 'warning', title: 'Tool failed', body: 'Needs help',
  sourceRole: 'agent', route: 'operator', createdAt: '2026-09-30T00:00:00Z', desktopEligible: true,
}
beforeEach(() => {
  localStorage.clear(); desktop.mockClear()
  vi.stubGlobal('Notification', Object.assign(desktop, { permission: 'granted' }))
  store.connected = true; store.questions = []; store.approvals = []; store.sessions = {}
  vi.spyOn(api, 'notifications').mockResolvedValue({ items: [{ ...record }], unread: 1 })
  vi.spyOn(api, 'markNotificationsDesktopDelivered').mockResolvedValue({ ok: true })
})
afterEach(() => { cleanup(); store.connected = false; vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear() })

it('does not repeat a displayed failure after reload when the hub acknowledgement failed', async () => {
  const acknowledge = vi.mocked(api.markNotificationsDesktopDelivered).mockResolvedValue({ error: 'Hub restarting' })
  render(NotificationCenter)
  await waitFor(() => expect(acknowledge).toHaveBeenCalledTimes(1))
  expect(desktop).toHaveBeenCalledTimes(1)
  cleanup()
  render(NotificationCenter)
  await waitFor(() => expect(acknowledge).toHaveBeenCalledTimes(2))
  expect(desktop).toHaveBeenCalledTimes(1)
  expect(api.notifications).toHaveBeenCalledTimes(2)
})

it('keeps resolved or read failures in the inbox without redisplaying them as desktop alerts', async () => {
  vi.mocked(api.notifications).mockResolvedValue({ items: [{ ...record, readAt: '2026-09-30T00:01:00Z' }], unread: 0 })
  render(NotificationCenter)
  await waitFor(() => expect(api.notifications).toHaveBeenCalledOnce())
  expect(desktop).not.toHaveBeenCalled()
  expect(api.markNotificationsDesktopDelivered).not.toHaveBeenCalled()
})

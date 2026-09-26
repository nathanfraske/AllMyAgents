import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import { afterEach, expect, it, vi } from 'vitest'
import { tick } from 'svelte'
import ApprovalAttention from './ApprovalAttention.svelte'
import { store } from './store.svelte'

afterEach(() => { cleanup(); vi.restoreAllMocks(); store.approvals = [] })
it('keeps actual routed approvals visible on the reviewer chat until resolved', async () => {
  store.selectedId = 'overseer'
  store.sessions = {}
  store.approvals = [{ id: 'a', sessionId: 'worker', reviewSessionId: 'overseer', status: 'pending', kind: 'browser/action', payload: {}, createdAt: new Date().toISOString() }]
  const select = vi.spyOn(store, 'select').mockImplementation(() => {})
  render(ApprovalAttention)
  expect(screen.getByLabelText('Approval review pending')).toBeTruthy()
  await fireEvent.click(screen.getByRole('button'))
  expect(select).toHaveBeenCalledWith('worker')
  store.approvals = []
  await tick()
  expect(screen.queryByLabelText('Approval review pending')).toBeNull()
})
it('does not display unrelated approvals or manufacture requests from conversation text', () => {
  store.selectedId = 'other'
  store.approvals = [{ id: 'a', sessionId: 'worker', reviewSessionId: 'overseer', status: 'pending', kind: 'browser/action', payload: { text: 'Should I approve?' }, createdAt: new Date().toISOString() }]
  render(ApprovalAttention)
  expect(screen.queryByLabelText('Approval review pending')).toBeNull()
})

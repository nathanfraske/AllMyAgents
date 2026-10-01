import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { tick } from 'svelte'
import ToolHelpAttention from './ToolHelpAttention.svelte'
import { store } from './store.svelte'
import { api } from './api'

function session(id = 'worker', requestId = 'incident') {
  return { record: { id, title: id, toolHelp: [{ id: requestId, tool: 'remote_read_file', summary: 'private diagnostic', failures: 2, status: 'waiting' }] } } as never
}
beforeEach(() => {
  store.sessions = { worker: session() }; store.selectedId = 'other'
  vi.spyOn(store, 'select').mockImplementation(() => {})
  vi.spyOn(store, 'refreshSideData').mockResolvedValue(undefined)
  vi.spyOn(store, 'syncRecordsFromHub').mockResolvedValue(undefined)
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); store.sessions = {} })

it('shows newly persisted holds through the real roster refresh and clears the exact operator decision', async () => {
  vi.mocked(store.syncRecordsFromHub).mockRestore()
  vi.spyOn(api, 'profiles').mockResolvedValue([])
  const waiting = session() as unknown as { record: import('./api').SessionRecord }
  const roster = vi.spyOn(api, 'sessions').mockResolvedValue([waiting.record])
  store.sessions.worker!.record.toolHelp = undefined
  render(ToolHelpAttention)
  expect(screen.queryByLabelText('Operator tool help')).toBeNull()

  await store.syncRecordsFromHub(); await tick()
  await fireEvent.click(screen.getByText('Review tool failure'))
  const decide = vi.spyOn(api, 'resolveToolHelp').mockImplementation(async () => {
    roster.mockResolvedValue([{ ...waiting.record, toolHelp: [] }])
    return { ok: true }
  })
  await fireEvent.click(screen.getByText('I fixed it — allow retry'))
  expect(decide).toHaveBeenCalledWith('worker', 'incident', 'retry')
  expect(screen.queryByLabelText('Operator tool help')).toBeNull()
})

it('does not resurrect a resolved hold from a roster request started before the decision', async () => {
  vi.mocked(store.syncRecordsFromHub).mockRestore()
  vi.spyOn(api, 'profiles').mockResolvedValue([])
  let finish!: (records: import('./api').SessionRecord[]) => void
  vi.spyOn(api, 'sessions').mockImplementation(() => new Promise(resolve => { finish = resolve }))
  vi.spyOn(api, 'resolveToolHelp').mockResolvedValue({ ok: true })
  render(ToolHelpAttention)
  const refreshing = store.syncRecordsFromHub()
  await fireEvent.click(screen.getByText('Review tool failure'))
  await fireEvent.click(screen.getByText('I fixed it — allow retry'))
  finish([(session() as unknown as { record: import('./api').SessionRecord }).record])
  await refreshing; await tick()
  expect(screen.queryByLabelText('Operator tool help')).toBeNull()
})

it('shows metadata only until explicitly opened and resolves the exact pinned request', async () => {
  const decide = vi.spyOn(api, 'resolveToolHelp').mockResolvedValue({ ok: true })
  render(ToolHelpAttention)
  expect(screen.queryByText('private diagnostic')).toBeNull()
  await fireEvent.click(screen.getByText('Review tool failure'))
  expect(screen.getByText('private diagnostic')).toBeTruthy()
  store.sessions.other = session('other', 'second'); store.selectedId = 'other'; await tick()
  await fireEvent.click(screen.getByText('I fixed it — allow retry'))
  expect(decide).toHaveBeenCalledWith('worker', 'incident', 'retry')
  expect(store.sessions.worker!.record.toolHelp).toEqual([])
  expect(store.sessions.other!.record.toolHelp).toHaveLength(1)
})
it('keeps failed decisions pending and closing the dialog does not approve anything', async () => {
  const decide = vi.spyOn(api, 'resolveToolHelp').mockResolvedValue({ error: 'not saved' })
  render(ToolHelpAttention)
  await fireEvent.click(screen.getByText('Review tool failure'))
  await fireEvent.click(screen.getByText('Allow 5-minute diagnosis'))
  expect(screen.getByRole('alert').textContent).toContain('not saved')
  expect(store.sessions.worker!.record.toolHelp![0]!.status).toBe('waiting')
  await fireEvent.click(screen.getByText('Close'))
  expect(decide).toHaveBeenCalledTimes(1)
  expect(screen.getByLabelText('Operator tool help')).toBeTruthy()
})
it('shows a saved-decision delivery warning without offering to replay that decision', async () => {
  const decide = vi.spyOn(api, 'resolveToolHelp').mockResolvedValue({ ok: true, warning: 'Decision saved; chat delivery failed. Do not resubmit.' })
  render(ToolHelpAttention)
  await fireEvent.click(screen.getByText('Review tool failure'))
  await fireEvent.click(screen.getByText('I fixed it — allow retry'))
  expect(screen.getByRole('alert').textContent).toContain('Do not resubmit')
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(decide).toHaveBeenCalledTimes(1)
})
it('does not double-submit and retains a skipped hold for later operator recovery', async () => {
  let settle!: (value: { ok: true }) => void
  const decide = vi.spyOn(api, 'resolveToolHelp').mockImplementation(() => new Promise(resolve => { settle = resolve }))
  render(ToolHelpAttention)
  await fireEvent.click(screen.getByText('Review tool failure'))
  await fireEvent.click(screen.getByText('Skip affected work'))
  await fireEvent.click(screen.getByText('Skip affected work'))
  expect(decide).toHaveBeenCalledTimes(1)
  settle({ ok: true }); await tick(); await tick()
  expect(store.sessions.worker!.record.toolHelp![0]!.status).toBe('skipped')
  expect(screen.getByLabelText('Operator tool help')).toBeTruthy()
})
it('does not resolve a stale dialog as a new request or act on remote namespace records', async () => {
  const decide = vi.spyOn(api, 'resolveToolHelp')
  render(ToolHelpAttention)
  await fireEvent.click(screen.getByText('Review tool failure'))
  store.sessions.worker = session('worker', 'replacement'); await tick()
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(decide).not.toHaveBeenCalled()
  store.sessions.worker!.record.siteId = 'remote'; await tick()
  expect(screen.queryByLabelText('Operator tool help')).toBeNull()
})

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Journal } from './journal.js'
import { FileTransferTarget, type FileTransferRequest } from './fileTransfers.js'
import { RemoteFileTransfers, type TransferFileRecord } from './remoteFileTransfers.js'
import type { RemoteDeviceActionResult } from './remoteDevices.js'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ama-transfer-job-')))
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }))
  const local = path.join(root, 'local'), remote = path.join(root, 'remote')
  await fs.mkdir(local); await fs.mkdir(remote)
  const journal = new Journal(path.join(root, 'journal.db'))
  cleanups.push(async () => { journal.db.close() })
  const target = new FileTransferTarget(path.join(root, 'target-receipts'))
  cleanups.push(() => target.shutdown())
  let allowed = true, resolve!: (r: TransferFileRecord) => void
  let hook: ((request: FileTransferRequest, result: RemoteDeviceActionResult) => RemoteDeviceActionResult) | undefined
  const terminal = new Promise<TransferFileRecord>(r => { resolve = r })
  const completed = vi.fn((r: TransferFileRecord) => resolve(r))
  const call = vi.fn(async (_s: string, _d: string, _r: string, request: FileTransferRequest): Promise<RemoteDeviceActionResult> => {
    if (!allowed) return { ok: false, error: 'revoked' }
    try {
      const transfer = await target.execute(remote, 'peer:chat', request, () => allowed)
      const result: RemoteDeviceActionResult = { ok: true, transfer, telemetry: { transport: 'myownmesh-rpc', targetMs: 1, networkMs: 2, roundTripMs: 3 } }
      return hook ? hook(request, result) : result
    } catch (e) { return { ok: false, error: String(e), failure: { stage: 'target' } } }
  })
  const services = { workspace: (_: string) => ({ id: 'chat', cwd: local }), authorized: () => allowed, preflight: vi.fn(async () => {}), remote: call, completed }
  const transfers = new RemoteFileTransfers(journal, path.join(root, 'local-receipts'), services)
  cleanups.push(() => transfers.shutdown())
  const input = { operation: 'upload' as const, device_id: 'device', root_id: 'root', local_path: 'source.bin', remote_path: 'output.bin' }
  return { root, local, remote, journal, target, transfers, input, terminal, completed, call, services,
    revoke: () => { allowed = false }, setHook: (fn: NonNullable<typeof hook>) => { hook = fn } }
}

it.each(['upload', 'download'] as const)('copies a whole binary %s with one model call, metadata-only coalesced progress and exact checksum', async operation => {
  const h = await fixture(), bytes = Buffer.alloc(3 * 1024 * 1024 + 3, 215)
  await fs.writeFile(path.join(operation === 'upload' ? h.local : h.remote, 'source.bin'), bytes)
  const receipt = await h.transfers.manage('chat', { ...h.input, operation, local_path: operation === 'upload' ? 'source.bin' : 'output.bin', remote_path: operation === 'upload' ? 'output.bin' : 'source.bin' })
  expect(receipt).toMatchObject({ state: 'running', transferred: 0 })
  const result = await h.terminal
  expect(result).toMatchObject({ state: 'completed', transferred: bytes.length, size: bytes.length, transport: 'myownmesh-rpc', sha256: crypto.createHash('sha256').update(bytes).digest('hex') })
  expect(result.telemetry!.requests).toBeGreaterThan(6)
  expect((await fs.readFile(path.join(operation === 'upload' ? h.remote : h.local, 'output.bin'))).equals(bytes)).toBe(true)
  const events = h.journal.since(0).filter(e => e.kind.startsWith('file-transfer/'))
  expect(events.filter(e => e.kind === 'file-transfer/completed')).toHaveLength(1)
  expect(events.length).toBeLessThanOrEqual(4)
  expect(JSON.stringify(events).length).toBeLessThan(8000)
  expect(JSON.stringify(events)).not.toContain(bytes.subarray(0, 1000).toString('base64'))
  expect(h.completed).toHaveBeenCalledTimes(1)
  expect(await h.transfers.manage('chat', { operation: 'status', transfer_id: receipt.id })).toMatchObject({ state: 'completed' })
  await expect(h.transfers.manage('other-chat', { operation: 'status', transfer_id: receipt.id })).rejects.toThrow(/not found/)
})

it('does not start bytes when the target lacks protocol support, or source is outside workspace/private config', async () => {
  const h = await fixture()
  await fs.writeFile(path.join(h.local, 'source.bin'), 'a')
  h.services.preflight.mockRejectedValue(new Error('Target needs an update'))
  await expect(h.transfers.manage('chat', h.input)).rejects.toThrow(/update/)
  expect(h.call).not.toHaveBeenCalled()
  for (const local_path of ['../secret', '.env', '.git/config']) await expect(h.transfers.manage('chat', { ...h.input, local_path })).rejects.toThrow()
  await expect(h.transfers.manage('chat', { ...h.input, operation: 'bogus' as never })).rejects.toThrow(/Unknown/)
})

it('retains a lost publication acknowledgement as unknown and reconciles from the exact durable receipt without retry', async () => {
  const h = await fixture()
  await fs.writeFile(path.join(h.local, 'source.bin'), 'complete')
  h.setHook((request, result) => request.operation === 'finish' ? { ok: false, failure: { stage: 'transport' }, error: 'lost acknowledgement' } : result)
  const receipt = await h.transfers.manage('chat', h.input)
  expect(await h.terminal).toMatchObject({ state: 'outcome_unknown' })
  expect(await fs.readFile(path.join(h.remote, 'output.bin'), 'utf8')).toBe('complete')
  expect(h.call.mock.calls.filter(args => args[3].operation === 'finish')).toHaveLength(1)
  expect(h.call.mock.calls.filter(args => args[3].operation === 'abort')).toHaveLength(0)
  expect(await h.transfers.manage('chat', { operation: 'status', transfer_id: receipt.id })).toMatchObject({ state: 'completed' })
  expect(h.call.mock.calls.filter(args => args[3].operation === 'finish')).toHaveLength(1)
})

it('does not publish a corrupted download', async () => {
  const h = await fixture()
  await fs.writeFile(path.join(h.remote, 'output.bin'), 'correct')
  h.setHook((request, result) => request.operation === 'chunk' ? { ...result, transfer: { ...result.transfer!, content: Buffer.from('corrupt').toString('base64') } } : result)
  await h.transfers.manage('chat', { ...h.input, operation: 'download' })
  expect(await h.terminal).toMatchObject({ state: 'outcome_unknown', error: expect.stringMatching(/checksum/) })
  await expect(fs.stat(path.join(h.local, 'source.bin'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('honors revocation before local download publication', async () => {
  const h = await fixture()
  await fs.writeFile(path.join(h.remote, 'output.bin'), 'correct')
  h.setHook((request, result) => { if (request.operation === 'finish') h.revoke(); return result })
  await h.transfers.manage('chat', { ...h.input, operation: 'download' })
  expect(await h.terminal).toMatchObject({ error: expect.stringMatching(/revoked/) })
  await expect(fs.stat(path.join(h.local, 'source.bin'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('cancels staging, emits one terminal receipt and does not touch the database after shutdown', async () => {
  const h = await fixture()
  await fs.writeFile(path.join(h.local, 'source.bin'), Buffer.alloc(2 * 1024 * 1024))
  const receipt = await h.transfers.manage('chat', h.input)
  await h.transfers.manage('chat', { operation: 'cancel', transfer_id: receipt.id })
  expect(await h.terminal).toMatchObject({ state: 'cancelled' })
  await h.transfers.shutdown()
  await expect(h.transfers.manage('chat', h.input)).rejects.toThrow(/shutting down/)
  await expect(fs.stat(path.join(h.remote, 'output.bin'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(h.completed).toHaveBeenCalledTimes(1)
})

it('turns only interrupted jobs unknown after restart; never replays them', async () => {
  const h = await fixture()
  const record = { id: crypto.randomUUID(), sessionId: 'chat', state: 'running' }
  h.journal.db.prepare('INSERT INTO remote_file_transfers VALUES(?,?,?,?)').run(record.id, 'chat', 'running', JSON.stringify(record))
  const restarted = new RemoteFileTransfers(h.journal, path.join(h.root, 'other-receipts'), h.services)
  expect(JSON.parse((h.journal.db.prepare('SELECT record FROM remote_file_transfers WHERE id=?').get(record.id) as {record: string}).record)).toMatchObject({ state: 'outcome_unknown' })
  expect(h.call).not.toHaveBeenCalled()
  await restarted.shutdown()
})

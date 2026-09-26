import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { FileTransferTarget, FILE_TRANSFER_CHUNK, FILE_TRANSFER_MAX, transferPath, type FileTransferRequest } from './fileTransfers.js'
import { DeviceExecutor, remoteCapabilityForAction } from './remoteDevices.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ama-transfer-test-')))
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }))
  const target = new FileTransferTarget(path.join(root, 'receipts'))
  cleanups.push(() => target.shutdown())
  const id = crypto.randomUUID()
  const call = (input: Omit<FileTransferRequest, 'id' | 'mode'>, mode: 'read' | 'write' = 'write', owner = 'owner') =>
    target.execute(root, owner, { ...input, id, mode })
  return { root, target, id, call }
}
const sha = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex')

it.each([0, FILE_TRANSFER_CHUNK * 5 + 7])('publishes and reads %i binary bytes with bounded buffers and restart receipts', async size => {
  const h = await fixture(), bytes = Buffer.alloc(size, 173)
  await h.call({ operation: 'begin', path: 'new.bin', size })
  await expect(fs.stat(path.join(h.root, 'new.bin'))).rejects.toMatchObject({ code: 'ENOENT' })
  for (let offset = 0; offset < size; offset += FILE_TRANSFER_CHUNK) {
    const part = bytes.subarray(offset, offset + FILE_TRANSFER_CHUNK)
    expect(await h.call({ operation: 'chunk', offset, content: part.toString('base64') })).toMatchObject({ offset: offset + part.length })
  }
  expect(await h.call({ operation: 'finish', sha256: sha(bytes) })).toMatchObject({ state: 'completed', sha256: sha(bytes), size })
  expect((await fs.readFile(path.join(h.root, 'new.bin'))).equals(bytes)).toBe(true)
  const restarted = new FileTransferTarget(path.join(h.root, 'receipts'))
  expect(await restarted.execute(h.root, 'owner', { id: h.id, mode: 'write', operation: 'status' })).toMatchObject({ state: 'completed', sha256: sha(bytes) })
  await expect(h.call({ operation: 'finish', sha256: sha(bytes) })).rejects.toThrow(/do not retry/)
  await expect(h.call({ operation: 'begin', path: 'other.bin', size })).rejects.toMatchObject({ code: 'EEXIST' })
  const id = crypto.randomUUID()
  const read = (input: Omit<FileTransferRequest, 'id' | 'mode'>) => h.target.execute(h.root, 'owner', { ...input, id, mode: 'read' })
  expect(await read({ operation: 'begin', path: 'new.bin' })).toMatchObject({ size })
  const parts: Buffer[] = []
  let offset = 0
  while (offset < size) {
    const receipt = await read({ operation: 'chunk', offset })
    expect(receipt.content!.length).toBeLessThanOrEqual(Math.ceil(FILE_TRANSFER_CHUNK / 3) * 4)
    parts.push(Buffer.from(receipt.content!, 'base64')); offset = receipt.offset
  }
  expect(Buffer.concat(parts).equals(bytes)).toBe(true)
  expect(await read({ operation: 'finish' })).toMatchObject({ sha256: sha(bytes) })
})

it('rejects out-of-order/replayed/oversized chunks and wrong owner, direction or root', async () => {
  const h = await fixture()
  await h.call({ operation: 'begin', path: 'out', size: 2 })
  await expect(h.call({ operation: 'chunk', offset: 1, content: 'YQ==' })).rejects.toThrow(/offset/)
  await expect(h.call({ operation: 'chunk', offset: 0, content: 'abc' })).rejects.toThrow(/encoding/)
  await expect(h.call({ operation: 'chunk', offset: 0, content: 'Y'.repeat(FILE_TRANSFER_CHUNK * 2) })).rejects.toThrow(/size/)
  await expect(h.call({ operation: 'status' }, 'write', 'other')).rejects.toThrow(/another caller/)
  await expect(h.call({ operation: 'status' }, 'read')).rejects.toThrow(/another caller/)
  await fs.mkdir(path.join(h.root, 'other'))
  await expect(h.target.execute(path.join(h.root, 'other'), 'owner', { id: h.id, mode: 'write', operation: 'status' })).rejects.toThrow(/another caller/)
  await h.call({ operation: 'chunk', offset: 0, content: 'YQ==' })
  await expect(h.call({ operation: 'chunk', offset: 0, content: 'YQ==' })).rejects.toThrow(/offset/)
  await expect(h.call({ operation: 'finish', sha256: sha(Buffer.from('a')) })).rejects.toThrow(/incomplete/)
})

it.each(['../escape', '/abs', 'a/../x', 'a//b', 'x:ads', 'CON', 'x.', 'x ', 'a\\..\\x'])('refuses ambiguous/escaping path %s', async relative => {
  const h = await fixture()
  await expect(transferPath(h.root, relative, false)).rejects.toThrow()
})

it('refuses directory junctions and existing destination files', async () => {
  const h = await fixture()
  await fs.mkdir(path.join(h.root, 'real'))
  await fs.symlink(path.join(h.root, 'real'), path.join(h.root, 'link'), 'junction')
  await expect(h.call({ operation: 'begin', path: 'link/new', size: 0 })).rejects.toThrow(/links|junctions/)
  await fs.writeFile(path.join(h.root, 'exists'), 'keep')
  await expect(h.call({ operation: 'begin', path: 'exists', size: 0 })).rejects.toThrow(/exists/)
  expect(await fs.readFile(path.join(h.root, 'exists'), 'utf8')).toBe('keep')
})

it('refuses excess size, checksum corruption, and staged file tampering', async () => {
  const h = await fixture()
  await expect(h.call({ operation: 'begin', path: 'large', size: FILE_TRANSFER_MAX + 1 })).rejects.toThrow(/size/)
  await h.call({ operation: 'begin', path: 'new', size: 1 })
  await h.call({ operation: 'chunk', offset: 0, content: 'YQ==' })
  await expect(h.call({ operation: 'finish', sha256: sha(Buffer.from('b')) })).rejects.toThrow(/checksum/)
  await fs.writeFile(path.join(h.root, `.ama-transfer-${h.id}.part`), 'b')
  await expect(h.call({ operation: 'finish', sha256: sha(Buffer.from('a')) })).rejects.toThrow(/Staged file checksum/)
  await expect(fs.stat(path.join(h.root, 'new'))).rejects.toMatchObject({ code: 'ENOENT' })
  await h.call({ operation: 'abort' })
  expect(await h.call({ operation: 'status' })).toMatchObject({ state: 'aborted' })
  await expect(fs.stat(path.join(h.root, `.ama-transfer-${h.id}.part`))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('checks revocation at publication and never overwrites a concurrent destination', async () => {
  const h = await fixture()
  await h.call({ operation: 'begin', path: 'new', size: 0 })
  await expect(h.target.execute(h.root, 'owner', { id: h.id, mode: 'write', operation: 'finish', sha256: sha(Buffer.alloc(0)) }, () => false)).rejects.toThrow(/revoked/)
  await fs.writeFile(path.join(h.root, 'new'), 'someone else')
  await expect(h.call({ operation: 'finish', sha256: sha(Buffer.alloc(0)) })).rejects.toMatchObject({ code: 'EEXIST' })
  expect(await fs.readFile(path.join(h.root, 'new'), 'utf8')).toBe('someone else')
})

it('detects changing sources and reports active receipts as unknown after target restart', async () => {
  const h = await fixture()
  await fs.writeFile(path.join(h.root, 'source'), 'a')
  await h.call({ operation: 'begin', path: 'source' }, 'read')
  const other = new FileTransferTarget(path.join(h.root, 'receipts'))
  expect(await other.execute(h.root, 'owner', { id: h.id, mode: 'read', operation: 'status' })).toMatchObject({ state: 'outcome_unknown' })
  await fs.appendFile(path.join(h.root, 'source'), 'b')
  await expect(h.call({ operation: 'chunk', offset: 0 }, 'read')).rejects.toThrow(/changed/)
})

it('enforces existing DeviceExecutor read/write ceilings and rechecks revocation', async () => {
  const h = await fixture(), executor = new DeviceExecutor(path.join(h.root, 'policy.json'))
  executor.update({ enabled: true, roots: [{ id: 'r', label: 'test', path: h.root, read: true, write: false, terminal: false }] })
  expect(executor.capabilities().fileTransfers).toBe(1)
  const action = { op: 'file_transfer' as const, rootId: executor.capabilities().roots[0]!.id, transfer: { id: h.id, mode: 'write' as const, operation: 'begin' as const, path: 'new', size: 0 } }
  expect(remoteCapabilityForAction(action)).toBe('write')
  expect(await executor.execute(action, { transferOwner: 'peer:chat' })).toMatchObject({ ok: false })
  executor.update({ enabled: true, roots: [{ id: 'r', label: 'test', path: h.root, read: true, write: true, terminal: false }] })
  expect(await executor.execute(action)).toMatchObject({ ok: false, error: expect.stringMatching(/owner/) })
  expect(await executor.execute(action, { transferOwner: 'peer:chat' })).toMatchObject({ ok: true })
  executor.update({ enabled: false })
  expect(await executor.execute({ ...action, transfer: { ...action.transfer, operation: 'finish', sha256: sha(Buffer.alloc(0)) } }, { transferOwner: 'peer:chat' })).toMatchObject({ ok: false })
  executor.update({ enabled: true })
  expect(await executor.execute({ ...action, transfer: { ...action.transfer, operation: 'abort' } }, { transferOwner: 'peer:chat' })).toMatchObject({ ok: true })
})

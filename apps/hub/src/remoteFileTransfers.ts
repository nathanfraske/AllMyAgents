import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { artifactSource } from './chatArtifacts.js'
import { FILE_TRANSFER_CHUNK, FILE_TRANSFER_MAX, FileTransferTarget, transferPath, type FileTransferRequest, type FileTransferReceipt } from './fileTransfers.js'
import type { Journal } from './journal.js'
import type { RemoteDeviceActionResult, RemoteDeviceTelemetry } from './remoteDevices.js'

export interface TransferFileInput {
  operation: 'upload' | 'download' | 'status' | 'cancel'
  transfer_id?: string
  device_id?: string
  root_id?: string
  local_path?: string
  remote_path?: string
}
export interface TransferFileRecord {
  id: string; sessionId: string; deviceId: string; rootId: string
  direction: 'upload' | 'download'; localPath: string; remotePath: string
  state: 'running' | 'completed' | 'failed' | 'cancelled' | 'outcome_unknown'
  phase: string; size: number; transferred: number; sha256?: string
  createdAt: string; updatedAt: string; elapsedMs: number; bytesPerSecond: number
  transport?: RemoteDeviceTelemetry['transport']; error?: string; cancelRequested?: boolean
  remoteReceipt?: FileTransferReceipt
  failure?: RemoteDeviceActionResult['failure']
  telemetry?: { requests: number; targetMs: number; networkMs: number; roundTripMs: number }
}
type Workspace = { id: string; cwd: string; executionCwd?: string }
type Services = {
  workspace(sessionId: string): Workspace
  authorized(sessionId: string, deviceId: string, rootId: string, direction: 'upload' | 'download'): boolean
  preflight(sessionId: string, deviceId: string, rootId: string, direction: 'upload' | 'download'): Promise<void>
  remote(sessionId: string, deviceId: string, rootId: string, request: FileTransferRequest): Promise<RemoteDeviceActionResult>
  completed(record: TransferFileRecord): void
}

/** The complete byte loop runs in the hub, never through model messages. Progress is coalesced to
 * at most one journal record per second; one terminal event/message, no per-chunk chat refresh. */
export class RemoteFileTransfers {
  private local: FileTransferTarget
  private running = new Map<string, { record: TransferFileRecord; done: Promise<void> }>()
  private stopped = false
  private stopping = false
  constructor(private journal: Journal, directory: string, private services: Services) {
    this.local = new FileTransferTarget(directory)
    journal.db.exec('CREATE TABLE IF NOT EXISTS remote_file_transfers (id TEXT PRIMARY KEY, session TEXT NOT NULL, state TEXT NOT NULL, record TEXT NOT NULL); CREATE INDEX IF NOT EXISTS remote_file_transfers_state ON remote_file_transfers(state)')
    const rows = journal.db.prepare("SELECT record FROM remote_file_transfers WHERE state='running'").all() as { record: string }[]
    // Never resume an ambiguous publication automatically after a hub restart.
    for (const { record: text } of rows) {
      const record = JSON.parse(text) as TransferFileRecord
      if (record.state !== 'running') continue
      record.state = 'outcome_unknown'; record.error = 'Hub restarted during transfer; inspect status and destination before starting another transfer.'
      this.save(record, true)
    }
  }
  private save(record: TransferFileRecord, event = false) {
    if (this.stopped) return
    record.updatedAt = new Date().toISOString()
    this.journal.db.prepare('INSERT INTO remote_file_transfers(id,session,state,record) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,record=excluded.record')
      .run(record.id, record.sessionId, record.state, JSON.stringify(record))
    if (event) this.journal.append(record.sessionId, `file-transfer/${record.state === 'running' ? 'progress' : record.state}`, record)
  }
  private get(session: string, id?: string): TransferFileRecord {
    const row = this.journal.db.prepare('SELECT record FROM remote_file_transfers WHERE id=? AND session=?').get(id ?? '', session) as { record: string } | undefined
    if (!row) throw new Error('Transfer not found in this chat.')
    return JSON.parse(row.record) as TransferFileRecord
  }
  async manage(sessionId: string, input: TransferFileInput): Promise<TransferFileRecord> {
    if (this.stopped || this.stopping) throw new Error('Transfer service is shutting down.')
    if (!input || !['upload', 'download', 'status', 'cancel'].includes(input.operation)) throw new Error('Unknown transfer operation.')
    if (input.operation === 'status' || input.operation === 'cancel') {
      const saved = this.get(sessionId, input.transfer_id)
      const active = this.running.get(saved.id)
      if (input.operation === 'cancel' && active) {
        active.record.cancelRequested = true; this.save(active.record)
        return structuredClone(active.record)
      }
      if (input.operation === 'status' && saved.state === 'outcome_unknown') {
        const result = await this.services.remote(sessionId, saved.deviceId, saved.rootId, {
          id: saved.id, mode: saved.direction === 'upload' ? 'write' : 'read', operation: 'status',
        })
        if (result.ok && result.transfer) {
          saved.remoteReceipt = result.transfer
          // A remote upload receipt with checksum is authoritative; a completed remote read alone
          // cannot prove publication of the local download.
          if (saved.direction === 'upload' && saved.sha256 && result.transfer.state === 'completed' &&
              result.transfer.sha256 === saved.sha256 && result.transfer.size === saved.size) {
            saved.state = 'completed'; saved.transferred = saved.size; delete saved.error
          }
          this.save(saved, true)
        }
      }
      return saved
    }
    if (this.running.size >= 4) throw new Error('Hub transfer capacity reached (4 active).')
    if (!input.device_id || !input.root_id || !input.local_path || !input.remote_path) throw new Error('Provide device_id, root_id, local_path and remote_path.')
    const workspace = this.services.workspace(sessionId)
    const canonical = await fs.realpath(workspace.cwd)
    const candidate = artifactSource(workspace, input.local_path)
    const relative = path.relative(workspace.cwd, candidate)
    await transferPath(canonical, relative, input.operation === 'upload')
    await this.services.preflight(sessionId, input.device_id, input.root_id, input.operation)
    if (this.running.size >= 4 || this.stopping) throw new Error('Transfer capacity reached or service is shutting down.')
    const record: TransferFileRecord = {
      id: crypto.randomUUID(), sessionId, deviceId: input.device_id, rootId: input.root_id,
      direction: input.operation, localPath: relative, remotePath: input.remote_path,
      state: 'running', phase: 'starting', size: 0, transferred: 0,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), elapsedMs: 0, bytesPerSecond: 0,
    }
    this.save(record, true)
    const done = Promise.resolve().then(() => this.copy(record, canonical, workspace.cwd)).catch(error => {
      // Do not let a notification/DB error become an unhandled rejection or replay a finished copy.
      console.error('[file-transfer] receipt/notification persistence failed', record.id, error instanceof Error ? error.message : String(error))
    }).finally(() => this.running.delete(record.id))
    this.running.set(record.id, { record, done })
    return structuredClone(record)
  }
  /** Tests and shutdown await owned promises; no abandoned writes after the journal closes. */
  async shutdown(): Promise<void> {
    this.stopping = true
    for (const { record } of this.running.values()) record.cancelRequested = true
    await Promise.all([...this.running.values()].map(item => item.done))
    await this.local.shutdown()
    this.stopped = true
  }
  private async copy(record: TransferFileRecord, base: string, originalCwd: string): Promise<void> {
    const started = performance.now()
    let lastProgress = 0
    let localStarted = false, remoteStarted = false, publicationAttempted = false, mutationUnknown = false
    const check = () => {
      if (record.cancelRequested) throw new Error('Transfer cancelled.')
      if (this.services.workspace(record.sessionId).cwd !== originalCwd) throw new Error('Chat workspace changed during transfer.')
      if (!this.services.authorized(record.sessionId, record.deviceId, record.rootId, record.direction)) throw new Error('Transfer authority was revoked.')
    }
    const local = async (request: Omit<FileTransferRequest, 'id' | 'mode'>) => {
      check()
      if (await fs.realpath(originalCwd) !== base) throw new Error('Chat workspace canonical identity changed during transfer.')
      return this.local.execute(base, record.sessionId, { ...request, id: record.id, mode: record.direction === 'upload' ? 'read' : 'write' }, () => {
        try { check(); return true } catch { return false }
      })
    }
    const remote = async (request: Omit<FileTransferRequest, 'id' | 'mode'>) => {
      check()
      const result = await this.services.remote(record.sessionId, record.deviceId, record.rootId, {
        ...request, id: record.id, mode: record.direction === 'upload' ? 'write' : 'read',
      })
      record.transport = result.telemetry?.transport ?? record.transport
      const timing = record.telemetry ??= { requests: 0, targetMs: 0, networkMs: 0, roundTripMs: 0 }
      timing.requests++
      for (const key of ['targetMs', 'networkMs', 'roundTripMs'] as const) timing[key] += result.telemetry?.[key] ?? 0
      if (!result.ok || !result.transfer) {
        record.failure = result.failure
        mutationUnknown = record.direction === 'upload' && (result.outcomeUnknown === true || result.failure?.stage === 'transport' || result.failure?.stage === 'timeout')
        throw new Error(result.error ?? 'Target did not return a file-transfer receipt.')
      }
      return result.transfer
    }
    try {
      const reader = record.direction === 'upload' ? local : remote
      const writer = record.direction === 'upload' ? remote : local
      const source = await reader({ operation: 'begin', path: record.direction === 'upload' ? record.localPath : record.remotePath })
      if (record.direction === 'upload') localStarted = true; else remoteStarted = true
      if (!Number.isSafeInteger(source.size) || source.size < 0 || source.size > FILE_TRANSFER_MAX) throw new Error('Invalid source size.')
      record.size = source.size
      await writer({ operation: 'begin', path: record.direction === 'upload' ? record.remotePath : record.localPath, size: source.size })
      localStarted = remoteStarted = true
      record.phase = 'copying'
      while (record.transferred < record.size) {
        const read = await reader({ operation: 'chunk', offset: record.transferred })
        if (typeof read.content !== 'string' || read.content.length > Math.ceil(FILE_TRANSFER_CHUNK / 3) * 4) throw new Error('Invalid target chunk.')
        const bytes = Buffer.from(read.content, 'base64').length
        if (!bytes || read.offset !== record.transferred + bytes || read.offset > record.size) throw new Error('Invalid target offset.')
        const written = await writer({ operation: 'chunk', offset: record.transferred, content: read.content })
        if (written.offset !== read.offset) throw new Error('Target write acknowledgement does not match.')
        record.transferred = written.offset
        record.elapsedMs = Math.round(performance.now() - started)
        record.bytesPerSecond = Math.round(record.transferred / Math.max(record.elapsedMs / 1000, .001))
        if (performance.now() - lastProgress >= 1000) { this.save(record, true); lastProgress = performance.now() }
      }
      record.phase = 'verifying'
      const readReceipt = await reader({ operation: 'finish' })
      if (readReceipt.state !== 'completed' || !/^[a-f0-9]{64}$/u.test(readReceipt.sha256 ?? '')) throw new Error('Source did not confirm a checksum.')
      record.sha256 = readReceipt.sha256
      record.phase = 'publishing'; this.save(record)
      publicationAttempted = true
      const receipt = await writer({ operation: 'finish', sha256: record.sha256 })
      if (receipt.state !== 'completed' || receipt.sha256 !== record.sha256 || receipt.size !== record.size) throw new Error('Destination did not confirm the complete checksum.')
      record.state = 'completed'; record.phase = 'complete'
    } catch (error) {
      record.error = error instanceof Error ? error.message : String(error)
      record.state = publicationAttempted || mutationUnknown ? 'outcome_unknown' : record.cancelRequested ? 'cancelled' : 'failed'
      // Never abort/replay an ambiguous publication. Pre-publication staging cleanup is best-effort;
      // target inactivity expiry closes handles if a grant or connection has already been revoked.
      if (!publicationAttempted && !mutationUnknown) {
        if (localStarted) await this.local.execute(base, record.sessionId, { id: record.id, mode: record.direction === 'upload' ? 'read' : 'write', operation: 'abort' }).catch(() => {})
        if (remoteStarted) await this.services.remote(record.sessionId, record.deviceId, record.rootId, {
          id: record.id, mode: record.direction === 'upload' ? 'write' : 'read', operation: 'abort',
        }).catch(() => {})
      }
    }
    record.elapsedMs = Math.round(performance.now() - started)
    record.bytesPerSecond = Math.round(record.transferred / Math.max(record.elapsedMs / 1000, .001))
    this.save(record, true)
    // Shutdown persists a terminal receipt but must not wake a new agent turn while workers drain.
    if (!this.stopping) this.services.completed(structuredClone(record))
  }
}

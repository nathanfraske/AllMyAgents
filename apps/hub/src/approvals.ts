import crypto from 'node:crypto'
import type { Journal } from './journal.js'
import type { ApprovalRecord } from './types.js'

const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000

interface PendingEntry {
  record: ApprovalRecord
  resolve: (approved: boolean) => void
  timer: NodeJS.Timeout
}

export class ApprovalService {
  private readonly pendingMap = new Map<string, PendingEntry>()

  constructor(private readonly journal: Journal) {}

  pending(): ApprovalRecord[] {
    return [...this.pendingMap.values()].map((e) => e.record)
  }

  request(sessionId: string, kind: string, payload: unknown): Promise<boolean> {
    const record: ApprovalRecord = {
      id: crypto.randomUUID(),
      sessionId,
      kind,
      payload,
      status: 'pending',
      createdAt: new Date().toISOString(),
    }
    this.journal.append(sessionId, 'approval/requested', record)
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.finish(record.id, false, 'timeout')
      }, APPROVAL_TIMEOUT_MS)
      this.pendingMap.set(record.id, { record, resolve, timer })
    })
  }

  resolve(id: string, approved: boolean): boolean {
    return this.finish(id, approved, approved ? 'approved' : 'denied')
  }

  private finish(id: string, approved: boolean, status: ApprovalRecord['status']): boolean {
    const entry = this.pendingMap.get(id)
    if (!entry) return false
    this.pendingMap.delete(id)
    clearTimeout(entry.timer)
    entry.record.status = status
    this.journal.append(entry.record.sessionId, 'approval/resolved', {
      id: entry.record.id,
      status,
      kind: entry.record.kind,
    })
    entry.resolve(approved)
    return true
  }
}

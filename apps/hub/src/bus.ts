import crypto from 'node:crypto'
import type Database from 'better-sqlite3'
import type { SessionIdentity } from './identity.js'

/**
 * Inter-agent message bus (DESIGN D10, first slice).
 *
 * Agents send messages to a teammate (a specific session) or broadcast to their whole project.
 * A message is fanned out on send — one row per recipient session — which gives per-recipient
 * inbox + delivered/read state for free. This class is pure persistence + queries; ACL (who may
 * message whom) and DELIVERY (injecting the message into the recipient's next turn, wrapped in the
 * hub's trust frame with clamped permissions) live in SessionManager, which owns the session graph.
 */
export type BusAddress = { kind: 'session'; id: string } | { kind: 'project'; id: string }

export interface BusMessage {
  id: string
  groupId: string
  ts: string
  fromSession: string
  fromProfile: string
  fromLabel: string
  project: string | null
  toKind: 'session' | 'project'
  toId: string
  toSession: string
  subject: string | null
  body: string
  delivered: boolean
  readAt: string | null
}

interface Row extends Omit<BusMessage, 'delivered' | 'readAt'> {
  delivered: number
  readAt: string | null
}

// The subset written on insert (delivered/readAt default in SQL); keys must match the @named params.
type InsertRow = Omit<BusMessage, 'delivered' | 'readAt'>

export class AgentBus {
  private readonly db: Database.Database
  private readonly insertStmt: Database.Statement
  private readonly pendingStmt: Database.Statement
  private readonly inboxStmt: Database.Statement
  private readonly getStmt: Database.Statement

  constructor(db: Database.Database) {
    this.db = db
    db.exec(
      `CREATE TABLE IF NOT EXISTS bus_messages (
        id TEXT PRIMARY KEY, groupId TEXT NOT NULL, ts TEXT NOT NULL,
        fromSession TEXT NOT NULL, fromProfile TEXT NOT NULL, fromLabel TEXT NOT NULL,
        project TEXT, toKind TEXT NOT NULL, toId TEXT NOT NULL, toSession TEXT NOT NULL,
        subject TEXT, body TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0, readAt TEXT)`
    )
    db.exec('CREATE INDEX IF NOT EXISTS idx_bus_to ON bus_messages (toSession, ts)')
    this.insertStmt = db.prepare(
      `INSERT INTO bus_messages (id, groupId, ts, fromSession, fromProfile, fromLabel, project, toKind, toId, toSession, subject, body)
       VALUES (@id, @groupId, @ts, @fromSession, @fromProfile, @fromLabel, @project, @toKind, @toId, @toSession, @subject, @body)`
    )
    this.pendingStmt = db.prepare('SELECT * FROM bus_messages WHERE toSession = ? AND delivered = 0 ORDER BY ts ASC')
    this.inboxStmt = db.prepare('SELECT * FROM bus_messages WHERE toSession = ? ORDER BY ts DESC LIMIT ?')
    this.getStmt = db.prepare('SELECT * FROM bus_messages WHERE id = ?')
  }

  /** Fan a message out to a resolved set of recipient session ids. Returns the stored messages. */
  post(input: {
    from: SessionIdentity
    project: string | null
    to: BusAddress
    subject?: string
    body: string
    recipients: string[]
  }): BusMessage[] {
    const groupId = crypto.randomUUID()
    const ts = new Date().toISOString()
    const rows: InsertRow[] = input.recipients.map((rid) => ({
      id: crypto.randomUUID(),
      groupId,
      ts,
      fromSession: input.from.sessionId,
      fromProfile: input.from.profileId,
      fromLabel: input.from.label,
      project: input.project,
      toKind: input.to.kind,
      toId: input.to.id,
      toSession: rid,
      subject: input.subject ?? null,
      body: input.body,
    }))
    const insertMany = this.db.transaction((rs: InsertRow[]) => {
      for (const r of rs) this.insertStmt.run(r)
    })
    insertMany(rows)
    return rows.map((r) => ({ ...r, delivered: false, readAt: null }))
  }

  /** Undelivered messages queued for a session (delivery injects them into its next turn). */
  pending(sessionId: string): BusMessage[] {
    return (this.pendingStmt.all(sessionId) as Row[]).map(hydrate)
  }

  /** Recent messages addressed to a session (for the read_messages tool / UI). */
  inbox(sessionId: string, limit = 50): BusMessage[] {
    return (this.inboxStmt.all(sessionId, limit) as Row[]).map(hydrate)
  }

  markDelivered(ids: string[]): void {
    if (!ids.length) return
    this.db
      .prepare(`UPDATE bus_messages SET delivered = 1 WHERE id IN (${ids.map(() => '?').join(',')})`)
      .run(...ids)
  }

  markRead(sessionId: string, ids: string[]): void {
    if (!ids.length) return
    const now = new Date().toISOString()
    this.db
      .prepare(
        `UPDATE bus_messages SET readAt = ? WHERE toSession = ? AND readAt IS NULL AND id IN (${ids
          .map(() => '?')
          .join(',')})`
      )
      .run(now, sessionId, ...ids)
  }

  /** Operator/UI view: recent traffic, optionally filtered by project and/or a session. */
  history(opts: { project?: string; sessionId?: string; limit?: number } = {}): BusMessage[] {
    const where: string[] = []
    const params: unknown[] = []
    if (opts.project) {
      where.push('project = ?')
      params.push(opts.project)
    }
    if (opts.sessionId) {
      where.push('(toSession = ? OR fromSession = ?)')
      params.push(opts.sessionId, opts.sessionId)
    }
    const sql = `SELECT * FROM bus_messages ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ts DESC LIMIT ?`
    params.push(Math.min(opts.limit ?? 100, 500))
    return (this.db.prepare(sql).all(...params) as Row[]).map(hydrate)
  }

  get(id: string): BusMessage | undefined {
    const r = this.getStmt.get(id) as Row | undefined
    return r ? hydrate(r) : undefined
  }
}

function hydrate(r: Row): BusMessage {
  return { ...r, delivered: !!r.delivered, readAt: r.readAt }
}

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
  /** False means the message may join an already-running or operator-started turn, but may not
   *  create a new recipient turn on its own. This is durable so a hub restart cannot turn a held
   *  high-context note back into an expensive wake-up. */
  wake: boolean
  /** Hub-minted action-required mail (for example a pending approval or failure alert) bypasses the
   *  high-context FYI wake guard. Agent-authored send_message calls cannot set this bit. */
  attentionRequired: boolean
  delivered: boolean
  readAt: string | null
}

export interface BusMessageCursorItem {
  cursor: number
  message: BusMessage
}

interface Row extends Omit<BusMessage, 'wake' | 'attentionRequired' | 'delivered' | 'readAt'> {
  wake: number
  attentionRequired: number
  delivered: number
  readAt: string | null
}

// The subset written on insert (delivered/readAt default in SQL); keys must match the @named params.
// SQLite binds the durable boolean as 0/1 and hydrate restores the public boolean shape.
type InsertRow = Omit<BusMessage, 'wake' | 'attentionRequired' | 'delivered' | 'readAt'> & {
  wake: number
  attentionRequired: number
}

export class AgentBus {
  private readonly db: Database.Database
  private readonly insertStmt: Database.Statement
  private readonly pendingStmt: Database.Statement
  private readonly pendingCountsStmt: Database.Statement
  private readonly inboxStmt: Database.Statement
  private readonly getStmt: Database.Statement
  private readonly claimExternalStmt: Database.Statement
  private readonly pruneExternalStmt: Database.Statement

  constructor(db: Database.Database) {
    this.db = db
    db.exec(
      `CREATE TABLE IF NOT EXISTS bus_messages (
        id TEXT PRIMARY KEY, groupId TEXT NOT NULL, ts TEXT NOT NULL,
        fromSession TEXT NOT NULL, fromProfile TEXT NOT NULL, fromLabel TEXT NOT NULL,
        project TEXT, toKind TEXT NOT NULL, toId TEXT NOT NULL, toSession TEXT NOT NULL,
        subject TEXT, body TEXT NOT NULL, wake INTEGER NOT NULL DEFAULT 1,
        attentionRequired INTEGER NOT NULL DEFAULT 0,
        delivered INTEGER NOT NULL DEFAULT 0, readAt TEXT)`
    )
    // Additive migration for journals created before wake policy was durable. Existing mail keeps its
    // historical wake behavior; only newly held messages opt out.
    const hasWake = db.prepare("SELECT 1 FROM pragma_table_info('bus_messages') WHERE name = 'wake'").get()
    if (!hasWake) {
      try {
        db.exec('ALTER TABLE bus_messages ADD COLUMN wake INTEGER NOT NULL DEFAULT 1')
      } catch (error) {
        if (!/duplicate column/i.test(error instanceof Error ? error.message : String(error))) throw error
      }
    }
    const hasAttentionRequired = db
      .prepare("SELECT 1 FROM pragma_table_info('bus_messages') WHERE name = 'attentionRequired'")
      .get()
    if (!hasAttentionRequired) {
      try {
        db.exec('ALTER TABLE bus_messages ADD COLUMN attentionRequired INTEGER NOT NULL DEFAULT 0')
      } catch (error) {
        if (!/duplicate column/i.test(error instanceof Error ? error.message : String(error))) throw error
      }
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_bus_to ON bus_messages (toSession, ts)')
    // The session list polls constantly. Keep its one grouped count proportional to PENDING mail, not to
    // every bus row ever written; delivered messages never enter this partial index.
    db.exec('CREATE INDEX IF NOT EXISTS idx_bus_pending_to ON bus_messages (toSession) WHERE delivered = 0')
    db.exec(
      `CREATE TABLE IF NOT EXISTS bus_external_receipts (
        receiptKey TEXT PRIMARY KEY,
        receivedAt TEXT NOT NULL
      )`
    )
    this.insertStmt = db.prepare(
      `INSERT INTO bus_messages (id, groupId, ts, fromSession, fromProfile, fromLabel, project, toKind, toId, toSession, subject, body, wake, attentionRequired)
       VALUES (@id, @groupId, @ts, @fromSession, @fromProfile, @fromLabel, @project, @toKind, @toId, @toSession, @subject, @body, @wake, @attentionRequired)`
    )
    this.pendingStmt = db.prepare('SELECT * FROM bus_messages WHERE toSession = ? AND delivered = 0 ORDER BY ts ASC')
    this.pendingCountsStmt = db.prepare(
      'SELECT toSession, COUNT(*) AS count FROM bus_messages WHERE delivered = 0 GROUP BY toSession'
    )
    this.inboxStmt = db.prepare('SELECT * FROM bus_messages WHERE toSession = ? ORDER BY ts DESC LIMIT ?')
    this.getStmt = db.prepare('SELECT * FROM bus_messages WHERE id = ?')
    this.claimExternalStmt = db.prepare(
      'INSERT OR IGNORE INTO bus_external_receipts (receiptKey, receivedAt) VALUES (?, ?)'
    )
    this.pruneExternalStmt = db.prepare(
      `DELETE FROM bus_external_receipts WHERE receiptKey IN (
        SELECT receiptKey FROM bus_external_receipts ORDER BY receivedAt DESC LIMIT -1 OFFSET 10000
      )`
    )
  }

  private rowsFor(input: {
    from: SessionIdentity
    project: string | null
    to: BusAddress
    subject?: string
    body: string
    recipients: string[]
    /** Default for all recipients. Omitted preserves the historical wake-on-send behavior. */
    wake?: boolean
    /** Per-recipient automatic deferrals (for example the high-context wake guard). */
    noWakeRecipients?: readonly string[]
    /** Reserved for hub-owned control-plane mail that requires a response. Public agent sends never
     *  expose this input, so semi-trusted peers cannot manufacture priority. */
    attentionRequired?: boolean
  }): InsertRow[] {
    const groupId = crypto.randomUUID()
    const ts = new Date().toISOString()
    const noWake = new Set(input.noWakeRecipients ?? [])
    return input.recipients.map((rid) => ({
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
      wake: input.wake !== false && !noWake.has(rid) ? 1 : 0,
      attentionRequired: input.attentionRequired === true ? 1 : 0,
    }))
  }

  /** Fan a message out to a resolved set of recipient session ids. Returns the stored messages. */
  post(input: {
    from: SessionIdentity
    project: string | null
    to: BusAddress
    subject?: string
    body: string
    recipients: string[]
    wake?: boolean
    noWakeRecipients?: readonly string[]
    attentionRequired?: boolean
  }): BusMessage[] {
    const rows = this.rowsFor(input)
    const insertMany = this.db.transaction((rs: InsertRow[]) => {
      for (const r of rs) this.insertStmt.run(r)
    })
    insertMany(rows)
    return rows.map((r) => ({
      ...r,
      wake: !!r.wake,
      attentionRequired: !!r.attentionRequired,
      delivered: false,
      readAt: null,
    }))
  }

  /**
   * Atomically accept an authenticated external message exactly once and fan it into the ordinary bus.
   * A process crash cannot leave a claimed receipt without its message (or vice versa), and the bounded
   * receipt table makes a network retry harmless without becoming another unbounded journal.
   */
  postExternal(input: {
    receiptKey: string
    from: SessionIdentity
    project: string | null
    to: BusAddress
    subject?: string
    body: string
    recipients: string[]
    wake?: boolean
    noWakeRecipients?: readonly string[]
    attentionRequired?: boolean
  }): { accepted: boolean; messages: BusMessage[] } {
    const rows = this.rowsFor(input)
    const accepted = this.db.transaction(() => {
      const claim = this.claimExternalStmt.run(input.receiptKey, new Date().toISOString())
      if (claim.changes !== 1) return false
      for (const row of rows) this.insertStmt.run(row)
      this.pruneExternalStmt.run()
      return true
    })()
    return {
      accepted,
      messages: accepted
        ? rows.map((row) => ({
            ...row,
            wake: !!row.wake,
            attentionRequired: !!row.attentionRequired,
            delivered: false,
            readAt: null,
          }))
        : [],
    }
  }

  /** Undelivered messages queued for a session (delivery injects them into its next turn). */
  pending(sessionId: string): BusMessage[] {
    return (this.pendingStmt.all(sessionId) as Row[]).map(hydrate)
  }

  /** Move only undelivered mail during an operator-owned session handoff. Delivered/read history stays
   *  attached to the predecessor transcript; direct-address metadata follows the successor too. */
  retargetPending(fromSessionId: string, toSessionId: string): number {
    if (!fromSessionId || !toSessionId || fromSessionId === toSessionId) return 0
    return this.db
      .prepare(
        `UPDATE bus_messages
         SET toSession = ?,
             toId = CASE WHEN toKind = 'session' AND toId = ? THEN ? ELSE toId END
         WHERE toSession = ? AND delivered = 0`,
      )
      .run(toSessionId, fromSessionId, toSessionId, fromSessionId).changes
  }

  /** One query for the whole roster's undelivered counts. Callers join this map in memory; never issue
   *  pending(sessionId) once per session on a UI polling path. */
  pendingCounts(): Map<string, number> {
    const rows = this.pendingCountsStmt.all() as Array<{ toSession: string; count: number }>
    return new Map(rows.map((row) => [row.toSession, row.count]))
  }

  /** Recent messages addressed to a session (for the read_messages tool / UI). */
  inbox(sessionId: string, limit = 50): BusMessage[] {
    return (this.inboxStmt.all(sessionId, limit) as Row[]).map(hydrate)
  }

  /**
   * Stable, non-destructive message page for manager/Overseer queries. Scope is supplied by
   * SessionManager from authenticated lineage; callers never pass arbitrary SQL identities directly.
   * SQLite rowid is append-only for this table and therefore forms a compact cursor independent of
   * timestamp ties or UUID ordering. Reading this view never marks delivery/read state.
   */
  query(input: {
    visibleSessionIds: string[]
    fromSessionIds?: string[]
    unreadOnly?: boolean
    afterCursor?: number
    limit?: number
  }): { items: BusMessageCursorItem[]; nextCursor: number; hasMore: boolean } {
    const visible = [...new Set(input.visibleSessionIds.filter(Boolean))]
    if (!visible.length) return { items: [], nextCursor: Math.max(0, Math.trunc(input.afterCursor ?? 0)), hasMore: false }
    const where = [`toSession IN (${visible.map(() => '?').join(',')})`, 'rowid > ?']
    const params: unknown[] = [...visible, Math.max(0, Math.trunc(input.afterCursor ?? 0))]
    const from = [...new Set((input.fromSessionIds ?? []).filter(Boolean))]
    if (from.length) {
      where.push(`fromSession IN (${from.map(() => '?').join(',')})`)
      params.push(...from)
    }
    if (input.unreadOnly === true) where.push('readAt IS NULL')
    const limit = Math.max(1, Math.min(Math.trunc(input.limit ?? 50), 200))
    params.push(limit + 1)
    const rows = this.db
      .prepare(`SELECT rowid AS cursor, * FROM bus_messages WHERE ${where.join(' AND ')} ORDER BY rowid ASC LIMIT ?`)
      .all(...params) as Array<Row & { cursor: number }>
    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    return {
      items: page.map(({ cursor, ...row }) => ({ cursor, message: hydrate(row) })),
      nextCursor: page.at(-1)?.cursor ?? Math.max(0, Math.trunc(input.afterCursor ?? 0)),
      hasMore,
    }
  }

  markDelivered(ids: string[]): void {
    if (!ids.length) return
    this.db
      .prepare(`UPDATE bus_messages SET delivered = 1 WHERE id IN (${ids.map(() => '?').join(',')})`)
      .run(...ids)
  }

  /** Atomically downgrade queued mail so it cannot create an idle turn after this hub exits. */
  holdWake(ids: string[]): void {
    if (!ids.length) return
    this.db
      .prepare(`UPDATE bus_messages SET wake = 0 WHERE delivered = 0 AND id IN (${ids.map(() => '?').join(',')})`)
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
  return {
    ...r,
    wake: !!r.wake,
    attentionRequired: !!r.attentionRequired,
    delivered: !!r.delivered,
    readAt: r.readAt,
  }
}

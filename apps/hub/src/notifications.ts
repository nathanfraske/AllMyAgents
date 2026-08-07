import crypto from 'node:crypto'
import type Database from 'better-sqlite3'

export type NotificationKind =
  | 'session-completed'
  | 'session-error'
  | 'approval-required'
  | 'session-stalled'
  | 'journal-pressure'
  | 'hub-warning'

export type NotificationSeverity = 'info' | 'warning' | 'error'
export type NotificationSourceRole = 'agent' | 'manager' | 'overseer' | 'system'
export type NotificationRoute = 'operator' | 'manager' | 'overseer'

export interface NotificationPreferences {
  managerCompletions: boolean
  overseerCompletions: boolean
  agentCompletions: boolean
  errors: boolean
  approvals: boolean
  stalls: boolean
  journalPressure: boolean
  desktopEnabled: boolean
}

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  // Routine child completions are already routed to their manager. Keep the operator's desktop quiet
  // unless the completed turn belongs to a manager or the application Overseer.
  managerCompletions: true,
  overseerCompletions: true,
  agentCompletions: false,
  errors: true,
  approvals: true,
  stalls: true,
  journalPressure: true,
  // Browser/OS permission must be requested by an explicit click in Settings. The durable in-app inbox
  // is active regardless, so a fresh install never throws a surprise permission prompt.
  desktopEnabled: false,
}

export interface NotificationRecord {
  id: string
  kind: NotificationKind
  severity: NotificationSeverity
  title: string
  body: string
  sourceRole: NotificationSourceRole
  route: NotificationRoute
  sessionId?: string
  projectId?: string
  createdAt: string
  readAt?: string
  desktopEligible: boolean
  desktopDeliveredAt?: string
}

export interface PublishNotification {
  kind: NotificationKind
  severity?: NotificationSeverity
  title: string
  body: string
  sourceRole: NotificationSourceRole
  route?: NotificationRoute
  sessionId?: string
  projectId?: string
  /** Stable lifecycle/request key. A retry or hub replay cannot duplicate an operator notification. */
  dedupeKey?: string
  createdAt?: string
}

export interface NotificationCenter {
  getPreferences(): NotificationPreferences
  setPreferences(patch: Partial<NotificationPreferences>): NotificationPreferences
  publish(input: PublishNotification): NotificationRecord | undefined
  list(limit?: number): NotificationRecord[]
  unreadCount(): number
  markRead(ids?: readonly string[]): number
  markDesktopDelivered(ids: readonly string[]): number
}

const MAX_NOTIFICATIONS = 1_000
const MAX_AGE_DAYS = 30

function text(value: string, max: number): string {
  return value.trim().slice(0, max)
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function resolvedPreferences(value: unknown): NotificationPreferences {
  const raw = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  return {
    managerCompletions: bool(raw.managerCompletions, DEFAULT_NOTIFICATION_PREFERENCES.managerCompletions),
    overseerCompletions: bool(raw.overseerCompletions, DEFAULT_NOTIFICATION_PREFERENCES.overseerCompletions),
    agentCompletions: bool(raw.agentCompletions, DEFAULT_NOTIFICATION_PREFERENCES.agentCompletions),
    errors: bool(raw.errors, DEFAULT_NOTIFICATION_PREFERENCES.errors),
    approvals: bool(raw.approvals, DEFAULT_NOTIFICATION_PREFERENCES.approvals),
    stalls: bool(raw.stalls, DEFAULT_NOTIFICATION_PREFERENCES.stalls),
    journalPressure: bool(raw.journalPressure, DEFAULT_NOTIFICATION_PREFERENCES.journalPressure),
    desktopEnabled: bool(raw.desktopEnabled, DEFAULT_NOTIFICATION_PREFERENCES.desktopEnabled),
  }
}

function rowToRecord(row: Record<string, unknown>): NotificationRecord {
  return {
    id: String(row.id),
    kind: String(row.kind) as NotificationKind,
    severity: String(row.severity) as NotificationSeverity,
    title: String(row.title),
    body: String(row.body),
    sourceRole: String(row.source_role) as NotificationSourceRole,
    route: String(row.route) as NotificationRoute,
    ...(typeof row.session_id === 'string' ? { sessionId: row.session_id } : {}),
    ...(typeof row.project_id === 'string' ? { projectId: row.project_id } : {}),
    createdAt: String(row.created_at),
    ...(typeof row.read_at === 'string' ? { readAt: row.read_at } : {}),
    desktopEligible: row.desktop_eligible === 1,
    ...(typeof row.desktop_delivered_at === 'string'
      ? { desktopDeliveredAt: row.desktop_delivered_at }
      : {}),
  }
}

function notificationEnabled(
  preferences: NotificationPreferences,
  input: PublishNotification,
): boolean {
  switch (input.kind) {
    case 'session-completed':
      return input.sourceRole === 'overseer'
        ? preferences.overseerCompletions
        : input.sourceRole === 'manager'
          ? preferences.managerCompletions
          : preferences.agentCompletions
    case 'session-error': return preferences.errors
    case 'approval-required': return preferences.approvals
    case 'session-stalled': return preferences.stalls
    case 'journal-pressure': return preferences.journalPressure
    case 'hub-warning': return true
  }
}

/**
 * A bounded durable operator inbox.
 *
 * It intentionally does not mirror routine notifications into `events`: doing so would turn the alert
 * system into another journal-growth multiplier. The source lifecycle/approval remains in the journal;
 * this table is a replaceable delivery projection with a hard count and age bound.
 */
export class NotificationService implements NotificationCenter {
  private preferences: NotificationPreferences

  constructor(private readonly db: Database.Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS notification_preferences (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS notification_inbox (
        id TEXT PRIMARY KEY,
        dedupe_key TEXT UNIQUE,
        kind TEXT NOT NULL,
        severity TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        source_role TEXT NOT NULL,
        route TEXT NOT NULL,
        session_id TEXT,
        project_id TEXT,
        created_at TEXT NOT NULL,
        read_at TEXT,
        desktop_eligible INTEGER NOT NULL CHECK (desktop_eligible IN (0, 1)),
        desktop_delivered_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_notification_inbox_created
        ON notification_inbox(created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_notification_inbox_unread
        ON notification_inbox(read_at, created_at DESC);
    `)
    const saved = this.db
      .prepare('SELECT value FROM notification_preferences WHERE singleton = 1')
      .get() as { value?: unknown } | undefined
    let parsed: unknown
    try {
      parsed = typeof saved?.value === 'string' ? JSON.parse(saved.value) : undefined
    } catch {
      parsed = undefined
    }
    this.preferences = resolvedPreferences(parsed)
  }

  getPreferences(): NotificationPreferences {
    return { ...this.preferences }
  }

  setPreferences(patch: Partial<NotificationPreferences>): NotificationPreferences {
    this.preferences = resolvedPreferences({ ...this.preferences, ...patch })
    const now = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO notification_preferences (singleton, value, updated_at)
         VALUES (1, ?, ?)
         ON CONFLICT(singleton) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(JSON.stringify(this.preferences), now)
    return this.getPreferences()
  }

  private enabled(input: PublishNotification): boolean {
    return notificationEnabled(this.preferences, input)
  }

  publish(input: PublishNotification): NotificationRecord | undefined {
    if (!this.enabled(input)) return undefined
    const createdAt = input.createdAt ?? new Date().toISOString()
    const id = crypto.randomUUID()
    const dedupeKey = input.dedupeKey ? text(input.dedupeKey, 300) : null
    const desktopEligible = this.preferences.desktopEnabled ? 1 : 0
    const insert = this.db
      .prepare(
        `INSERT OR IGNORE INTO notification_inbox
          (id, dedupe_key, kind, severity, title, body, source_role, route, session_id, project_id,
           created_at, desktop_eligible)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        dedupeKey,
        input.kind,
        input.severity ?? 'info',
        text(input.title, 180),
        text(input.body, 2_000),
        input.sourceRole,
        input.route ?? 'operator',
        input.sessionId ? text(input.sessionId, 256) : null,
        input.projectId ? text(input.projectId, 256) : null,
        createdAt,
        desktopEligible,
      )
    this.prune(createdAt)
    const row = this.db
      .prepare('SELECT * FROM notification_inbox WHERE id = ? OR (? IS NOT NULL AND dedupe_key = ?) LIMIT 1')
      .get(insert.changes ? id : '', dedupeKey, dedupeKey) as Record<string, unknown> | undefined
    return row ? rowToRecord(row) : undefined
  }

  list(limit = 100): NotificationRecord[] {
    const bounded = Math.max(1, Math.min(250, Math.trunc(limit)))
    return (this.db
      .prepare('SELECT * FROM notification_inbox ORDER BY created_at DESC, id DESC LIMIT ?')
      .all(bounded) as Array<Record<string, unknown>>).map(rowToRecord)
  }

  unreadCount(): number {
    const value = this.db
      .prepare('SELECT COUNT(*) FROM notification_inbox WHERE read_at IS NULL')
      .pluck()
      .get()
    return typeof value === 'number' ? value : 0
  }

  markRead(ids?: readonly string[]): number {
    const now = new Date().toISOString()
    if (!ids?.length) {
      return this.db.prepare('UPDATE notification_inbox SET read_at = ? WHERE read_at IS NULL').run(now).changes
    }
    const clean = [...new Set(ids.map((id) => text(id, 256)).filter(Boolean))].slice(0, 250)
    if (!clean.length) return 0
    const placeholders = clean.map(() => '?').join(', ')
    return this.db
      .prepare(`UPDATE notification_inbox SET read_at = COALESCE(read_at, ?) WHERE id IN (${placeholders})`)
      .run(now, ...clean).changes
  }

  markDesktopDelivered(ids: readonly string[]): number {
    const clean = [...new Set(ids.map((id) => text(id, 256)).filter(Boolean))].slice(0, 100)
    if (!clean.length) return 0
    const placeholders = clean.map(() => '?').join(', ')
    return this.db
      .prepare(
        `UPDATE notification_inbox
         SET desktop_delivered_at = COALESCE(desktop_delivered_at, ?)
         WHERE desktop_eligible = 1 AND id IN (${placeholders})`,
      )
      .run(new Date().toISOString(), ...clean).changes
  }

  private prune(now: string): void {
    const cutoff = new Date(Date.parse(now) - MAX_AGE_DAYS * 24 * 60 * 60_000).toISOString()
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM notification_inbox WHERE created_at < ?').run(cutoff)
      this.db.prepare(
        `DELETE FROM notification_inbox
         WHERE id IN (
           SELECT id FROM notification_inbox
           ORDER BY created_at DESC, id DESC
           LIMIT -1 OFFSET ?
         )`,
      ).run(MAX_NOTIFICATIONS)
    })
    tx()
  }
}

/**
 * Lightweight fallback for embedders that intentionally provide a partial Journal implementation.
 * Production always injects the durable SQLite-backed service from index.ts; keeping this fallback
 * bounded lets API contract tests and small third-party hosts use startServer without manufacturing a
 * database solely for notifications.
 */
export class EphemeralNotificationService implements NotificationCenter {
  private preferences = { ...DEFAULT_NOTIFICATION_PREFERENCES }
  private records: NotificationRecord[] = []
  private readonly dedupe = new Map<string, NotificationRecord>()

  getPreferences(): NotificationPreferences {
    return { ...this.preferences }
  }

  setPreferences(patch: Partial<NotificationPreferences>): NotificationPreferences {
    this.preferences = resolvedPreferences({ ...this.preferences, ...patch })
    return this.getPreferences()
  }

  publish(input: PublishNotification): NotificationRecord | undefined {
    if (!notificationEnabled(this.preferences, input)) return undefined
    if (input.dedupeKey) {
      const existing = this.dedupe.get(text(input.dedupeKey, 300))
      if (existing) return { ...existing }
    }
    const record: NotificationRecord = {
      id: crypto.randomUUID(),
      kind: input.kind,
      severity: input.severity ?? 'info',
      title: text(input.title, 180),
      body: text(input.body, 2_000),
      sourceRole: input.sourceRole,
      route: input.route ?? 'operator',
      ...(input.sessionId ? { sessionId: text(input.sessionId, 256) } : {}),
      ...(input.projectId ? { projectId: text(input.projectId, 256) } : {}),
      createdAt: input.createdAt ?? new Date().toISOString(),
      desktopEligible: this.preferences.desktopEnabled,
    }
    this.records.unshift(record)
    this.records = this.records.slice(0, MAX_NOTIFICATIONS)
    if (input.dedupeKey) this.dedupe.set(text(input.dedupeKey, 300), record)
    return { ...record }
  }

  list(limit = 100): NotificationRecord[] {
    const bounded = Math.max(1, Math.min(250, Math.trunc(limit)))
    return this.records.slice(0, bounded).map((record) => ({ ...record }))
  }

  unreadCount(): number {
    return this.records.filter((record) => !record.readAt).length
  }

  markRead(ids?: readonly string[]): number {
    const selected = ids?.length ? new Set(ids) : undefined
    const now = new Date().toISOString()
    let changed = 0
    for (const record of this.records) {
      if (record.readAt || (selected && !selected.has(record.id))) continue
      record.readAt = now
      changed += 1
    }
    return changed
  }

  markDesktopDelivered(ids: readonly string[]): number {
    const selected = new Set(ids)
    const now = new Date().toISOString()
    let changed = 0
    for (const record of this.records) {
      if (!selected.has(record.id) || !record.desktopEligible || record.desktopDeliveredAt) continue
      record.desktopDeliveredAt = now
      changed += 1
    }
    return changed
  }
}

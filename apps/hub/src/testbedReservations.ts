import crypto from 'node:crypto'
import type Database from 'better-sqlite3'

export type TestbedReservationState = 'active' | 'released' | 'expired' | 'interrupted'

export interface TestbedReservation {
  id: string
  projectId: string
  replicaId: string
  sessionId: string
  agentId: string
  state: TestbedReservationState
  acquiredAt: string
  expiresAt: string
  releasedAt?: string
  reason?: string
}

interface ReservationRow {
  id: string
  projectId: string
  replicaId: string
  sessionId: string
  agentId: string
  state: TestbedReservationState
  acquiredAt: string
  expiresAt: string
  releasedAt: string | null
  reason: string | null
}

function fromRow(row: ReservationRow | undefined): TestbedReservation | undefined {
  if (!row) return undefined
  return {
    id: row.id,
    projectId: row.projectId,
    replicaId: row.replicaId,
    sessionId: row.sessionId,
    agentId: row.agentId,
    state: row.state,
    acquiredAt: row.acquiredAt,
    expiresAt: row.expiresAt,
    ...(row.releasedAt ? { releasedAt: row.releasedAt } : {}),
    ...(row.reason ? { reason: row.reason } : {}),
  }
}

export class TestbedReservationConflictError extends Error {
  constructor(readonly reservation: TestbedReservation) {
    super(`Testbed location is reserved by agent ${reservation.agentId} until ${reservation.expiresAt}.`)
  }
}

/**
 * Source-hub lease ledger. A partial unique index is the concurrency boundary: at most one active
 * execution may own a replica, even when two agent calls race through separate async turns.
 */
export class TestbedReservationStore {
  private readonly insertStmt: Database.Statement
  private readonly getStmt: Database.Statement
  private readonly activeStmt: Database.Statement
  private readonly staleStmt: Database.Statement
  private readonly expireStmt: Database.Statement
  private readonly releaseStmt: Database.Statement
  private readonly activeAllStmt: Database.Statement
  private readonly activeProjectStmt: Database.Statement
  private readonly interruptStmt: Database.Statement
  private readonly listProjectStmt: Database.Statement
  private readonly acquireTx: (input: {
    projectId: string
    replicaId: string
    sessionId: string
    agentId: string
    ttlMs: number
  }) => { reservation?: TestbedReservation; conflict?: TestbedReservation; expired: TestbedReservation[] }

  constructor(private readonly db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS testbed_reservations (
        id TEXT PRIMARY KEY,
        projectId TEXT NOT NULL,
        replicaId TEXT NOT NULL,
        sessionId TEXT NOT NULL,
        agentId TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('active', 'released', 'expired', 'interrupted')),
        acquiredAt TEXT NOT NULL,
        expiresAt TEXT NOT NULL,
        releasedAt TEXT,
        reason TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS testbed_reservations_active_replica_idx
        ON testbed_reservations(replicaId) WHERE state = 'active';
      CREATE INDEX IF NOT EXISTS testbed_reservations_project_idx
        ON testbed_reservations(projectId, acquiredAt DESC);
    `)
    this.insertStmt = db.prepare(`
      INSERT INTO testbed_reservations (
        id, projectId, replicaId, sessionId, agentId, state, acquiredAt, expiresAt
      ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
    `)
    this.getStmt = db.prepare('SELECT * FROM testbed_reservations WHERE id = ?')
    this.activeStmt = db.prepare("SELECT * FROM testbed_reservations WHERE replicaId = ? AND state = 'active' AND expiresAt > ?")
    this.staleStmt = db.prepare("SELECT * FROM testbed_reservations WHERE state = 'active' AND expiresAt <= ?")
    this.expireStmt = db.prepare(`
      UPDATE testbed_reservations
      SET state = 'expired', releasedAt = ?, reason = 'lease-expired'
      WHERE id = ? AND state = 'active'
    `)
    this.releaseStmt = db.prepare(`
      UPDATE testbed_reservations
      SET state = 'released', releasedAt = ?, reason = ?
      WHERE id = ? AND state = 'active'
    `)
    this.activeAllStmt = db.prepare("SELECT * FROM testbed_reservations WHERE state = 'active' ORDER BY acquiredAt ASC")
    this.activeProjectStmt = db.prepare(
      "SELECT * FROM testbed_reservations WHERE projectId = ? AND state = 'active' AND expiresAt > ? ORDER BY acquiredAt ASC",
    )
    this.interruptStmt = db.prepare(`
      UPDATE testbed_reservations
      SET state = 'interrupted', releasedAt = ?, reason = 'source-restart'
      WHERE id = ? AND state = 'active'
    `)
    this.listProjectStmt = db.prepare(`
      SELECT * FROM testbed_reservations WHERE projectId = ?
      ORDER BY CASE WHEN state = 'active' AND expiresAt > ? THEN 0 ELSE 1 END, acquiredAt DESC LIMIT ?
    `)
    this.acquireTx = db.transaction((input) => {
      const now = new Date().toISOString()
      const expiredRows = this.staleStmt.all(now) as ReservationRow[]
      for (const row of expiredRows) this.expireStmt.run(now, row.id)
      const expired = expiredRows.map((row) => fromRow({
        ...row,
        state: 'expired',
        releasedAt: now,
        reason: 'lease-expired',
      })!)
      const id = crypto.randomUUID()
      const expiresAt = new Date(Date.now() + input.ttlMs).toISOString()
      try {
        this.insertStmt.run(
          id,
          input.projectId,
          input.replicaId,
          input.sessionId,
          input.agentId,
          now,
          expiresAt,
        )
      } catch (error) {
        const conflict = fromRow(this.activeStmt.get(input.replicaId, now) as ReservationRow | undefined)
        if (conflict) return { conflict, expired }
        throw error
      }
      return { reservation: this.get(id)!, expired }
    })
  }

  acquire(input: {
    projectId: string
    replicaId: string
    sessionId: string
    agentId: string
    ttlMs?: number
  }): { reservation: TestbedReservation; expired: TestbedReservation[] } {
    const ttlMs = Math.max(10_000, Math.min(Math.trunc(input.ttlMs ?? 180_000), 15 * 60_000))
    const result = this.acquireTx({ ...input, ttlMs })
    if (result.conflict) throw new TestbedReservationConflictError(result.conflict)
    return { reservation: result.reservation!, expired: result.expired }
  }

  get(id: string): TestbedReservation | undefined {
    return fromRow(this.getStmt.get(id) as ReservationRow | undefined)
  }

  active(replicaId: string): TestbedReservation | undefined {
    return fromRow(this.activeStmt.get(replicaId, new Date().toISOString()) as ReservationRow | undefined)
  }

  activeProject(projectId: string): TestbedReservation[] {
    return (this.activeProjectStmt.all(projectId, new Date().toISOString()) as ReservationRow[])
      .map((row) => fromRow(row)!)
  }

  release(id: string, reason = 'run-finished'): TestbedReservation | undefined {
    this.releaseStmt.run(new Date().toISOString(), reason.slice(0, 200), id)
    return this.get(id)
  }

  listProject(projectId: string, limit = 50): TestbedReservation[] {
    const bounded = Math.max(1, Math.min(Math.trunc(limit) || 50, 200))
    const now = new Date().toISOString()
    return (this.listProjectStmt.all(projectId, now, bounded) as ReservationRow[]).map((row) => {
      if (row.state !== 'active' || row.expiresAt > now) return fromRow(row)!
      return fromRow({
        ...row,
        state: 'expired',
        releasedAt: row.releasedAt ?? row.expiresAt,
        reason: row.reason ?? 'lease-expired',
      })!
    })
  }

  /** Called only by the process that owns the public hub role. */
  reconcileInterrupted(): TestbedReservation[] {
    const active = (this.activeAllStmt.all() as ReservationRow[]).map((row) => fromRow(row)!)
    if (!active.length) return []
    const releasedAt = new Date().toISOString()
    for (const reservation of active) this.interruptStmt.run(releasedAt, reservation.id)
    return active.map((reservation) => ({
      ...reservation,
      state: 'interrupted',
      releasedAt,
      reason: 'source-restart',
    }))
  }
}

import crypto from 'node:crypto'
import type Database from 'better-sqlite3'
import type { RemoteDeviceActionResult } from './remoteDevices.js'

export type TestbedRunState = 'running' | 'succeeded' | 'failed' | 'cancelled'

export interface TestbedRun {
  id: string
  projectId: string
  replicaId: string
  sessionId: string
  agentId: string
  profileId: string
  operation: 'exec'
  state: TestbedRunState
  commandSummary: string
  commandSha256: string
  baseCommit?: string
  createdAt: string
  startedAt: string
  completedAt?: string
  exitCode?: number | null
  failureStage?: string
  error?: string
  telemetry?: RemoteDeviceActionResult['telemetry']
}

interface TestbedRunRow {
  id: string
  projectId: string
  replicaId: string
  sessionId: string
  agentId: string
  profileId: string
  operation: 'exec'
  state: TestbedRunState
  commandSummary: string
  commandSha256: string
  baseCommit: string | null
  createdAt: string
  startedAt: string
  completedAt: string | null
  exitCode: number | null
  failureStage: string | null
  error: string | null
  telemetryJson: string | null
}

function fromRow(row: TestbedRunRow): TestbedRun {
  let telemetry: RemoteDeviceActionResult['telemetry']
  try {
    telemetry = row.telemetryJson ? JSON.parse(row.telemetryJson) as RemoteDeviceActionResult['telemetry'] : undefined
  } catch {
    telemetry = undefined
  }
  return {
    id: row.id,
    projectId: row.projectId,
    replicaId: row.replicaId,
    sessionId: row.sessionId,
    agentId: row.agentId,
    profileId: row.profileId,
    operation: row.operation,
    state: row.state,
    commandSummary: row.commandSummary,
    commandSha256: row.commandSha256,
    ...(row.baseCommit ? { baseCommit: row.baseCommit } : {}),
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    ...(row.completedAt ? { completedAt: row.completedAt } : {}),
    ...(row.completedAt ? { exitCode: row.exitCode } : {}),
    ...(row.failureStage ? { failureStage: row.failureStage } : {}),
    ...(row.error ? { error: row.error } : {}),
    ...(telemetry ? { telemetry } : {}),
  }
}

/** Durable source-hub ledger for explicitly attributed executions on project replicas. */
export class TestbedRunStore {
  private readonly insertStmt: Database.Statement
  private readonly finishStmt: Database.Statement
  private readonly listProjectStmt: Database.Statement
  private readonly getStmt: Database.Statement
  private readonly runningStmt: Database.Statement
  private readonly interruptStmt: Database.Statement

  constructor(private readonly db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS testbed_runs (
        id TEXT PRIMARY KEY,
        projectId TEXT NOT NULL,
        replicaId TEXT NOT NULL,
        sessionId TEXT NOT NULL,
        agentId TEXT NOT NULL,
        profileId TEXT NOT NULL,
        operation TEXT NOT NULL CHECK (operation = 'exec'),
        state TEXT NOT NULL CHECK (state IN ('running', 'succeeded', 'failed', 'cancelled')),
        commandSummary TEXT NOT NULL,
        commandSha256 TEXT NOT NULL,
        baseCommit TEXT,
        createdAt TEXT NOT NULL,
        startedAt TEXT NOT NULL,
        completedAt TEXT,
        exitCode INTEGER,
        failureStage TEXT,
        error TEXT,
        telemetryJson TEXT
      );
      CREATE INDEX IF NOT EXISTS testbed_runs_project_idx ON testbed_runs(projectId, createdAt DESC);
      CREATE INDEX IF NOT EXISTS testbed_runs_agent_idx ON testbed_runs(agentId, createdAt DESC);
    `)
    this.insertStmt = db.prepare(`
      INSERT INTO testbed_runs (
        id, projectId, replicaId, sessionId, agentId, profileId, operation, state,
        commandSummary, commandSha256, baseCommit, createdAt, startedAt
      ) VALUES (?, ?, ?, ?, ?, ?, 'exec', 'running', ?, ?, ?, ?, ?)
    `)
    this.finishStmt = db.prepare(`
      UPDATE testbed_runs
      SET state = ?, completedAt = ?, exitCode = ?, failureStage = ?, error = ?, telemetryJson = ?
      WHERE id = ? AND state = 'running'
    `)
    this.listProjectStmt = db.prepare('SELECT * FROM testbed_runs WHERE projectId = ? ORDER BY createdAt DESC LIMIT ?')
    this.getStmt = db.prepare('SELECT * FROM testbed_runs WHERE id = ?')
    this.runningStmt = db.prepare("SELECT * FROM testbed_runs WHERE state = 'running' ORDER BY createdAt ASC")
    this.interruptStmt = db.prepare(`
      UPDATE testbed_runs
      SET state = 'cancelled', completedAt = ?, failureStage = 'source-restart', error = ?
      WHERE id = ? AND state = 'running'
    `)
  }

  start(input: {
    projectId: string
    replicaId: string
    sessionId: string
    agentId: string
    profileId: string
    command: string
    baseCommit?: string
  }): TestbedRun {
    const now = new Date().toISOString()
    const id = crypto.randomUUID()
    const commandSummary = input.command.trim().replace(/\s+/gu, ' ').slice(0, 500)
    const commandSha256 = crypto.createHash('sha256').update(input.command).digest('hex')
    this.insertStmt.run(
      id,
      input.projectId,
      input.replicaId,
      input.sessionId,
      input.agentId,
      input.profileId,
      commandSummary,
      commandSha256,
      input.baseCommit ?? null,
      now,
      now,
    )
    return this.get(id)!
  }

  finish(id: string, result: RemoteDeviceActionResult): TestbedRun | undefined {
    const completedAt = new Date().toISOString()
    this.finishStmt.run(
      result.ok ? 'succeeded' : 'failed',
      completedAt,
      result.exitCode ?? null,
      result.failure?.stage ?? null,
      result.error?.slice(0, 2_000) ?? null,
      result.telemetry ? JSON.stringify(result.telemetry) : null,
      id,
    )
    return this.get(id)
  }

  get(id: string): TestbedRun | undefined {
    const row = this.getStmt.get(id) as TestbedRunRow | undefined
    return row ? fromRow(row) : undefined
  }

  listProject(projectId: string, limit = 50): TestbedRun[] {
    const bounded = Math.max(1, Math.min(Math.trunc(limit) || 50, 200))
    return (this.listProjectStmt.all(projectId, bounded) as TestbedRunRow[]).map(fromRow)
  }

  /** Called only after this process owns the public hub role; a green must never cancel blue's live rows. */
  reconcileInterrupted(): TestbedRun[] {
    const running = (this.runningStmt.all() as TestbedRunRow[]).map(fromRow)
    if (!running.length) return []
    const completedAt = new Date().toISOString()
    const error = 'Source hub restarted before the remote execution outcome was observed.'
    for (const run of running) this.interruptStmt.run(completedAt, error, run.id)
    return running.map((run) => ({
      ...run,
      state: 'cancelled',
      completedAt,
      failureStage: 'source-restart',
      error,
    }))
  }
}

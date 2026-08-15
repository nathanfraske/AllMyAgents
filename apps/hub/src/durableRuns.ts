import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFile, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import type Database from 'better-sqlite3'
import type { RemoteDeviceActionResult } from './remoteDevices.js'

export type DurableRunKind = 'build' | 'test' | 'lint' | 'benchmark' | 'deploy' | 'custom'
/** SQLite keeps one non-null scope key for every run. Application-scoped Overseer runs use this reserved
 * value rather than inventing a project association for ad-hoc diagnostics and host maintenance. */
export const APPLICATION_RUN_SCOPE_ID = '__allmyagents_application__'
export type DurableRunState =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'outcome_unknown'

export interface DurableRunProvenance {
  version: 1 | 2
  capturedAt: string
  platform: string
  architecture: string
  cwd: string
  commandSha256: string
  environmentScope: 'execution' | 'source-hub'
  environmentSha256: string
  environmentKeys: string[]
  git?: {
    head?: string
    ref?: string
    dirty: boolean
    sourceManifestSha256: string
    sourceFiles: number
    complete: boolean
    error?: string
  }
  lockfiles: Array<{ path: string; sha256: string }>
  /** Present for remote execution. Top-level platform/architecture/cwd describe the target; this block
   * preserves the source checkout identity separately so a cross-architecture result does not claim
   * that the source hub was the machine under test. */
  source?: {
    platform: string
    architecture: string
    cwd: string
    environmentSha256: string
    environmentKeys: string[]
    git?: DurableRunProvenance['git']
    lockfiles: Array<{ path: string; sha256: string }>
  }
  execution?: DurableRunExecutionEnvironment
}

export interface DurableRunExecutionEnvironment {
  platform: string
  architecture: string
  cwd: string
  environmentId: string
  observedAt: string
  fingerprintSha256: string
  hostname?: string
  shell?: string
  cpuCount?: number
  availableCpuCount?: number
  totalMemoryBytes?: number
  transport?: 'myownmesh-rpc' | 'site'
  nodeKind?: 'hub' | 'lightweight-testbed'
  buildId?: string
}

export type DurableRunExecutionTarget =
  | { kind: 'local' }
  | { kind: 'remote'; siteId: string; rootId: string; command: string; cwd?: string }

export interface DurableRun {
  id: string
  projectId: string
  sessionId: string
  actorSessionId: string
  actorLabel: string
  targetSessionId: string
  executionTarget: DurableRunExecutionTarget
  kind: DurableRunKind
  state: DurableRunState
  executable: string
  args: string[]
  cwd: string
  commandSummary: string
  commandSha256: string
  resources: string[]
  provenance: DurableRunProvenance
  createdAt: string
  startedAt?: string
  heartbeatAt?: string
  completedAt?: string
  exitCode?: number | null
  signal?: string
  error?: string
  timeoutMs: number
  cancelRequested: boolean
  stdoutBytes: number
  stderrBytes: number
  logsTruncated: boolean
  result?: unknown
}

export interface DurableRunLogPage {
  stdout: string
  stderr: string
  nextStdoutCursor: number
  nextStderrCursor: number
  stdoutComplete: boolean
  stderrComplete: boolean
}

export interface DurableRunStartInput {
  projectId: string
  sessionId: string
  actorSessionId: string
  actorLabel: string
  targetSessionId: string
  kind: DurableRunKind
  executable: string
  args: string[]
  cwd: string
  resources: string[]
  timeoutMs: number
  environment?: Record<string, string>
  executionTarget?: DurableRunExecutionTarget
  /** Hub-observed target identity, never agent-authored. */
  executionEnvironment?: DurableRunExecutionEnvironment
}

interface RunRow {
  id: string
  projectId: string
  sessionId: string
  actorSessionId: string
  actorLabel: string
  targetSessionId: string
  executionTargetJson: string
  kind: DurableRunKind
  state: DurableRunState
  executable: string
  argsJson: string
  cwd: string
  commandSummary: string
  commandSha256: string
  resourcesJson: string
  provenanceJson: string
  environmentJson: string | null
  createdAt: string
  startedAt: string | null
  heartbeatAt: string | null
  completedAt: string | null
  exitCode: number | null
  signal: string | null
  error: string | null
  timeoutMs: number
  cancelRequested: number
  stdoutBytes: number
  stderrBytes: number
  logsTruncated: number
  resultJson: string | null
}

interface DurableRunJournal {
  readonly db: Database.Database
  append(sessionId: string | null, kind: string, payload: unknown): unknown
}

const MAX_LOG_BYTES_PER_STREAM = 16 * 1024 * 1024
const MAX_LOG_READ_BYTES = 64 * 1024
const MAX_SOURCE_FILES = 10_000
const MAX_SOURCE_BYTES = 512 * 1024 * 1024
const LOCKFILE_NAMES = [
  'Cargo.lock',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'uv.lock',
  'poetry.lock',
  'Pipfile.lock',
  'go.sum',
  'gradle.lockfile',
]

function jsonArray(raw: string): string[] {
  try {
    const value: unknown = JSON.parse(raw)
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function fromRow(row: RunRow | undefined): DurableRun | undefined {
  if (!row) return undefined
  let provenance: DurableRunProvenance
  try {
    provenance = JSON.parse(row.provenanceJson) as DurableRunProvenance
  } catch {
    provenance = {
      version: 1,
      capturedAt: row.createdAt,
      platform: 'unknown',
      architecture: 'unknown',
      cwd: row.cwd,
      commandSha256: row.commandSha256,
      environmentScope: 'source-hub',
      environmentSha256: crypto.createHash('sha256').update('unknown').digest('hex'),
      environmentKeys: [],
      lockfiles: [],
    }
  }
  return {
    id: row.id,
    projectId: row.projectId,
    sessionId: row.sessionId,
    actorSessionId: row.actorSessionId,
    actorLabel: row.actorLabel,
    targetSessionId: row.targetSessionId,
    executionTarget: (() => {
      try {
        return JSON.parse(row.executionTargetJson) as DurableRunExecutionTarget
      } catch {
        return { kind: 'local' as const }
      }
    })(),
    kind: row.kind,
    state: row.state,
    executable: row.executable,
    args: jsonArray(row.argsJson),
    cwd: row.cwd,
    commandSummary: row.commandSummary,
    commandSha256: row.commandSha256,
    resources: jsonArray(row.resourcesJson),
    provenance,
    createdAt: row.createdAt,
    ...(row.startedAt ? { startedAt: row.startedAt } : {}),
    ...(row.heartbeatAt ? { heartbeatAt: row.heartbeatAt } : {}),
    ...(row.completedAt ? { completedAt: row.completedAt, exitCode: row.exitCode } : {}),
    ...(row.signal ? { signal: row.signal } : {}),
    ...(row.error ? { error: row.error } : {}),
    timeoutMs: row.timeoutMs,
    cancelRequested: row.cancelRequested === 1,
    stdoutBytes: row.stdoutBytes,
    stderrBytes: row.stderrBytes,
    logsTruncated: row.logsTruncated === 1,
    ...(() => {
      try {
        return row.resultJson ? { result: JSON.parse(row.resultJson) as unknown } : {}
      } catch {
        return {}
      }
    })(),
  }
}

function boundedText(value: string, maximum: number): string {
  return value.replace(/[\u0000-\u001f\u007f]/gu, ' ').trim().slice(0, maximum)
}

function commandIdentity(
  executable: string,
  args: readonly string[],
  cwd: string,
  executionTarget: DurableRunExecutionTarget,
  environmentSha256: string,
): string {
  return crypto.createHash('sha256')
    .update(JSON.stringify({ executable, args, cwd, executionTarget, environmentSha256 }))
    .digest('hex')
}

function summarizeCommand(executable: string, args: readonly string[]): string {
  return [executable, ...args].map((part) => (/\s/u.test(part) ? JSON.stringify(part) : part)).join(' ').slice(0, 1_000)
}

function hashFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(file)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.once('error', reject)
    stream.once('end', () => resolve(hash.digest('hex')))
  })
}

function git(cwd: string, args: string[], maxBuffer = 8 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || error.message || 'git failed').trim()))
        return
      }
      resolve(stdout)
    })
  })
}

/**
 * Capture an exact identity for the inputs that differ from HEAD. HEAD + every changed/untracked file
 * content hash is sufficient to reproduce the working source without copying a potentially enormous diff
 * into the journal. `complete:false` is explicit when a bounded scan cannot prove the whole manifest.
 */
export async function captureRunProvenance(input: {
  executable: string
  args: string[]
  cwd: string
  executionTarget?: DurableRunExecutionTarget
  environment?: Record<string, string>
  executionEnvironment?: DurableRunExecutionEnvironment
}): Promise<DurableRunProvenance> {
  const cwd = path.resolve(input.cwd)
  const environment = safeEnvironment(input.environment)
  const environmentKeys = Object.keys(environment).sort()
  const environmentSha256 = crypto.createHash('sha256')
    .update(JSON.stringify(environmentKeys.map((key) => [key, environment[key]])))
    .digest('hex')
  const commandSha256 = commandIdentity(
    input.executable,
    input.args,
    cwd,
    input.executionTarget ?? { kind: 'local' },
    input.executionEnvironment?.fingerprintSha256 ?? environmentSha256,
  )
  const provenance: DurableRunProvenance = {
    version: 1,
    capturedAt: new Date().toISOString(),
    platform: process.platform,
    architecture: process.arch,
    cwd,
    commandSha256,
    environmentScope: input.executionTarget?.kind === 'remote' ? 'source-hub' : 'execution',
    environmentSha256,
    environmentKeys,
    lockfiles: [],
  }
  for (const name of LOCKFILE_NAMES) {
    const file = path.join(cwd, name)
    try {
      if ((await fs.promises.stat(file)).isFile()) provenance.lockfiles.push({ path: name, sha256: await hashFile(file) })
    } catch {
      // An absent lockfile carries no identity. A present-but-unreadable source is reflected below by Git.
    }
  }
  try {
    const head = (await git(cwd, ['rev-parse', '--verify', 'HEAD'])).trim()
    let ref: string | undefined
    try {
      ref = (await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim() || undefined
    } catch {
      // Detached HEAD is reproducible through the exact commit; it is not a failed provenance capture.
      ref = undefined
    }
    const changed = (await git(cwd, ['diff', '--name-only', '-z', 'HEAD', '--'])).split('\0').filter(Boolean)
    const untracked = (await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean)
    const files = [...new Set([...changed, ...untracked])].sort()
    let complete = files.length <= MAX_SOURCE_FILES
    let sourceBytes = 0
    const manifest = crypto.createHash('sha256')
    for (const relative of files.slice(0, MAX_SOURCE_FILES)) {
      const absolute = path.resolve(cwd, relative)
      if (absolute !== cwd && !absolute.startsWith(`${cwd}${path.sep}`)) {
        complete = false
        continue
      }
      try {
        const stat = await fs.promises.lstat(absolute)
        if (stat.isFile() && sourceBytes + stat.size > MAX_SOURCE_BYTES) {
          complete = false
          manifest.update(`${relative}\0omitted-byte-budget:${stat.size}\0`)
          continue
        }
        if (stat.isFile()) sourceBytes += stat.size
        if (!stat.isFile() && !stat.isSymbolicLink()) complete = false
        const identity = stat.isSymbolicLink()
          ? crypto.createHash('sha256').update(`symlink\0${await fs.promises.readlink(absolute)}`).digest('hex')
          : stat.isFile()
            ? await hashFile(absolute)
            : 'non-file'
        manifest.update(`${relative}\0${identity}\0`)
      } catch {
        manifest.update(`${relative}\0deleted-or-unreadable\0`)
      }
    }
    provenance.git = {
      head,
      ...(ref ? { ref } : {}),
      dirty: files.length > 0,
      sourceManifestSha256: manifest.digest('hex'),
      sourceFiles: files.length,
      complete,
      ...(!complete ? {
        error: `source manifest exceeded its ${MAX_SOURCE_FILES}-file/${MAX_SOURCE_BYTES}-byte budget or contained an unsupported non-file input`,
      } : {}),
    }
  } catch (error) {
    provenance.git = {
      dirty: false,
      sourceManifestSha256: crypto.createHash('sha256').update('not-a-git-checkout').digest('hex'),
      sourceFiles: 0,
      complete: false,
      error: boundedText(error instanceof Error ? error.message : String(error), 500),
    }
  }
  if (input.executionEnvironment) {
    provenance.version = 2
    provenance.source = {
      platform: provenance.platform,
      architecture: provenance.architecture,
      cwd: provenance.cwd,
      environmentSha256: provenance.environmentSha256,
      environmentKeys: [...provenance.environmentKeys],
      ...(provenance.git ? { git: { ...provenance.git } } : {}),
      lockfiles: provenance.lockfiles.map((item) => ({ ...item })),
    }
    provenance.platform = input.executionEnvironment.platform
    provenance.architecture = input.executionEnvironment.architecture
    provenance.cwd = input.executionEnvironment.cwd
    provenance.environmentScope = 'execution'
    provenance.environmentSha256 = input.executionEnvironment.fingerprintSha256
    provenance.environmentKeys = []
    provenance.execution = { ...input.executionEnvironment }
  }
  return provenance
}

function safeEnvironment(overrides: Record<string, string> | undefined): NodeJS.ProcessEnv {
  const allowed = [
    'PATH', 'Path', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'HOME', 'USERPROFILE',
    'LOCALAPPDATA', 'APPDATA', 'LANG', 'LC_ALL', 'TERM', 'NUMBER_OF_PROCESSORS', 'CARGO_HOME', 'RUSTUP_HOME',
  ]
  const result: NodeJS.ProcessEnv = {}
  for (const key of allowed) if (process.env[key] !== undefined) result[key] = process.env[key]
  for (const [key, value] of Object.entries(overrides ?? {})) result[key] = value
  return result
}

/** Durable ledger + crash-released resource claims. Process ownership stays in DurableRunController. */
export class DurableRunStore {
  private readonly createTx: (row: RunRow) => void
  private readonly claimTx: (id: string, resources: string[], now: string) => boolean
  private readonly finishTx: (
    id: string,
    state: Exclude<DurableRunState, 'queued' | 'running'>,
    completedAt: string,
    exitCode: number | null,
    signal: string | null,
    error: string | null,
    stdoutBytes: number,
    stderrBytes: number,
    logsTruncated: number,
    resultJson: string | null,
  ) => boolean

  constructor(readonly db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS durable_runs (
        id TEXT PRIMARY KEY,
        projectId TEXT NOT NULL,
        sessionId TEXT NOT NULL,
        actorSessionId TEXT NOT NULL,
        actorLabel TEXT NOT NULL,
        targetSessionId TEXT NOT NULL,
        executionTargetJson TEXT NOT NULL DEFAULT '{"kind":"local"}',
        kind TEXT NOT NULL CHECK (kind IN ('build','test','lint','benchmark','deploy','custom')),
        state TEXT NOT NULL CHECK (state IN ('queued','running','succeeded','failed','cancelled','outcome_unknown')),
        executable TEXT NOT NULL,
        argsJson TEXT NOT NULL,
        cwd TEXT NOT NULL,
        commandSummary TEXT NOT NULL,
        commandSha256 TEXT NOT NULL,
        resourcesJson TEXT NOT NULL,
        provenanceJson TEXT NOT NULL,
        environmentJson TEXT,
        createdAt TEXT NOT NULL,
        startedAt TEXT,
        heartbeatAt TEXT,
        completedAt TEXT,
        exitCode INTEGER,
        signal TEXT,
        error TEXT,
        timeoutMs INTEGER NOT NULL,
        cancelRequested INTEGER NOT NULL DEFAULT 0,
        stdoutBytes INTEGER NOT NULL DEFAULT 0,
        stderrBytes INTEGER NOT NULL DEFAULT 0,
        logsTruncated INTEGER NOT NULL DEFAULT 0,
        resultJson TEXT
      );
      CREATE INDEX IF NOT EXISTS durable_runs_project_created_idx ON durable_runs(projectId, createdAt DESC, id DESC);
      CREATE INDEX IF NOT EXISTS durable_runs_state_created_idx ON durable_runs(state, createdAt ASC, id ASC);
      CREATE TABLE IF NOT EXISTS durable_run_leases (
        resourceKey TEXT PRIMARY KEY,
        runId TEXT NOT NULL,
        acquiredAt TEXT NOT NULL,
        heartbeatAt TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS durable_run_leases_run_idx ON durable_run_leases(runId);
    `)
    const columns = new Set(
      (db.prepare('PRAGMA table_info(durable_runs)').all() as Array<{ name: string }>).map((column) => column.name),
    )
    if (!columns.has('executionTargetJson')) {
      db.exec(`ALTER TABLE durable_runs ADD COLUMN executionTargetJson TEXT NOT NULL DEFAULT '{"kind":"local"}'`)
    }
    if (!columns.has('resultJson')) db.exec('ALTER TABLE durable_runs ADD COLUMN resultJson TEXT')
    this.createTx = db.transaction((row) => {
      db.prepare(`INSERT INTO durable_runs (
        id, projectId, sessionId, actorSessionId, actorLabel, targetSessionId, executionTargetJson, kind, state,
        executable, argsJson, cwd, commandSummary, commandSha256, resourcesJson, provenanceJson,
        environmentJson, createdAt, timeoutMs
      ) VALUES (
        @id, @projectId, @sessionId, @actorSessionId, @actorLabel, @targetSessionId, @executionTargetJson, @kind, 'queued',
        @executable, @argsJson, @cwd, @commandSummary, @commandSha256, @resourcesJson, @provenanceJson,
        @environmentJson, @createdAt, @timeoutMs
      )`).run(row)
    })
    this.claimTx = db.transaction((id, resources, now) => {
      const row = db.prepare("SELECT state FROM durable_runs WHERE id = ?").get(id) as { state: string } | undefined
      if (row?.state !== 'queued') return false
      for (const resource of resources) {
        const owner = db.prepare('SELECT runId FROM durable_run_leases WHERE resourceKey = ?').get(resource) as
          | { runId: string }
          | undefined
        if (owner && owner.runId !== id) return false
      }
      const insert = db.prepare(
        'INSERT OR IGNORE INTO durable_run_leases (resourceKey, runId, acquiredAt, heartbeatAt) VALUES (?, ?, ?, ?)'
      )
      for (const resource of resources) {
        if (insert.run(resource, id, now, now).changes !== 1) {
          db.prepare('DELETE FROM durable_run_leases WHERE runId = ?').run(id)
          return false
        }
      }
      const updated = db.prepare(
        "UPDATE durable_runs SET state = 'running', startedAt = ?, heartbeatAt = ? WHERE id = ? AND state = 'queued'"
      ).run(now, now, id)
      if (updated.changes !== 1) {
        db.prepare('DELETE FROM durable_run_leases WHERE runId = ?').run(id)
        return false
      }
      return true
    })
    this.finishTx = db.transaction((
      id,
      state,
      completedAt,
      exitCode,
      signal,
      error,
      stdoutBytes,
      stderrBytes,
      logsTruncated,
      resultJson,
    ) => {
      const updated = db.prepare(`
        UPDATE durable_runs
        SET state = ?, completedAt = ?, heartbeatAt = ?, exitCode = ?, signal = ?, error = ?,
            stdoutBytes = ?, stderrBytes = ?, logsTruncated = ?, resultJson = ?
        WHERE id = ? AND state = 'running'
      `).run(
        state,
        completedAt,
        completedAt,
        exitCode,
        signal,
        error,
        stdoutBytes,
        stderrBytes,
        logsTruncated,
        resultJson,
        id,
      )
      if (updated.changes === 1) db.prepare('DELETE FROM durable_run_leases WHERE runId = ?').run(id)
      return updated.changes === 1
    })
  }

  create(input: DurableRunStartInput, provenance: DurableRunProvenance): DurableRun {
    const id = crypto.randomUUID()
    const createdAt = new Date().toISOString()
    const resources = [...new Set(input.resources.map((value) => boundedText(value, 500)).filter(Boolean))].sort()
    const row = {
      id,
      projectId: input.projectId,
      sessionId: input.sessionId,
      actorSessionId: input.actorSessionId,
      actorLabel: boundedText(input.actorLabel, 200),
      targetSessionId: input.targetSessionId,
      executionTargetJson: JSON.stringify(input.executionTarget ?? { kind: 'local' }),
      kind: input.kind,
      state: 'queued' as const,
      executable: input.executable,
      argsJson: JSON.stringify(input.args),
      cwd: path.resolve(input.cwd),
      commandSummary: input.executionTarget?.kind === 'remote'
        ? input.executionTarget.command.slice(0, 1_000)
        : summarizeCommand(input.executable, input.args),
      commandSha256: provenance.commandSha256,
      resourcesJson: JSON.stringify(resources),
      provenanceJson: JSON.stringify(provenance),
      environmentJson: input.environment ? JSON.stringify(input.environment) : null,
      createdAt,
      startedAt: null,
      heartbeatAt: null,
      completedAt: null,
      exitCode: null,
      signal: null,
      error: null,
      timeoutMs: input.timeoutMs,
      cancelRequested: 0,
      stdoutBytes: 0,
      stderrBytes: 0,
      logsTruncated: 0,
      resultJson: null,
    } satisfies RunRow
    this.createTx(row)
    return this.get(id)!
  }

  tryClaim(id: string): boolean {
    const run = this.get(id)
    return run ? this.claimTx(id, run.resources, new Date().toISOString()) : false
  }

  heartbeat(id: string): void {
    const now = new Date().toISOString()
    this.db.prepare("UPDATE durable_runs SET heartbeatAt = ? WHERE id = ? AND state = 'running'").run(now, id)
    this.db.prepare('UPDATE durable_run_leases SET heartbeatAt = ? WHERE runId = ?').run(now, id)
  }

  finish(
    id: string,
    input: {
      state: Exclude<DurableRunState, 'queued' | 'running'>
      exitCode?: number | null
      signal?: string
      error?: string
      stdoutBytes?: number
      stderrBytes?: number
      logsTruncated?: boolean
      result?: unknown
    },
  ): DurableRun | undefined {
    const changed = this.finishTx(
      id,
      input.state,
      new Date().toISOString(),
      input.exitCode ?? null,
      input.signal?.slice(0, 80) ?? null,
      input.error?.slice(0, 2_000) ?? null,
      Math.max(0, Math.trunc(input.stdoutBytes ?? 0)),
      Math.max(0, Math.trunc(input.stderrBytes ?? 0)),
      input.logsTruncated === true ? 1 : 0,
      input.result === undefined ? null : JSON.stringify(input.result),
    )
    return changed ? this.get(id) : undefined
  }

  requestCancel(id: string): DurableRun | undefined {
    const run = this.get(id)
    if (!run || !['queued', 'running'].includes(run.state)) return run
    if (run.state === 'queued') {
      this.db.prepare(`
        UPDATE durable_runs SET state = 'cancelled', cancelRequested = 1, completedAt = ?, error = 'cancelled before start'
        WHERE id = ? AND state = 'queued'
      `).run(new Date().toISOString(), id)
    } else {
      this.db.prepare("UPDATE durable_runs SET cancelRequested = 1 WHERE id = ? AND state = 'running'").run(id)
    }
    return this.get(id)
  }

  get(id: string): DurableRun | undefined {
    return fromRow(this.db.prepare('SELECT * FROM durable_runs WHERE id = ?').get(id) as RunRow | undefined)
  }

  queued(): DurableRun[] {
    return (this.db.prepare("SELECT * FROM durable_runs WHERE state = 'queued' ORDER BY createdAt ASC, id ASC").all() as RunRow[])
      .map((row) => fromRow(row)!)
  }

  list(input: {
    projectId: string
    sessionIds?: string[]
    states?: DurableRunState[]
    kinds?: DurableRunKind[]
    limit?: number
  }): DurableRun[] {
    const where = ['projectId = ?']
    const params: unknown[] = [input.projectId]
    const addIn = (column: string, values: string[] | undefined): void => {
      if (!values?.length) return
      where.push(`${column} IN (${values.map(() => '?').join(',')})`)
      params.push(...values)
    }
    addIn('targetSessionId', input.sessionIds)
    addIn('state', input.states)
    addIn('kind', input.kinds)
    params.push(Math.max(1, Math.min(Math.trunc(input.limit ?? 50), 200)))
    return (this.db.prepare(`SELECT * FROM durable_runs WHERE ${where.join(' AND ')} ORDER BY createdAt DESC, id DESC LIMIT ?`).all(...params) as RunRow[])
      .map((row) => fromRow(row)!)
  }

  reconcileInterrupted(input?: { staleBeforeMs?: number; excludeRunIds?: ReadonlySet<string> }): DurableRun[] {
    const staleBeforeMs = Math.max(0, Math.trunc(input?.staleBeforeMs ?? Date.now()))
    const running = (this.db.prepare("SELECT * FROM durable_runs WHERE state = 'running'").all() as RunRow[])
      .map((row) => fromRow(row)!)
      .filter((run) => !input?.excludeRunIds?.has(run.id))
      .filter((run) => {
        const heartbeat = Date.parse(run.heartbeatAt ?? run.startedAt ?? run.createdAt)
        return !Number.isFinite(heartbeat) || heartbeat <= staleBeforeMs
      })
    if (!running.length) return []
    const now = new Date().toISOString()
    const tx = this.db.transaction((): string[] => {
      const changed: string[] = []
      for (const run of running) {
        const updated = this.db.prepare(`
          UPDATE durable_runs
          SET state = 'outcome_unknown', completedAt = ?, heartbeatAt = ?,
              error = 'Hub ownership changed before the process outcome was observed.'
          WHERE id = ? AND state = 'running'
        `).run(now, now, run.id)
        if (updated.changes === 1) {
          this.db.prepare('DELETE FROM durable_run_leases WHERE runId = ?').run(run.id)
          changed.push(run.id)
        }
      }
      return changed
    })
    const changed = new Set(tx())
    return running.filter((run) => changed.has(run.id)).map((run) => ({
      ...run,
      state: 'outcome_unknown',
      completedAt: now,
      error: 'Hub ownership changed before the process outcome was observed.',
    }))
  }
}

function terminateTree(child: ChildProcess): void {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') {
    const killed = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
      timeout: 5_000,
    })
    if (killed.status === 0) return
  }
  try {
    child.kill('SIGTERM')
  } catch {
    // Already exited.
  }
}

/** Process owner and queue pump. Resource conflicts queue rather than making agents poll or delete locks. */
export class DurableRunController {
  private readonly children = new Map<string, ChildProcess>()
  private readonly remoteRuns = new Set<string>()
  private active = false
  private pumping = false
  private monitor: NodeJS.Timeout | undefined
  private remoteExecutor:
    | ((run: DurableRun, target: Extract<DurableRunExecutionTarget, { kind: 'remote' }>) => Promise<RemoteDeviceActionResult>)
    | undefined

  constructor(
    readonly store: DurableRunStore,
    private readonly journal: DurableRunJournal,
    private readonly logsDir: string,
  ) {
    fs.mkdirSync(logsDir, { recursive: true })
  }

  setRemoteExecutor(
    executor: (run: DurableRun, target: Extract<DurableRunExecutionTarget, { kind: 'remote' }>) => Promise<RemoteDeviceActionResult>,
  ): void {
    this.remoteExecutor = executor
  }

  activate(): DurableRun[] {
    if (this.active) return []
    this.active = true
    const interrupted = this.reconcileStaleOwners()
    this.monitor = setInterval(() => {
      this.reconcileStaleOwners()
      void this.pump()
    }, 5_000)
    this.monitor.unref?.()
    void this.pump()
    return interrupted
  }

  shutdown(): void {
    this.active = false
    if (this.monitor) clearInterval(this.monitor)
    this.monitor = undefined
    for (const child of this.children.values()) terminateTree(child)
    this.children.clear()
    // A remote request may have completed after this process lost its response. Its successor retains the
    // lease until the last heartbeat is stale, then records outcome_unknown. Never invent a cancellation.
    this.remoteRuns.clear()
  }

  private reconcileStaleOwners(): DurableRun[] {
    const excludeRunIds = new Set([...this.children.keys(), ...this.remoteRuns])
    const interrupted = this.store.reconcileInterrupted({
      staleBeforeMs: Date.now() - 30_000,
      excludeRunIds,
    })
    for (const run of interrupted) {
      this.journal.append(run.sessionId, 'run/outcome-unknown', this.lifecyclePayload(run))
    }
    return interrupted
  }

  async start(input: DurableRunStartInput): Promise<DurableRun> {
    if (!this.active) throw new Error('durable run execution is not active on this hub instance')
    const provenance = await captureRunProvenance(input)
    const run = this.store.create(input, provenance)
    this.journal.append(run.sessionId, 'run/queued', this.lifecyclePayload(run))
    await this.pump()
    return this.store.get(run.id) ?? run
  }

  inspect(input: {
    projectId: string
    sessionIds?: string[]
    states?: DurableRunState[]
    kinds?: DurableRunKind[]
    limit?: number
    runId?: string
    stdoutAfter?: number
    stderrAfter?: number
  }): { runs: DurableRun[]; logs?: DurableRunLogPage } {
    if (input.runId) {
      const run = this.store.get(input.runId)
      if (!run || run.projectId !== input.projectId || (input.sessionIds?.length && !input.sessionIds.includes(run.targetSessionId))) {
        return { runs: [] }
      }
      return {
        runs: [run],
        logs: this.readLogs(run.id, input.stdoutAfter ?? 0, input.stderrAfter ?? 0),
      }
    }
    return { runs: this.store.list(input) }
  }

  cancel(projectId: string, runId: string): DurableRun | undefined {
    const before = this.store.get(runId)
    if (!before || before.projectId !== projectId) return undefined
    const updated = this.store.requestCancel(runId)
    const child = this.children.get(runId)
    if (child) terminateTree(child)
    if (before.state === 'queued' && updated?.state === 'cancelled') {
      this.journal.append(updated.sessionId, 'run/cancelled', this.lifecyclePayload(updated))
      void this.pump()
    }
    return updated
  }

  private async pump(): Promise<void> {
    if (!this.active || this.pumping) return
    this.pumping = true
    try {
      for (const queued of this.store.queued()) {
        if (!this.store.tryClaim(queued.id)) continue
        const claimed = this.store.get(queued.id)
        if (claimed) this.launch(claimed)
      }
    } finally {
      this.pumping = false
    }
  }

  private launch(run: DurableRun): void {
    try {
      if (run.executionTarget.kind === 'remote') {
        void this.launchRemote(run, run.executionTarget).catch((error: unknown) => this.failLaunch(run, error))
        return
      }
      this.launchLocal(run)
    } catch (error) {
      this.failLaunch(run, error)
    }
  }

  private failLaunch(run: DurableRun, error: unknown): void {
    this.children.delete(run.id)
    this.remoteRuns.delete(run.id)
    const final = this.store.finish(run.id, {
      state: 'failed',
      error: boundedText(error instanceof Error ? error.message : String(error), 2_000),
    })
    if (final) this.journal.append(final.sessionId, 'run/failed', this.lifecyclePayload(final))
    void this.pump()
  }

  private launchLocal(run: DurableRun): void {
    const row = this.store.db.prepare('SELECT environmentJson FROM durable_runs WHERE id = ?').get(run.id) as
      | { environmentJson: string | null }
      | undefined
    let overrides: Record<string, string> | undefined
    try {
      overrides = row?.environmentJson ? JSON.parse(row.environmentJson) as Record<string, string> : undefined
    } catch {
      overrides = undefined
    }
    const dir = path.join(this.logsDir, run.id)
    fs.mkdirSync(dir, { recursive: true })
    const stdoutPath = path.join(dir, 'stdout.log')
    const stderrPath = path.join(dir, 'stderr.log')
    const child = spawn(run.executable, run.args, {
      cwd: run.cwd,
      env: safeEnvironment(overrides),
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.children.set(run.id, child)
    this.journal.append(run.sessionId, 'run/started', this.lifecyclePayload(this.store.get(run.id) ?? run))
    let stdoutBytes = 0
    let stderrBytes = 0
    let logsTruncated = false
    let errorText = ''
    let settled = false
    const append = (file: string, chunk: Buffer, stream: 'stdout' | 'stderr'): void => {
      const current = stream === 'stdout' ? stdoutBytes : stderrBytes
      const remaining = MAX_LOG_BYTES_PER_STREAM - current
      const written = Math.max(0, Math.min(chunk.length, remaining))
      if (written > 0) fs.appendFileSync(file, chunk.subarray(0, written))
      if (stream === 'stdout') stdoutBytes += written
      else stderrBytes += written
      if (written < chunk.length) logsTruncated = true
      this.store.heartbeat(run.id)
    }
    child.stdout.on('data', (chunk: Buffer) => append(stdoutPath, chunk, 'stdout'))
    child.stderr.on('data', (chunk: Buffer) => {
      append(stderrPath, chunk, 'stderr')
      errorText = (errorText + chunk.toString('utf8')).slice(-2_000)
    })
    const timeout = setTimeout(() => {
      errorText = `run exceeded its ${run.timeoutMs}ms timeout`
      terminateTree(child)
    }, run.timeoutMs)
    timeout.unref?.()
    const heartbeat = setInterval(() => this.store.heartbeat(run.id), 5_000)
    heartbeat.unref?.()
    const settle = (exitCode: number | null, signal: NodeJS.Signals | null, spawnError?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      clearInterval(heartbeat)
      this.children.delete(run.id)
      const current = this.store.get(run.id)
      const cancelled = current?.cancelRequested === true
      const state: Exclude<DurableRunState, 'queued' | 'running'> = cancelled
        ? 'cancelled'
        : !spawnError && exitCode === 0
          ? 'succeeded'
          : 'failed'
      const final = this.store.finish(run.id, {
        state,
        exitCode,
        ...(signal ? { signal } : {}),
        ...((spawnError || errorText) ? { error: boundedText(spawnError?.message ?? errorText, 2_000) } : {}),
        stdoutBytes,
        stderrBytes,
        logsTruncated,
      })
      if (final) this.journal.append(final.sessionId, `run/${final.state.replace('_', '-')}`, this.lifecyclePayload(final))
      void this.pump()
    }
    child.once('error', (error) => settle(127, null, error))
    child.once('close', (code, signal) => settle(code, signal))
  }

  private async launchRemote(
    run: DurableRun,
    target: Extract<DurableRunExecutionTarget, { kind: 'remote' }>,
  ): Promise<void> {
    this.remoteRuns.add(run.id)
    this.journal.append(run.sessionId, 'run/started', this.lifecyclePayload(this.store.get(run.id) ?? run))
    const heartbeat = setInterval(() => this.store.heartbeat(run.id), 5_000)
    heartbeat.unref?.()
    let result: RemoteDeviceActionResult
    try {
      if (!this.remoteExecutor) throw new Error('remote durable run executor is unavailable')
      result = await this.remoteExecutor(run, target)
    } catch (error) {
      result = { ok: false, error: error instanceof Error ? error.message : String(error), failure: { stage: 'transport' } }
    } finally {
      clearInterval(heartbeat)
      this.remoteRuns.delete(run.id)
    }
    const dir = path.join(this.logsDir, run.id)
    fs.mkdirSync(dir, { recursive: true })
    const stdout = Buffer.from(result.stdout ?? '', 'utf8')
    const stderr = Buffer.from(result.stderr ?? '', 'utf8')
    const stdoutWritten = Math.min(stdout.length, MAX_LOG_BYTES_PER_STREAM)
    const stderrWritten = Math.min(stderr.length, MAX_LOG_BYTES_PER_STREAM)
    if (stdoutWritten) fs.writeFileSync(path.join(dir, 'stdout.log'), stdout.subarray(0, stdoutWritten))
    if (stderrWritten) fs.writeFileSync(path.join(dir, 'stderr.log'), stderr.subarray(0, stderrWritten))
    const current = this.store.get(run.id)
    const state: Exclude<DurableRunState, 'queued' | 'running'> = current?.cancelRequested
      ? 'cancelled'
      : result.ok
        ? 'succeeded'
        : 'failed'
    const final = this.store.finish(run.id, {
      state,
      exitCode: result.exitCode,
      ...(result.signal ? { signal: result.signal } : {}),
      ...(result.error ? { error: result.error } : {}),
      stdoutBytes: stdoutWritten,
      stderrBytes: stderrWritten,
      logsTruncated: result.truncated === true || stdoutWritten < stdout.length || stderrWritten < stderr.length,
      result: {
        failure: result.failure,
        telemetry: result.telemetry,
        timedOut: result.timedOut,
        remoteRunId: result.runId,
      },
    })
    if (final) this.journal.append(final.sessionId, `run/${final.state.replace('_', '-')}`, this.lifecyclePayload(final))
    void this.pump()
  }

  private readLogs(runId: string, stdoutAfter: number, stderrAfter: number): DurableRunLogPage {
    const read = (name: string, after: number): { text: string; next: number; complete: boolean } => {
      const file = path.join(this.logsDir, runId, name)
      try {
        const size = fs.statSync(file).size
        const cursor = Math.max(0, Math.min(Math.trunc(after), size))
        const bytes = Math.min(MAX_LOG_READ_BYTES, size - cursor)
        if (bytes <= 0) return { text: '', next: cursor, complete: cursor >= size }
        const fd = fs.openSync(file, 'r')
        try {
          const buffer = Buffer.allocUnsafe(bytes)
          const readBytes = fs.readSync(fd, buffer, 0, bytes, cursor)
          return {
            text: buffer.subarray(0, readBytes).toString('utf8'),
            next: cursor + readBytes,
            complete: cursor + readBytes >= size,
          }
        } finally {
          fs.closeSync(fd)
        }
      } catch {
        return { text: '', next: Math.max(0, Math.trunc(after)), complete: true }
      }
    }
    const stdout = read('stdout.log', stdoutAfter)
    const stderr = read('stderr.log', stderrAfter)
    return {
      stdout: stdout.text,
      stderr: stderr.text,
      nextStdoutCursor: stdout.next,
      nextStderrCursor: stderr.next,
      stdoutComplete: stdout.complete,
      stderrComplete: stderr.complete,
    }
  }

  private lifecyclePayload(run: DurableRun): Record<string, unknown> {
    return {
      runId: run.id,
      projectId: run.projectId,
      actorSessionId: run.actorSessionId,
      targetSessionId: run.targetSessionId,
      kind: run.kind,
      state: run.state,
      commandSummary: run.commandSummary,
      commandSha256: run.commandSha256,
      resources: run.resources,
      executionTarget: run.executionTarget,
      createdAt: run.createdAt,
      startedAt: run.startedAt ?? null,
      completedAt: run.completedAt ?? null,
      exitCode: run.exitCode ?? null,
      signal: run.signal ?? null,
      error: run.error ?? null,
      provenance: run.provenance,
      stdoutBytes: run.stdoutBytes,
      stderrBytes: run.stderrBytes,
      logsTruncated: run.logsTruncated,
      result: run.result ?? null,
    }
  }
}

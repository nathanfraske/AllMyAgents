import crypto from 'node:crypto'
import fs from 'node:fs'
import pathModule from 'node:path'
import type Database from 'better-sqlite3'
import { readProjectConfig } from './importScan.js'
import type { Project, ProjectReplica } from './types.js'

type ProjectLocation = NonNullable<Project['location']>

interface ProjectLifecycleJournal {
  atomic<T>(fn: () => T): T
  append(sessionId: string | null, kind: string, payload: unknown): unknown
}

interface ProjectRow {
  id: string
  name: string
  path: string
  wslDistro: string | null
  linuxPath: string | null
  createdAt: string
}

interface ProjectReplicaRow {
  id: string
  projectId: string
  kind: 'local' | 'remote'
  siteId: string | null
  siteLabel: string | null
  rootId: string | null
  environmentId: string
  environmentKind: 'host' | 'wsl'
  environmentLabel: string | null
  distro: string | null
  path: string
  isPrimary: number
  state: 'ready' | 'registered' | 'unavailable'
  headCommit: string | null
  headRef: string | null
  createdAt: string
  updatedAt: string
}

function replicaFromRow(row: ProjectReplicaRow | undefined): ProjectReplica | undefined {
  if (!row) return undefined
  return {
    id: row.id,
    projectId: row.projectId,
    kind: row.kind,
    ...(row.siteId ? { siteId: row.siteId } : {}),
    ...(row.siteLabel ? { siteLabel: row.siteLabel } : {}),
    ...(row.rootId ? { rootId: row.rootId } : {}),
    environment: {
      id: row.environmentId,
      kind: row.environmentKind,
      ...(row.environmentLabel ? { label: row.environmentLabel } : {}),
      ...(row.distro ? { distro: row.distro } : {}),
    },
    path: row.path,
    isPrimary: row.isPrimary === 1,
    state: row.state,
    ...(row.headCommit ? { headCommit: row.headCommit } : {}),
    ...(row.headRef ? { headRef: row.headRef } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function localReplicaId(projectId: string): string {
  return `replica_${crypto.createHash('sha256').update(`local:${projectId}`).digest('hex').slice(0, 24)}`
}

function remoteReplicaId(projectId: string, siteId: string, rootId: string): string {
  return `replica_${crypto.createHash('sha256').update(`remote:${projectId}:${siteId}:${rootId}`).digest('hex').slice(0, 24)}`
}

function fromRow(row: ProjectRow | undefined): Project | undefined {
  if (!row) return undefined
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    ...(row.wslDistro && row.linuxPath
      ? {
          location: {
            kind: 'wsl' as const,
            distro: row.wslDistro,
            linuxPath: row.linuxPath,
          },
        }
      : {}),
    createdAt: row.createdAt,
  }
}

function projectFilesystemKey(project: Pick<Project, 'path' | 'location'>): string {
  if (project.location?.kind === 'wsl') {
    return `wsl:${project.location.distro.toLowerCase()}:${pathModule.posix.normalize(project.location.linuxPath)}`
  }
  const resolved = pathModule.resolve(project.path)
  return `local:${process.platform === 'win32' ? resolved.toLowerCase() : resolved}`
}

export class ProjectStore {
  private readonly insertStmt: Database.Statement
  private readonly allStmt: Database.Statement
  private readonly getStmt: Database.Statement
  private readonly updateNameStmt: Database.Statement
  private readonly delStmt: Database.Statement
  private readonly trustGetStmt: Database.Statement
  private readonly trustUpsertStmt: Database.Statement
  private readonly trustDelStmt: Database.Statement
  private readonly replicaInsertStmt: Database.Statement
  private readonly replicaAllStmt: Database.Statement
  private readonly replicaGetStmt: Database.Statement
  private readonly replicaDeleteStmt: Database.Statement
  private readonly replicaDeleteProjectStmt: Database.Statement

  constructor(
    private readonly db: Database.Database,
    private readonly lifecycle?: ProjectLifecycleJournal,
  ) {
    db.exec(
      'CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, createdAt TEXT NOT NULL)'
    )
    const projectColumns = new Set(
      (db.prepare('PRAGMA table_info(projects)').all() as Array<{ name: string }>).map(
        (column) => column.name,
      ),
    )
    if (!projectColumns.has('wslDistro')) {
      db.exec('ALTER TABLE projects ADD COLUMN wslDistro TEXT')
    }
    if (!projectColumns.has('linuxPath')) {
      db.exec('ALTER TABLE projects ADD COLUMN linuxPath TEXT')
    }
    // Per-project consent to run the project's EXECUTABLE config (MCP servers + hooks). Keyed by the
    // config's content FINGERPRINT, not its path: a moved repo keeps approval (same content), a swapped
    // or edited repo loses it (different content). See fingerprintProjectConfig. A project with no row —
    // or a row whose fingerprint no longer matches what's on disk — is UNTRUSTED, and adapters/claude.ts
    // gates it (strictMcpConfig + disableAllHooks). Safe by default; the operator opts in per project.
    db.exec(
      'CREATE TABLE IF NOT EXISTS project_config_trust (projectId TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, approvedAt TEXT NOT NULL)'
    )
    db.exec(`
      CREATE TABLE IF NOT EXISTS project_replicas (
        id TEXT PRIMARY KEY,
        projectId TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('local', 'remote')),
        siteId TEXT,
        siteLabel TEXT,
        rootId TEXT,
        environmentId TEXT NOT NULL,
        environmentKind TEXT NOT NULL CHECK (environmentKind IN ('host', 'wsl')),
        environmentLabel TEXT,
        distro TEXT,
        path TEXT NOT NULL,
        isPrimary INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL CHECK (state IN ('ready', 'registered', 'unavailable')),
        headCommit TEXT,
        headRef TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS project_replicas_project_idx ON project_replicas(projectId, isPrimary DESC, createdAt ASC);
      CREATE UNIQUE INDEX IF NOT EXISTS project_replicas_remote_identity_idx
        ON project_replicas(projectId, siteId, rootId) WHERE kind = 'remote';
    `)
    this.insertStmt = db.prepare(
      'INSERT INTO projects (id, name, path, wslDistro, linuxPath, createdAt) VALUES (?, ?, ?, ?, ?, ?)',
    )
    this.allStmt = db.prepare(
      'SELECT id, name, path, wslDistro, linuxPath, createdAt FROM projects ORDER BY createdAt ASC',
    )
    this.getStmt = db.prepare(
      'SELECT id, name, path, wslDistro, linuxPath, createdAt FROM projects WHERE id = ?',
    )
    this.updateNameStmt = db.prepare('UPDATE projects SET name = ? WHERE id = ?')
    this.delStmt = db.prepare('DELETE FROM projects WHERE id = ?')
    this.trustGetStmt = db.prepare('SELECT fingerprint FROM project_config_trust WHERE projectId = ?')
    this.trustUpsertStmt = db.prepare(
      'INSERT INTO project_config_trust (projectId, fingerprint, approvedAt) VALUES (?, ?, ?) ON CONFLICT(projectId) DO UPDATE SET fingerprint = excluded.fingerprint, approvedAt = excluded.approvedAt'
    )
    this.trustDelStmt = db.prepare('DELETE FROM project_config_trust WHERE projectId = ?')
    this.replicaInsertStmt = db.prepare(`
      INSERT INTO project_replicas (
        id, projectId, kind, siteId, siteLabel, rootId, environmentId, environmentKind,
        environmentLabel, distro, path, isPrimary, state, headCommit, headRef, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `)
    this.replicaAllStmt = db.prepare('SELECT * FROM project_replicas WHERE projectId = ? ORDER BY isPrimary DESC, createdAt ASC')
    this.replicaGetStmt = db.prepare('SELECT * FROM project_replicas WHERE id = ?')
    this.replicaDeleteStmt = db.prepare("DELETE FROM project_replicas WHERE id = ? AND isPrimary = 0")
    this.replicaDeleteProjectStmt = db.prepare('DELETE FROM project_replicas WHERE projectId = ?')
    // Existing projects predate explicit replicas. Materialize their one known local location without
    // manufacturing lifecycle events: this is a deterministic schema upgrade, not a new operator action.
    for (const project of this.list()) this.insertLocalReplica(project)
  }

  private insertReplica(replica: ProjectReplica): void {
    this.replicaInsertStmt.run(
      replica.id,
      replica.projectId,
      replica.kind,
      replica.siteId ?? null,
      replica.siteLabel ?? null,
      replica.rootId ?? null,
      replica.environment.id,
      replica.environment.kind,
      replica.environment.label ?? null,
      replica.environment.distro ?? null,
      replica.path,
      replica.isPrimary ? 1 : 0,
      replica.state,
      replica.headCommit ?? null,
      replica.headRef ?? null,
      replica.createdAt,
      replica.updatedAt,
    )
  }

  private insertLocalReplica(project: Project): ProjectReplica {
    const now = project.createdAt
    const replica: ProjectReplica = {
      id: localReplicaId(project.id),
      projectId: project.id,
      kind: 'local',
      environment: project.location?.kind === 'wsl'
        ? { id: `wsl:${project.location.distro}`, kind: 'wsl', label: `${project.location.distro} (WSL)`, distro: project.location.distro }
        : { id: 'host', kind: 'host' },
      path: project.location?.kind === 'wsl' ? project.location.linuxPath : project.path,
      isPrimary: true,
      state: 'ready',
      createdAt: now,
      updatedAt: now,
    }
    this.insertReplica(replica)
    return this.getReplica(replica.id)!
  }

  list(): Project[] {
    return (this.allStmt.all() as ProjectRow[]).map((row) => fromRow(row)!)
  }

  get(id: string): Project | undefined {
    return fromRow(this.getStmt.get(id) as ProjectRow | undefined)
  }

  create(name: string, rawPath: string, location?: ProjectLocation): Project {
    const path = rawPath.trim()
    if (!path) throw new Error('project path is required')
    if (!fs.existsSync(path)) throw new Error(`path does not exist: ${path}`)
    if (!fs.statSync(path).isDirectory()) throw new Error(`path is not a directory: ${path}`)
    const project: Project = {
      id: crypto.randomUUID(),
      name: name.trim() || path.split(/[\\/]/).filter(Boolean).pop() || path,
      path,
      ...(location ? { location } : {}),
      createdAt: new Date().toISOString(),
    }
    const filesystemKey = projectFilesystemKey(project)
    if (this.list().some((existing) => projectFilesystemKey(existing) === filesystemKey)) {
      throw new Error(`This project directory is already added: ${project.path}`)
    }
    const insert = (): void => {
      this.insertStmt.run(
        project.id,
        project.name,
        project.path,
        project.location?.distro ?? null,
        project.location?.linuxPath ?? null,
        project.createdAt,
      )
      this.insertLocalReplica(project)
      this.lifecycle?.append(null, 'project/created', { project })
    }
    // A project must not become visible in the durable registry without the lifecycle row that makes
    // every already-open operator window learn about it. This matters especially for Overseer-created
    // projects: there is no initiating browser request whose response could patch one local store.
    if (this.lifecycle) this.lifecycle.atomic(insert)
    else insert()
    return project
  }

  updateName(id: string, rawName: string): Project {
    const existing = this.get(id)
    if (!existing) throw new Error(`unknown project: ${id}`)
    const name = rawName.trim()
    if (!name) throw new Error('project name is required')
    this.updateNameStmt.run(name, id)
    return this.get(id)!
  }

  remove(id: string): void {
    const remove = (): void => {
      this.replicaDeleteProjectStmt.run(id)
      this.delStmt.run(id)
      this.trustDelStmt.run(id) // approval is meaningless once the project is gone
    }
    if (this.lifecycle) this.lifecycle.atomic(remove)
    else remove()
  }

  listReplicas(projectId: string): ProjectReplica[] {
    return (this.replicaAllStmt.all(projectId) as ProjectReplicaRow[]).map((row) => replicaFromRow(row)!)
  }

  getReplica(id: string): ProjectReplica | undefined {
    return replicaFromRow(this.replicaGetStmt.get(id) as ProjectReplicaRow | undefined)
  }

  primaryReplica(projectId: string): ProjectReplica | undefined {
    return this.listReplicas(projectId).find((replica) => replica.isPrimary)
  }

  findRemoteReplica(projectId: string, siteId: string, rootId: string): ProjectReplica | undefined {
    return this.listReplicas(projectId).find(
      (replica) => replica.kind === 'remote' && replica.siteId === siteId && replica.rootId === rootId,
    )
  }

  addRemoteReplica(input: {
    projectId: string
    siteId: string
    siteLabel: string
    rootId: string
    path: string
    environment?: { kind: 'wsl'; distro: string }
  }): ProjectReplica {
    if (!this.get(input.projectId)) throw new Error(`unknown project: ${input.projectId}`)
    const existing = this.findRemoteReplica(input.projectId, input.siteId, input.rootId)
    if (existing) return existing
    const now = new Date().toISOString()
    const replica: ProjectReplica = {
      id: remoteReplicaId(input.projectId, input.siteId, input.rootId),
      projectId: input.projectId,
      kind: 'remote',
      siteId: input.siteId,
      siteLabel: input.siteLabel,
      rootId: input.rootId,
      environment: input.environment
        ? { id: `wsl:${input.environment.distro}`, kind: 'wsl', label: `${input.environment.distro} (WSL)`, distro: input.environment.distro }
        : { id: 'host', kind: 'host' },
      path: input.path,
      isPrimary: false,
      state: 'registered',
      createdAt: now,
      updatedAt: now,
    }
    const insert = (): void => {
      this.insertReplica(replica)
      this.lifecycle?.append(null, 'project/replica-added', { projectId: input.projectId, replica })
    }
    if (this.lifecycle) this.lifecycle.atomic(insert)
    else insert()
    return this.getReplica(replica.id)!
  }

  removeReplica(projectId: string, replicaId: string): boolean {
    const replica = this.getReplica(replicaId)
    if (!replica || replica.projectId !== projectId) return false
    if (replica.isPrimary) throw new Error('The primary local project location cannot be removed.')
    let removed = false
    const remove = (): void => {
      removed = this.replicaDeleteStmt.run(replicaId).changes > 0
      if (removed) this.lifecycle?.append(null, 'project/replica-removed', { projectId, replicaId })
    }
    if (this.lifecycle) this.lifecycle.atomic(remove)
    else remove()
    return removed
  }

  /**
   * Approve a project's CURRENT executable config so its MCP servers + hooks may run. Recomputes from
   * disk at approval time and stores the fingerprint of exactly what is there now.
   *
   * REFUSES an unverifiable config. If the project has any surface this version cannot fully model
   * (`config.unmodeled`), approval is DENIED (nothing stored) and the reasons are returned — approving
   * would falsely assure the operator that "what you saw is what will run" when part of it was never
   * modeled. `unverifiable` non-empty ⇒ not approved. `fingerprint === null` ⇒ nothing executable to
   * approve. The authenticated operator action is the consent; there is no second gate here.
   */
  approveConfig(projectId: string): { approved: boolean; fingerprint: string | null; unverifiable: string[] } {
    const project = this.get(projectId)
    if (!project) throw new Error(`unknown project: ${projectId}`)
    const config = readProjectConfig(project.path)
    if (config.unmodeled.length > 0) {
      this.trustDelStmt.run(projectId) // never leave a stale approval over a now-unverifiable config
      return { approved: false, fingerprint: null, unverifiable: config.unmodeled }
    }
    if (config.fingerprint === null) {
      this.trustDelStmt.run(projectId) // nothing executable → drop any stale approval, stay clean
      return { approved: false, fingerprint: null, unverifiable: [] }
    }
    this.trustUpsertStmt.run(projectId, config.fingerprint, new Date().toISOString())
    return { approved: true, fingerprint: config.fingerprint, unverifiable: [] }
  }

  /** Revoke a project's config approval — the next spawn re-gates it. */
  revokeConfig(projectId: string): void {
    this.trustDelStmt.run(projectId)
  }

  /** The fingerprint the operator approved for this project, or undefined if never approved. */
  approvedFingerprint(projectId: string): string | undefined {
    const row = this.trustGetStmt.get(projectId) as { fingerprint: string } | undefined
    return row?.fingerprint
  }

  /**
   * Whether this project's executable config is trusted for a turn about to run in `cwd`.
   *
   * FAILS CLOSED, and against the ACTUAL execution directory (audit findings #1 + #2):
   *   - no `cwd` → false. Trust is a statement about what will run; with no execution dir we cannot make
   *     it, so we deny. (The sessions.ts seam must pass the session's real cwd — a worktree or an imported
   *     chat's original path can differ from project.path, so computing against project.path would approve
   *     one directory while another runs.)
   *   - the config at `cwd` has anything `unmodeled` → false. We will not relax the gate for a config we
   *     could not fully understand — an unparsed or unmodeled surface must stay gated, never fall through.
   *   - no executable config at `cwd` (fingerprint null) → true. Nothing runs, nothing to gate.
   *   - otherwise trusted iff the CONTENT fingerprint at `cwd` equals the operator-approved one (so a MOVE
   *     of the same content stays trusted and a SWAP/EDIT re-gates).
   */
  isConfigTrusted(projectId: string, cwd?: string): boolean {
    if (!cwd) return false
    if (!this.get(projectId)) return false
    let config: ReturnType<typeof readProjectConfig>
    try {
      config = readProjectConfig(cwd)
    } catch {
      return false // an unreadable execution dir cannot be verified → gate
    }
    if (config.unmodeled.length > 0) return false
    if (config.fingerprint === null) return true
    return config.fingerprint === this.approvedFingerprint(projectId)
  }
}

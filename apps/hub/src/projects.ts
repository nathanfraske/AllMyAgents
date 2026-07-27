import crypto from 'node:crypto'
import fs from 'node:fs'
import type Database from 'better-sqlite3'
import { readProjectConfig } from './importScan.js'
import type { Project } from './types.js'

export class ProjectStore {
  private readonly insertStmt: Database.Statement
  private readonly allStmt: Database.Statement
  private readonly getStmt: Database.Statement
  private readonly delStmt: Database.Statement
  private readonly trustGetStmt: Database.Statement
  private readonly trustUpsertStmt: Database.Statement
  private readonly trustDelStmt: Database.Statement

  constructor(db: Database.Database) {
    db.exec(
      'CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, createdAt TEXT NOT NULL)'
    )
    // Per-project consent to run the project's EXECUTABLE config (MCP servers + hooks). Keyed by the
    // config's content FINGERPRINT, not its path: a moved repo keeps approval (same content), a swapped
    // or edited repo loses it (different content). See fingerprintProjectConfig. A project with no row —
    // or a row whose fingerprint no longer matches what's on disk — is UNTRUSTED, and adapters/claude.ts
    // gates it (strictMcpConfig + disableAllHooks). Safe by default; the operator opts in per project.
    db.exec(
      'CREATE TABLE IF NOT EXISTS project_config_trust (projectId TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, approvedAt TEXT NOT NULL)'
    )
    this.insertStmt = db.prepare('INSERT INTO projects (id, name, path, createdAt) VALUES (?, ?, ?, ?)')
    this.allStmt = db.prepare('SELECT id, name, path, createdAt FROM projects ORDER BY createdAt ASC')
    this.getStmt = db.prepare('SELECT id, name, path, createdAt FROM projects WHERE id = ?')
    this.delStmt = db.prepare('DELETE FROM projects WHERE id = ?')
    this.trustGetStmt = db.prepare('SELECT fingerprint FROM project_config_trust WHERE projectId = ?')
    this.trustUpsertStmt = db.prepare(
      'INSERT INTO project_config_trust (projectId, fingerprint, approvedAt) VALUES (?, ?, ?) ON CONFLICT(projectId) DO UPDATE SET fingerprint = excluded.fingerprint, approvedAt = excluded.approvedAt'
    )
    this.trustDelStmt = db.prepare('DELETE FROM project_config_trust WHERE projectId = ?')
  }

  list(): Project[] {
    return this.allStmt.all() as Project[]
  }

  get(id: string): Project | undefined {
    return this.getStmt.get(id) as Project | undefined
  }

  create(name: string, rawPath: string): Project {
    const path = rawPath.trim()
    if (!path) throw new Error('project path is required')
    if (!fs.existsSync(path)) throw new Error(`path does not exist: ${path}`)
    if (!fs.statSync(path).isDirectory()) throw new Error(`path is not a directory: ${path}`)
    const project: Project = {
      id: crypto.randomUUID(),
      name: name.trim() || path.split(/[\\/]/).filter(Boolean).pop() || path,
      path,
      createdAt: new Date().toISOString(),
    }
    this.insertStmt.run(project.id, project.name, project.path, project.createdAt)
    return project
  }

  remove(id: string): void {
    this.delStmt.run(id)
    this.trustDelStmt.run(id) // approval is meaningless once the project is gone
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

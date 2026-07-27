import crypto from 'node:crypto'
import fs from 'node:fs'
import type Database from 'better-sqlite3'
import { fingerprintProjectConfig, readProjectConfig } from './importScan.js'
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
   * Approve a project's CURRENT executable config so its MCP servers + hooks may run. Recomputes the
   * fingerprint from disk at approval time and stores THAT — so the approval is of exactly what is there
   * now (and what the operator was shown). Returns the stored fingerprint, or null when there is nothing
   * executable to approve (no MCP, no hooks). The caller (server.ts) is the operator's authenticated
   * action, so approval itself is the consent — no second gate here.
   */
  approveConfig(projectId: string): string | null {
    const project = this.get(projectId)
    if (!project) throw new Error(`unknown project: ${projectId}`)
    const fingerprint = fingerprintProjectConfig(readProjectConfig(project.path))
    if (fingerprint === null) {
      this.trustDelStmt.run(projectId) // nothing executable → drop any stale approval, stay clean
      return null
    }
    this.trustUpsertStmt.run(projectId, fingerprint, new Date().toISOString())
    return fingerprint
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
   * Whether this project's config is trusted RIGHT NOW: recompute the on-disk fingerprint and require it
   * to equal the approved one. A project with no executable config (fingerprint null) is trivially
   * trusted — there is nothing to run, so nothing to gate. Anything else (never approved, or the config
   * changed / a different repo now sits at the path) is untrusted. This is what specOf reads to set
   * ClaudeTurnOptions.trustProjectConfig (the sessions.ts seam).
   */
  isConfigTrusted(projectId: string): boolean {
    const project = this.get(projectId)
    if (!project) return false
    const current = fingerprintProjectConfig(readProjectConfig(project.path))
    if (current === null) return true // no MCP / no hooks → nothing executable to gate
    return current === this.approvedFingerprint(projectId)
  }
}

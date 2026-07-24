import crypto from 'node:crypto'
import fs from 'node:fs'
import type Database from 'better-sqlite3'
import type { Project } from './types.js'

export class ProjectStore {
  private readonly insertStmt: Database.Statement
  private readonly allStmt: Database.Statement
  private readonly getStmt: Database.Statement
  private readonly delStmt: Database.Statement

  constructor(db: Database.Database) {
    db.exec(
      'CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, createdAt TEXT NOT NULL)'
    )
    this.insertStmt = db.prepare('INSERT INTO projects (id, name, path, createdAt) VALUES (?, ?, ?, ?)')
    this.allStmt = db.prepare('SELECT id, name, path, createdAt FROM projects ORDER BY createdAt ASC')
    this.getStmt = db.prepare('SELECT id, name, path, createdAt FROM projects WHERE id = ?')
    this.delStmt = db.prepare('DELETE FROM projects WHERE id = ?')
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
  }
}

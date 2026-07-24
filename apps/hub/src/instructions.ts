import fs from 'node:fs'
import path from 'node:path'
import type Database from 'better-sqlite3'

/**
 * Operator profile + scoped instruction layer (DESIGN D9, first slice).
 *
 * The owner writes instructions once, scoped by breadth, and the hub materializes the applicable
 * union into each session's NATIVE instruction file at spawn — CLAUDE.md for Claude, AGENTS.md for
 * Codex — so every agent reads them as first-class context, no matter which account/project.
 *
 * Scope keys, general → specific:
 *   global | vendor:claude | vendor:codex | project:<projectId> | account:<profileId>
 */
export interface Instruction {
  scope: string
  content: string
  updatedAt: string
}

export class InstructionStore {
  private readonly allStmt: Database.Statement
  private readonly upsertStmt: Database.Statement
  private readonly delStmt: Database.Statement

  constructor(db: Database.Database) {
    db.exec('CREATE TABLE IF NOT EXISTS instructions (scope TEXT PRIMARY KEY, content TEXT NOT NULL, updatedAt TEXT NOT NULL)')
    this.allStmt = db.prepare('SELECT scope, content, updatedAt FROM instructions ORDER BY scope ASC')
    this.upsertStmt = db.prepare(
      'INSERT INTO instructions (scope, content, updatedAt) VALUES (?, ?, ?) ON CONFLICT(scope) DO UPDATE SET content = excluded.content, updatedAt = excluded.updatedAt'
    )
    this.delStmt = db.prepare('DELETE FROM instructions WHERE scope = ?')
  }

  list(): Instruction[] {
    return this.allStmt.all() as Instruction[]
  }

  /** Set a scope's instructions, or clear it when the content is blank. */
  set(scope: string, content: string): void {
    if (content.trim()) this.upsertStmt.run(scope, content, new Date().toISOString())
    else this.delStmt.run(scope)
  }

  /** The applicable union for a session, general → specific. */
  materialize(opts: { provider: 'claude' | 'codex'; projectId?: string; profileId: string }): string {
    const order = ['global', `vendor:${opts.provider}`]
    if (opts.projectId) order.push(`project:${opts.projectId}`)
    order.push(`account:${opts.profileId}`)
    const byScope = new Map(this.list().map((r) => [r.scope, r.content]))
    const parts: string[] = []
    for (const scope of order) {
      const c = byScope.get(scope)?.trim()
      if (c) parts.push(c)
    }
    return parts.join('\n\n')
  }
}

const BEGIN = '<!-- CEC-AiMesh operator instructions (managed by the hub — edit them in Settings, not here) -->'
const END = '<!-- /CEC-AiMesh operator instructions -->'

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function fileFor(provider: 'claude' | 'codex'): string {
  return provider === 'claude' ? 'CLAUDE.md' : 'AGENTS.md'
}

/**
 * Prepend a hub-managed instruction block to the session's native instruction file, preserving any
 * existing repo/user content. Idempotent — a prior managed block is replaced; blank content strips
 * it (and removes a file the hub solely created). Best-effort: never throws into the spawn path.
 */
export function writeManagedInstructions(cwd: string, provider: 'claude' | 'codex', content: string): void {
  try {
    const file = path.join(cwd, fileFor(provider))
    let existing = ''
    try {
      existing = fs.readFileSync(file, 'utf8')
    } catch {
      /* no file yet */
    }
    const stripped = existing
      .replace(new RegExp(`${escapeRegExp(BEGIN)}[\\s\\S]*?${escapeRegExp(END)}\\n*`), '')
      .replace(/^\s+/, '')
    const body = content.trim()
    if (!body) {
      if (stripped) fs.writeFileSync(file, stripped)
      else if (existing) {
        try {
          fs.rmSync(file)
        } catch {
          /* ignore */
        }
      }
      return
    }
    const block = `${BEGIN}\n\n${body}\n\n${END}\n`
    fs.writeFileSync(file, stripped ? `${block}\n${stripped}` : block)
  } catch {
    /* materialization is best-effort — a failure here must not break session spawn */
  }
}

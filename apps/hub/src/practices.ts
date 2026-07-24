import crypto from 'node:crypto'
import type Database from 'better-sqlite3'
import type { SessionIdentity } from './identity.js'
import type { DangerFlags } from './types.js'

/**
 * Agent-writable PRACTICES layer (practices/hooks/gating, first slice).
 *
 * A practice is a durable working CONVENTION an agent records so future agents follow it
 * automatically ("always run `pnpm typecheck` before claiming done", "prefer Vitest here"). It sits
 * between memory and hooks on the security gradient:
 *   - Memory (memory.ts) is recalled KNOWLEDGE — inert until an agent chooses to recall it.
 *   - A practice is MATERIALIZED into every future agent's native instruction file at spawn (like an
 *     operator instruction), so it shapes behavior whether or not anyone recalls it. That "always-on,
 *     self-applied" property makes practices higher-risk than memory, so writes above the author's
 *     own account scope are gated (see decidePracticeGate).
 *
 * Structurally this mirrors MemoryStore (scope-agnostic persistence + provenance) plus an
 * InstructionStore-style materialize(). Scope keys are the shared scheme used across
 * instructions.ts / memory.ts / identity.ts:
 *   global | vendor:<provider> | project:<projectId> | account:<profileId>
 */
export interface Practice {
  id: string
  scope: string
  title: string
  body: string
  /** Provenance: the session that authored this practice (null when operator-written via the API). */
  fromSession: string | null
  /** Provenance: the account/profile the author acted under (null when operator-written). */
  fromProfile: string | null
  createdAt: string
  updatedAt: string
}

interface Row {
  id: string
  scope: string
  title: string
  body: string
  fromSession: string | null
  fromProfile: string | null
  createdAt: string
  updatedAt: string
}

export class PracticeStore {
  private readonly db: Database.Database
  private readonly insertStmt: Database.Statement
  private readonly getStmt: Database.Statement
  private readonly updateStmt: Database.Statement
  private readonly delStmt: Database.Statement

  constructor(db: Database.Database) {
    this.db = db
    db.exec(
      `CREATE TABLE IF NOT EXISTS practices (
        id TEXT PRIMARY KEY, scope TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
        fromSession TEXT, fromProfile TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL)`
    )
    db.exec('CREATE INDEX IF NOT EXISTS idx_practices_scope ON practices (scope, updatedAt DESC)')
    this.insertStmt = db.prepare(
      `INSERT INTO practices (id, scope, title, body, fromSession, fromProfile, createdAt, updatedAt)
       VALUES (@id, @scope, @title, @body, @fromSession, @fromProfile, @createdAt, @updatedAt)`
    )
    this.getStmt = db.prepare('SELECT * FROM practices WHERE id = ?')
    this.updateStmt = db.prepare('UPDATE practices SET title = ?, body = ?, updatedAt = ? WHERE id = ?')
    this.delStmt = db.prepare('DELETE FROM practices WHERE id = ?')
  }

  write(input: {
    scope: string
    title: string
    body: string
    fromSession?: string | null
    fromProfile?: string | null
  }): Practice {
    const now = new Date().toISOString()
    const row: Row = {
      id: crypto.randomUUID(),
      scope: input.scope,
      title: input.title.trim().slice(0, 200),
      body: input.body.trim(),
      fromSession: input.fromSession ?? null,
      fromProfile: input.fromProfile ?? null,
      createdAt: now,
      updatedAt: now,
    }
    this.insertStmt.run(row)
    return { ...row }
  }

  /** Patch a practice's title/body (leaves scope + provenance untouched); bumps updatedAt. */
  edit(id: string, patch: { title?: string; body?: string }): Practice | undefined {
    const existing = this.getStmt.get(id) as Row | undefined
    if (!existing) return undefined
    const title = patch.title !== undefined ? patch.title.trim().slice(0, 200) : existing.title
    const body = patch.body !== undefined ? patch.body.trim() : existing.body
    const updatedAt = new Date().toISOString()
    this.updateStmt.run(title, body, updatedAt, id)
    return { ...existing, title, body, updatedAt }
  }

  /** Fetch by id, optionally constrained to a set of readable scopes (undefined if outside). */
  get(id: string, scopes?: string[]): Practice | undefined {
    const r = this.getStmt.get(id) as Row | undefined
    if (!r) return undefined
    if (scopes && !scopes.includes(r.scope)) return undefined
    return { ...r }
  }

  /** List practices, newest first. `scopes: undefined` = every scope (operator view); `[]` = none. */
  list(opts: { scopes?: string[]; limit?: number } = {}): Practice[] {
    if (opts.scopes && opts.scopes.length === 0) return []
    const where: string[] = []
    const params: unknown[] = []
    if (opts.scopes) {
      where.push(`scope IN (${opts.scopes.map(() => '?').join(',')})`)
      params.push(...opts.scopes)
    }
    const sql = `SELECT * FROM practices ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY updatedAt DESC LIMIT ?`
    params.push(Math.min(Math.max(1, opts.limit ?? 200), 500))
    return (this.db.prepare(sql).all(...params) as Row[]).map((r) => ({ ...r }))
  }

  remove(id: string): void {
    this.delStmt.run(id)
  }

  /**
   * Render the practices that apply to a session as a materializable block, general → specific
   * (global, vendor, project, account) — the same scope order InstructionStore.materialize uses.
   * Each practice carries its provenance inline so the block is self-auditing. Returns '' when none
   * apply. The caller (writeManagedInstructions) wraps this in its own clearly-labeled fence,
   * distinct from the operator-instructions fence.
   */
  materialize(opts: { provider: 'claude' | 'codex'; projectId?: string; profileId: string }): string {
    const order = ['global', `vendor:${opts.provider}`]
    if (opts.projectId) order.push(`project:${opts.projectId}`)
    order.push(`account:${opts.profileId}`)
    const byScope = new Map<string, Practice[]>()
    for (const p of this.list({ scopes: order, limit: 500 })) {
      const arr = byScope.get(p.scope) ?? []
      arr.push(p)
      byScope.set(p.scope, arr)
    }
    const parts: string[] = []
    for (const scope of order) {
      for (const p of byScope.get(scope) ?? []) {
        parts.push(`### [${scope.split(':')[0]}] ${p.title}\n${provenanceLine(p)}\n\n${p.body}`)
      }
    }
    return parts.join('\n\n')
  }
}

function provenanceLine(p: Practice): string {
  const who =
    [p.fromSession ? `session ${p.fromSession.slice(0, 8)}` : null, p.fromProfile ? `profile ${p.fromProfile}` : null]
      .filter(Boolean)
      .join(', ') || 'operator'
  return `_authored by ${who} · ${p.updatedAt.slice(0, 10)} · scope ${p.scope}_`
}

// ---- Policy (pure — no SDK, so it's unit-testable) ------------------------------------------------

export type PracticeScopeKind = 'account' | 'project' | 'global' | 'vendor'

/**
 * Resolve an agent-supplied scope KIND to a concrete scope key against the caller's real identity
 * (the hub supplies the identity, never the agent). Default + `account` → the caller's own account
 * shelf (the low-friction, auto-allowed scope); `project` falls back to account when the caller is
 * not in a project. Extends memory's resolveWriteScope with global/vendor for the fleet tiers.
 */
export function practiceScope(id: SessionIdentity, kind?: PracticeScopeKind): string {
  switch (kind) {
    case 'global':
      return 'global'
    case 'vendor':
      return `vendor:${id.provider}`
    case 'project':
      return id.projectId ? `project:${id.projectId}` : `account:${id.profileId}`
    case 'account':
    default:
      return `account:${id.profileId}`
  }
}

export type PracticeGate =
  /** Write immediately (own-account scope, or the owner auto-approved). */
  | { action: 'allow' }
  /** Block on the operator-approval gate before writing (project/global/vendor). */
  | { action: 'approve' }
  /** Hard-deny: a semi-trusted bus turn may not persist a practice. */
  | { action: 'deny-bus' }

/**
 * The practice permission GRADIENT, and how the Danger Zone toggles override it. Pure so it can be
 * tested directly. Precedence:
 *   1. Bus turn (teammate-message-caused) → deny, UNLESS the owner enabled `busCanUseRiskyTools`.
 *      A persistence-class write must not originate from a semi-trusted turn by default.
 *   2. Own-account scope → allow (self-affecting, low blast radius — like memory_write).
 *   3. Owner enabled `autoApprovePractices` → allow even above account scope (fully-permissive opt-in).
 *   4. Otherwise (project/global/vendor) → operator approval.
 */
export function decidePracticeGate(opts: {
  ownAccount: boolean
  isBusTurn: boolean
  danger: DangerFlags
}): PracticeGate {
  if (opts.isBusTurn && !opts.danger.busCanUseRiskyTools) return { action: 'deny-bus' }
  if (opts.ownAccount) return { action: 'allow' }
  if (opts.danger.autoApprovePractices) return { action: 'allow' }
  return { action: 'approve' }
}

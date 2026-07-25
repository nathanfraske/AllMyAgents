import crypto from 'node:crypto'
import type Database from 'better-sqlite3'

/**
 * Shared, scoped agent memory (DESIGN D11, first slice).
 *
 * Agents save durable notes ("we decided X", "the build command is Y") that persist across turns
 * and across sessions, and recall them later — including notes written by a teammate on the same
 * project. Scope keys mirror the instruction layer (see identity.ts / instructions.ts):
 *   global | vendor:<provider> | project:<projectId> | account:<profileId>
 * Read/write access is enforced by the caller passing the identity's allowed scopes
 * (readableScopes / writableScopes); this store is scope-agnostic persistence + query.
 */
export interface Memory {
  id: string
  scope: string
  title: string
  body: string
  tags: string[]
  fromSession: string | null
  fromProfile: string | null
  createdAt: string
  updatedAt: string
}

interface Row {
  id: string
  scope: string
  title: string
  body: string
  tags: string
  fromSession: string | null
  fromProfile: string | null
  createdAt: string
  updatedAt: string
}

export class MemoryStore {
  private readonly db: Database.Database
  private readonly insertStmt: Database.Statement
  private readonly getStmt: Database.Statement
  private readonly delStmt: Database.Statement

  constructor(db: Database.Database) {
    this.db = db
    db.exec(
      `CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY, scope TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]', fromSession TEXT, fromProfile TEXT,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL)`
    )
    db.exec('CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories (scope, updatedAt DESC)')
    this.insertStmt = db.prepare(
      `INSERT INTO memories (id, scope, title, body, tags, fromSession, fromProfile, createdAt, updatedAt)
       VALUES (@id, @scope, @title, @body, @tags, @fromSession, @fromProfile, @createdAt, @updatedAt)`
    )
    this.getStmt = db.prepare('SELECT * FROM memories WHERE id = ?')
    this.delStmt = db.prepare('DELETE FROM memories WHERE id = ?')
  }

  write(input: {
    scope: string
    title: string
    body: string
    tags?: string[]
    fromSession?: string | null
    fromProfile?: string | null
  }): Memory {
    const now = new Date().toISOString()
    const row: Row = {
      id: crypto.randomUUID(),
      scope: input.scope,
      title: input.title.trim().slice(0, 200),
      body: input.body.trim(),
      tags: JSON.stringify((input.tags ?? []).map((t) => String(t).trim()).filter(Boolean).slice(0, 12)),
      fromSession: input.fromSession ?? null,
      fromProfile: input.fromProfile ?? null,
      createdAt: now,
      updatedAt: now,
    }
    this.insertStmt.run(row)
    return this.hydrate(row)
  }

  /** Fetch by id, optionally constrained to a set of readable scopes (returns undefined if outside). */
  get(id: string, scopes?: string[]): Memory | undefined {
    const r = this.getStmt.get(id) as Row | undefined
    if (!r) return undefined
    if (scopes && !scopes.includes(r.scope)) return undefined
    return this.hydrate(r)
  }

  list(opts: { scopes?: string[]; limit?: number } = {}): Memory[] {
    return this.query(opts.scopes, undefined, opts.limit ?? 50)
  }

  /**
   * Agent/operator-facing search. Exact SUBSTRING first (precise for a short phrase or an id, and
   * identical to the original behavior), then — only when that finds nothing — the SAME salient-term
   * overlap ranking {@link recall} uses.
   *
   * Why the fallback: the substring pass matches the WHOLE query verbatim, so any natural multi-word
   * question ("dev-harness gating build artifact codex bridge") missed every memory unless that exact
   * string appeared in one. Agents phrase searches in sentences, so the tool they are told to use for
   * recall answered "No matching memories" while a perfect match sat one row away — a SILENT recall
   * failure (observed live: a note was unfindable by its own topic words seconds after being written).
   * Scope filtering is applied on BOTH paths (the fallback passes `scopes` straight through), so a
   * broadened query can never surface a memory the caller could not already read.
   */
  search(query: string, opts: { scopes?: string[]; limit?: number } = {}): Memory[] {
    const q = query.trim()
    const limit = opts.limit ?? 20
    if (!q) return this.query(opts.scopes, undefined, limit)
    const exact = this.query(opts.scopes, q, limit)
    if (exact.length) return exact
    return this.recall(q, { scopes: opts.scopes, limit })
  }

  /**
   * Surface the memories most RELEVANT to a turn's text — for automatic hub-side recall, so an agent
   * doesn't have to think to call memory_search. Offline keyword-overlap scoring: salient terms from
   * the text are matched against each in-scope memory's title/body/tags, ranked by hit count then
   * recency. Returns [] when nothing is salient or nothing matches (so recall stays quiet unless it
   * genuinely has something).
   */
  recall(text: string, opts: { scopes?: string[]; limit?: number } = {}): Memory[] {
    const terms = salientTerms(text)
    if (!terms.length) return []
    const scored: Array<{ m: Memory; score: number }> = []
    for (const m of this.list({ scopes: opts.scopes, limit: 500 })) {
      const hay = `${m.title} ${m.body} ${m.tags.join(' ')}`.toLowerCase()
      let score = 0
      for (const t of terms) if (hay.includes(t)) score++
      if (score > 0) scored.push({ m, score })
    }
    scored.sort((a, b) => b.score - a.score || b.m.updatedAt.localeCompare(a.m.updatedAt))
    return scored.slice(0, Math.max(1, opts.limit ?? 5)).map((x) => x.m)
  }

  remove(id: string): void {
    this.delStmt.run(id)
  }

  // scopes: undefined = no scope filter (operator/API sees all); [] = nothing readable → empty.
  private query(scopes: string[] | undefined, q: string | undefined, limit: number): Memory[] {
    if (scopes && scopes.length === 0) return []
    const where: string[] = []
    const params: unknown[] = []
    if (scopes) {
      where.push(`scope IN (${scopes.map(() => '?').join(',')})`)
      params.push(...scopes)
    }
    if (q) {
      const like = '%' + q.replace(/[\\%_]/g, (m) => '\\' + m) + '%'
      where.push("(title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\')")
      params.push(like, like, like)
    }
    const sql = `SELECT * FROM memories ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY updatedAt DESC LIMIT ?`
    params.push(Math.min(Math.max(1, limit), 100))
    return (this.db.prepare(sql).all(...params) as Row[]).map((r) => this.hydrate(r))
  }

  private hydrate(r: Row): Memory {
    let tags: string[] = []
    try {
      const v = JSON.parse(r.tags)
      if (Array.isArray(v)) tags = v.map(String)
    } catch {
      /* corrupt tags → none */
    }
    return { ...r, tags }
  }
}

// Common words carry no signal for keyword-overlap recall; drop them (plus very short tokens) so
// only meaningful terms drive relevance.
const STOPWORDS = new Set(
  ('the a an and or but of to in on for with at by from as is are was were be been being it its this ' +
    'that these those you your yours we our ours they them their he she him her his i me my mine will ' +
    'would can could should shall do does did done have has had having not no nor yes if then else when ' +
    'what which who whom how why where whose there here about into over under out up down off than too ' +
    'very just also only more most some any all each both few many much such own same so per via '
  ).split(/\s+/)
)

function salientTerms(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 4 || STOPWORDS.has(raw) || seen.has(raw)) continue
    seen.add(raw)
    out.push(raw)
    if (out.length >= 24) break
  }
  return out
}

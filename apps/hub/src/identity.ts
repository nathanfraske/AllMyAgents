import type { SessionRecord } from './types.js'

/**
 * The identity an agent session acts under when it uses the inter-agent bus or the shared memory.
 * It is derived from the session record by the hub — never supplied by the agent — so a tool call
 * can be attributed and scope-checked against the caller's real profile/project (DESIGN D10/D11).
 */
export interface SessionIdentity {
  sessionId: string
  profileId: string
  provider: 'claude' | 'codex'
  projectId?: string
  /** Human-facing label (worktree/repo/cwd basename today; the session title once auto-naming lands). */
  label: string
}

export function identityOf(record: SessionRecord): SessionIdentity {
  const p = record.worktree ?? record.repo ?? record.cwd
  const label = p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || record.id.slice(0, 8)
  return {
    sessionId: record.id,
    profileId: record.profileId,
    provider: record.provider,
    projectId: record.projectId,
    label,
  }
}

/**
 * Memory scopes this identity may READ, general → specific. Mirrors the instruction-layer scope
 * keys (see instructions.ts): everyone sees `global` and their vendor's shelf; a session also sees
 * its own project's shared shelf and its own account's private shelf. A session can NOT read another
 * account's private memory or another project's shelf.
 */
export function readableScopes(id: SessionIdentity): string[] {
  const scopes = ['global', `vendor:${id.provider}`, `account:${id.profileId}`]
  if (id.projectId) scopes.push(`project:${id.projectId}`)
  return scopes
}

/**
 * Memory scopes this identity may WRITE. Agents curate their own account shelf and their project's
 * shared shelf; `global` and `vendor:*` are operator-curated (written via the API, not by agents).
 */
export function writableScopes(id: SessionIdentity): string[] {
  const scopes = [`account:${id.profileId}`]
  if (id.projectId) scopes.push(`project:${id.projectId}`)
  return scopes
}

import crypto from 'node:crypto'
import type Database from 'better-sqlite3'
import type { DelegatedAuthority } from './types.js'

export type TeamPermissionMode = 'safe' | 'edits' | 'full'

export interface TeamPresetManager {
  profileId: string
  model?: string
  effort?: string
  permissionMode: TeamPermissionMode
  maxChildPermissionMode: TeamPermissionMode
  maxLiveChildren: number
  parallelismTarget?: number
  canApproveChildren: boolean
  pauseExhaustedAccounts?: boolean
  allowWorkerSubagents?: boolean
  maxSubagentsPerWorker?: number
  delegation: DelegatedAuthority[]
  allowedTools: string[]
  orientationBrief?: string
  standingInstructions?: string
}

export interface TeamPresetAgent {
  id: string
  name: string
  purpose: string
  prompt: string
  profileId: string
  model?: string
  effort?: string
  permissionMode: TeamPermissionMode
  useWorktree: boolean
  authorities: DelegatedAuthority[]
  tools: string[]
}

export interface TeamPreset {
  id: string
  name: string
  description?: string
  manager: TeamPresetManager
  agents: TeamPresetAgent[]
  createdAt: string
  updatedAt: string
}

export type TeamPresetDraft = Omit<TeamPreset, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }

interface TeamPresetRow {
  id: string
  name: string
  body: string
  createdAt: string
  updatedAt: string
}

function text(value: unknown, field: string, max: number, required = true): string | undefined {
  if (value === undefined && !required) return undefined
  if (typeof value !== 'string') throw new Error(`${field} must be text`)
  const normalized = value.trim()
  if (required && !normalized) throw new Error(`${field} is required`)
  if (normalized.length > max) throw new Error(`${field} must be no longer than ${max} characters`)
  return normalized || undefined
}

function mode(value: unknown, field: string): TeamPermissionMode {
  if (value !== 'safe' && value !== 'edits' && value !== 'full') {
    throw new Error(`${field} must be safe, edits, or full`)
  }
  return value
}

function names(value: unknown, field: string, max = 128): string[] {
  if (!Array.isArray(value) || value.length > max) throw new Error(`${field} must be a bounded list`)
  const result: string[] = []
  for (const item of value) {
    const normalized = text(item, field, 128)!
    if (!/^[A-Za-z0-9_.:/-]+$/u.test(normalized)) throw new Error(`${field} contains an invalid name`)
    if (!result.includes(normalized)) result.push(normalized)
  }
  return result
}

function authorities(value: unknown, field: string): DelegatedAuthority[] {
  if (!Array.isArray(value) || value.length > 2) throw new Error(`${field} must be a bounded list`)
  const result: DelegatedAuthority[] = []
  for (const item of value) {
    if (item !== 'commit' && item !== 'push') throw new Error(`${field} may contain only commit and push`)
    if (!result.includes(item)) result.push(item)
  }
  return result
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} must be an object`)
  return value as Record<string, unknown>
}

/** Strict normalization is shared by the MCP boundary, persistence, and launch path. */
export function normalizeTeamPreset(value: unknown, existing?: TeamPreset): TeamPreset {
  const raw = object(value, 'preset')
  const now = new Date().toISOString()
  const rawManager = object(raw.manager, 'preset.manager')
  if (!Array.isArray(raw.agents) || raw.agents.length < 1 || raw.agents.length > 16) {
    throw new Error('preset.agents must contain 1 to 16 agents')
  }
  const manager: TeamPresetManager = {
    profileId: text(rawManager.profileId, 'preset.manager.profileId', 256)!,
    ...(text(rawManager.model, 'preset.manager.model', 256, false) ? { model: text(rawManager.model, 'preset.manager.model', 256, false) } : {}),
    ...(text(rawManager.effort, 'preset.manager.effort', 64, false) ? { effort: text(rawManager.effort, 'preset.manager.effort', 64, false) } : {}),
    permissionMode: mode(rawManager.permissionMode, 'preset.manager.permissionMode'),
    maxChildPermissionMode: mode(rawManager.maxChildPermissionMode, 'preset.manager.maxChildPermissionMode'),
    maxLiveChildren: Number(rawManager.maxLiveChildren),
    parallelismTarget: Number(rawManager.parallelismTarget ?? Math.min(3, Number(rawManager.maxLiveChildren))),
    canApproveChildren: rawManager.canApproveChildren === true,
    pauseExhaustedAccounts: rawManager.pauseExhaustedAccounts === true,
    allowWorkerSubagents: rawManager.allowWorkerSubagents === true,
    maxSubagentsPerWorker: Number(rawManager.maxSubagentsPerWorker ?? 2),
    delegation: authorities(rawManager.delegation ?? [], 'preset.manager.delegation'),
    allowedTools: names(rawManager.allowedTools ?? [], 'preset.manager.allowedTools'),
    ...(text(rawManager.orientationBrief, 'preset.manager.orientationBrief', 20_000, false)
      ? { orientationBrief: text(rawManager.orientationBrief, 'preset.manager.orientationBrief', 20_000, false) }
      : {}),
    ...(text(rawManager.standingInstructions, 'preset.manager.standingInstructions', 20_000, false)
      ? { standingInstructions: text(rawManager.standingInstructions, 'preset.manager.standingInstructions', 20_000, false) }
      : {}),
  }
  if (!Number.isInteger(manager.maxLiveChildren) || manager.maxLiveChildren < raw.agents.length || manager.maxLiveChildren > 16) {
    throw new Error('preset.manager.maxLiveChildren must be a whole number from the agent count through 16')
  }
  if (!Number.isInteger(manager.parallelismTarget) || manager.parallelismTarget! < 1 || manager.parallelismTarget! > manager.maxLiveChildren) {
    throw new Error('preset.manager.parallelismTarget must be a whole number from 1 through maxLiveChildren')
  }
  if (!Number.isInteger(manager.maxSubagentsPerWorker) || manager.maxSubagentsPerWorker! < 1 || manager.maxSubagentsPerWorker! > 8) {
    throw new Error('preset.manager.maxSubagentsPerWorker must be a whole number from 1 to 8')
  }
  const ids = new Set<string>()
  const agents = raw.agents.map((item, index): TeamPresetAgent => {
    const agent = object(item, `preset.agents[${index}]`)
    const id = text(agent.id, `preset.agents[${index}].id`, 80)!
    if (!/^[A-Za-z0-9_-]+$/u.test(id) || ids.has(id.toLowerCase())) {
      throw new Error(`preset.agents[${index}].id must be unique and contain only letters, digits, _ or -`)
    }
    ids.add(id.toLowerCase())
    const requestedAuthorities = authorities(agent.authorities ?? [], `preset.agents[${index}].authorities`)
    const requestedTools = names(agent.tools ?? [], `preset.agents[${index}].tools`)
    if (requestedAuthorities.some((authority) => !manager.delegation.includes(authority))) {
      throw new Error(`preset.agents[${index}] requests authority outside the manager ceiling`)
    }
    if (requestedTools.some((tool) => !manager.allowedTools.includes(tool))) {
      throw new Error(`preset.agents[${index}] requests a tool outside the manager ceiling`)
    }
    return {
      id,
      name: text(agent.name, `preset.agents[${index}].name`, 100)!,
      purpose: text(agent.purpose, `preset.agents[${index}].purpose`, 2_000)!,
      prompt: text(agent.prompt, `preset.agents[${index}].prompt`, 20_000)!,
      profileId: text(agent.profileId, `preset.agents[${index}].profileId`, 256)!,
      ...(text(agent.model, `preset.agents[${index}].model`, 256, false)
        ? { model: text(agent.model, `preset.agents[${index}].model`, 256, false) }
        : {}),
      ...(text(agent.effort, `preset.agents[${index}].effort`, 64, false)
        ? { effort: text(agent.effort, `preset.agents[${index}].effort`, 64, false) }
        : {}),
      permissionMode: mode(agent.permissionMode, `preset.agents[${index}].permissionMode`),
      useWorktree: agent.useWorktree !== false,
      authorities: requestedAuthorities,
      tools: requestedTools,
    }
  })
  const ranks: Record<TeamPermissionMode, number> = { safe: 0, edits: 1, full: 2 }
  if (agents.some((agent) => ranks[agent.permissionMode] > ranks[manager.maxChildPermissionMode])) {
    throw new Error('preset agent permission mode exceeds the manager child ceiling')
  }
  const requestedId = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : undefined
  if (requestedId && (!/^[A-Za-z0-9_-]+$/u.test(requestedId) || requestedId.length > 256)) {
    throw new Error('preset.id contains invalid characters')
  }
  return {
    id: existing?.id ?? requestedId ?? crypto.randomUUID(),
    name: text(raw.name, 'preset.name', 120)!,
    ...(text(raw.description, 'preset.description', 2_000, false)
      ? { description: text(raw.description, 'preset.description', 2_000, false) }
      : {}),
    manager,
    agents,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
}

export class TeamPresetStore {
  private readonly getStmt: Database.Statement
  private readonly listStmt: Database.Statement
  private readonly upsertStmt: Database.Statement
  private readonly deleteStmt: Database.Statement

  constructor(private readonly db: Database.Database) {
    db.exec(
      `CREATE TABLE IF NOT EXISTS team_presets (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, body TEXT NOT NULL,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
      )`,
    )
    db.exec('CREATE INDEX IF NOT EXISTS idx_team_presets_updated ON team_presets (updatedAt DESC)')
    this.getStmt = db.prepare('SELECT id, name, body, createdAt, updatedAt FROM team_presets WHERE id = ?')
    this.listStmt = db.prepare('SELECT id, name, body, createdAt, updatedAt FROM team_presets ORDER BY updatedAt DESC')
    this.upsertStmt = db.prepare(
      `INSERT INTO team_presets (id, name, body, createdAt, updatedAt)
       VALUES (@id, @name, @body, @createdAt, @updatedAt)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, body = excluded.body, updatedAt = excluded.updatedAt`,
    )
    this.deleteStmt = db.prepare('DELETE FROM team_presets WHERE id = ?')
  }

  private fromRow(row: TeamPresetRow | undefined): TeamPreset | undefined {
    if (!row) return undefined
    const body = JSON.parse(row.body) as Omit<TeamPreset, 'id' | 'name' | 'createdAt' | 'updatedAt'>
    return { id: row.id, name: row.name, ...body, createdAt: row.createdAt, updatedAt: row.updatedAt }
  }

  get(id: string): TeamPreset | undefined {
    return this.fromRow(this.getStmt.get(id) as TeamPresetRow | undefined)
  }

  list(): TeamPreset[] {
    return (this.listStmt.all() as TeamPresetRow[]).map((row) => this.fromRow(row)!)
  }

  save(draft: TeamPresetDraft): TeamPreset {
    const existing = draft.id ? this.get(draft.id) : undefined
    const preset = normalizeTeamPreset(draft, existing)
    const { id, name, createdAt, updatedAt, ...body } = preset
    this.upsertStmt.run({ id, name, body: JSON.stringify(body), createdAt, updatedAt })
    return preset
  }

  remove(id: string): boolean {
    return this.deleteStmt.run(id).changes > 0
  }
}

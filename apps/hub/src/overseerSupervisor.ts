import fs from 'node:fs'
import path from 'node:path'

export type OverseerSupervisorPhase =
  | 'starting'
  | 'booting'
  | 'live'
  | 'restarting'
  | 'retrying'
  | 'recovering'
  | 'offline'
  | 'stopping'

export interface OverseerSupervisorStatus {
  version: 1
  phase: OverseerSupervisorPhase
  detail: string
  updatedAt: string
  supervisorPid: number
  hubPid?: number
  port?: number
  attempt?: number
  error?: string
  overseerProfileId?: string
}

export const OVERSEER_SUPERVISOR_FILE = 'overseer-supervisor.json'

function bounded(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const out = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '').slice(0, max)
  return out || undefined
}

function safeErrorSummary(value: unknown): string | undefined {
  const raw = bounded(value, 4_000)?.toLowerCase()
  if (!raw) return undefined
  // This file survives outside the journal and may be inspected specifically because normal startup
  // failed. Never persist raw exception text here: vendor/runtime errors can contain paths, command
  // fragments, URLs, or credentials. The local desktop log remains the operator-only detailed source.
  if (/integrity|corrupt|malformed|\bwal\b|journal|database|sqlite/u.test(raw)) {
    return 'Journal validation or recovery failed; inspect the local desktop log for details.'
  }
  if (/timeout|timed out|unresponsive|wedged/u.test(raw)) {
    return 'A supervised hub or recovery step timed out; inspect the local desktop log for details.'
  }
  if (/eaddrinuse|address|listen|\bport\b/u.test(raw)) {
    return 'The hub could not acquire its local listener; inspect the local desktop log for details.'
  }
  if (/permission|access|eperm|eacces/u.test(raw)) {
    return 'A required local resource was not accessible; inspect the local desktop log for details.'
  }
  if (/\bexit|signal|child|worker/u.test(raw)) {
    return 'A supervised hub or worker process exited unexpectedly; inspect the local desktop log for details.'
  }
  return 'A supervised hub operation failed; inspect the local desktop log for details.'
}

function configuredOverseerProfile(dataDir: string): string | undefined {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8')) as {
      overseer?: { profileId?: unknown }
    }
    return bounded(config.overseer?.profileId, 256)
  } catch {
    return undefined
  }
}

/**
 * Supervisor-owned, journal-independent diagnostic breadcrumb. It intentionally contains no profile
 * paths, tokens, commands, prompts, or DB rows; the desktop can read it when SQLite never opened.
 */
export function writeOverseerSupervisorStatus(
  dataDir: string,
  input: Omit<OverseerSupervisorStatus, 'version' | 'updatedAt' | 'supervisorPid' | 'overseerProfileId'>,
): OverseerSupervisorStatus | undefined {
  try {
    fs.mkdirSync(dataDir, { recursive: true })
    const overseerProfileId = configuredOverseerProfile(dataDir)
    const error = safeErrorSummary(input.error)
    const value: OverseerSupervisorStatus = {
      version: 1,
      phase: input.phase,
      detail: bounded(input.detail, 2_000) ?? input.phase,
      updatedAt: new Date().toISOString(),
      supervisorPid: process.pid,
      ...(input.hubPid === undefined ? {} : { hubPid: input.hubPid }),
      ...(input.port === undefined ? {} : { port: input.port }),
      ...(input.attempt === undefined ? {} : { attempt: input.attempt }),
      ...(error ? { error } : {}),
      ...(overseerProfileId ? { overseerProfileId } : {}),
    }
    const file = path.join(dataDir, OVERSEER_SUPERVISOR_FILE)
    const temp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 })
    fs.renameSync(temp, file)
    return value
  } catch {
    return undefined
  }
}

export function readOverseerSupervisorStatus(dataDir: string): OverseerSupervisorStatus | undefined {
  try {
    const raw = fs.readFileSync(path.join(dataDir, OVERSEER_SUPERVISOR_FILE), 'utf8')
    if (raw.length > 64 * 1024) return undefined
    const value = JSON.parse(raw) as OverseerSupervisorStatus
    return value?.version === 1 && typeof value.phase === 'string' && typeof value.detail === 'string'
      ? value
      : undefined
  } catch {
    return undefined
  }
}

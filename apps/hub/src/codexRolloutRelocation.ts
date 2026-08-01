import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'

export interface CodexRolloutPathRepair {
  stateDatabase: string
  threadId: string
  rolloutRelativePath: string
}

export interface CodexRolloutPathRepairWarning {
  stateDatabase: string
  message: string
}

export interface CodexRolloutPathRepairResult {
  repairs: CodexRolloutPathRepair[]
  warnings: CodexRolloutPathRepairWarning[]
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function stateDatabases(profileDir: string): string[] {
  try {
    return fs.readdirSync(profileDir)
      .filter((name) => /^state_\d+\.sqlite$/i.test(name))
      .sort((a, b) => {
        const av = Number(a.match(/\d+/)?.[0] ?? 0)
        const bv = Number(b.match(/\d+/)?.[0] ?? 0)
        return bv - av
      })
  } catch {
    return []
  }
}

/**
 * Resolve a rollout after CODEX_HOME moved without guessing which thread file Codex intended.
 *
 * Codex persists an absolute `threads.rollout_path` in state_N.sqlite. Windows Store/MSIX execution can
 * virtualize AppData\Roaming beneath a package's LocalCache directory; once AllMyAgents is launched
 * outside that package, the profile and session files live at their normal Roaming path but the absolute
 * index still names the vanished virtualized root. `thread/resume` then fails even though the rollout is
 * present and intact.
 *
 * Only the root is allowed to change here. The complete path below the final `sessions` component must
 * exist under the current profile, its filename must identify the same thread, and realpath containment
 * must hold. If any of those facts is unavailable, leave the row alone and let Codex report the problem.
 */
function relocatedRollout(profileDir: string, threadId: string, stalePath: string): {
  absolutePath: string
  relativePath: string
} | undefined {
  if (!path.isAbsolute(profileDir) || fs.existsSync(stalePath)) return undefined

  const pieces = stalePath.split(/[\\/]+/)
  let sessionsAt = -1
  for (let i = pieces.length - 1; i >= 0; i -= 1) {
    if (pieces[i]?.toLowerCase() === 'sessions') {
      sessionsAt = i
      break
    }
  }
  const relativePieces = sessionsAt >= 0 ? pieces.slice(sessionsAt + 1) : []
  if (
    relativePieces.length === 0 ||
    relativePieces.some((piece) => !piece || piece === '.' || piece === '..' || piece.includes(':'))
  ) return undefined

  const fileName = relativePieces.at(-1)
  if (!fileName?.toLowerCase().endsWith(`-${threadId.toLowerCase()}.jsonl`)) return undefined

  const sessionsDir = path.resolve(profileDir, 'sessions')
  const candidate = path.resolve(sessionsDir, ...relativePieces)
  try {
    if (!fs.statSync(candidate).isFile()) return undefined
    const realSessions = fs.realpathSync.native(sessionsDir)
    const realCandidate = fs.realpathSync.native(candidate)
    const relative = path.relative(realSessions, realCandidate)
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return undefined
    }
    return {
      absolutePath: process.platform === 'win32' ? path.toNamespacedPath(realCandidate) : realCandidate,
      relativePath: path.join('sessions', relative),
    }
  } catch {
    return undefined
  }
}

/**
 * Repair relocatable Codex rollout indexes before app-server opens the profile.
 *
 * This is deliberately best-effort: an unfamiliar schema or locked database must not stop a new Codex
 * thread from starting. Updates use the stale value in the WHERE clause so a concurrent correction cannot
 * be overwritten, and no rollout/session file is copied, moved, deleted, or rewritten.
 */
export function repairCodexRolloutPaths(profileDir: string): CodexRolloutPathRepairResult {
  const result: CodexRolloutPathRepairResult = { repairs: [], warnings: [] }
  for (const stateDatabase of stateDatabases(profileDir)) {
    const databasePath = path.join(profileDir, stateDatabase)
    let db: Database.Database | undefined
    try {
      db = new Database(databasePath, { fileMustExist: true })
      db.pragma('busy_timeout = 1000')
      const columns = db.prepare('PRAGMA table_info(threads)').all() as Array<{ name?: unknown }>
      const names = new Set(columns.map((column) => column.name).filter((name): name is string => typeof name === 'string'))
      if (!names.has('id') || !names.has('rollout_path')) continue

      const rows = db.prepare('SELECT id, rollout_path FROM threads').all() as Array<{
        id?: unknown
        rollout_path?: unknown
      }>
      const update = db.prepare(
        'UPDATE threads SET rollout_path = ? WHERE id = ? AND rollout_path = ?',
      )
      const repairs = db.transaction(() => {
        const applied: CodexRolloutPathRepair[] = []
        for (const row of rows) {
          if (typeof row.id !== 'string' || typeof row.rollout_path !== 'string') continue
          const relocated = relocatedRollout(profileDir, row.id, row.rollout_path)
          if (!relocated) continue
          const changed = update.run(relocated.absolutePath, row.id, row.rollout_path).changes
          if (changed === 1) {
            applied.push({
              stateDatabase,
              threadId: row.id,
              rolloutRelativePath: relocated.relativePath,
            })
          }
        }
        return applied
      })()
      result.repairs.push(...repairs)
    } catch (error) {
      result.warnings.push({ stateDatabase, message: errorMessage(error) })
    } finally {
      try {
        db?.close()
      } catch {
        // The warning from the actual read/update is more useful than a best-effort close failure.
      }
    }
  }
  return result
}

import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { isSolelyHubManagedInstructions } from './instructions.js'
import type { SessionRecord } from './types.js'

export const WORKTREE_COLLISION_POLL_MS = 2_000

type ChangeKind = 'uncommitted' | 'committed' | 'both'

interface ChangedPath {
  display: string
  kind: ChangeKind
}

interface Writer {
  record: SessionRecord
  path: ChangedPath
  firstSeen: number
}

export interface WorktreeCollisionDetectorOptions {
  sessions: () => readonly SessionRecord[]
  /**
   * Deliver through SessionManager's existing provider steer path. The detector records an attempt before
   * awaiting this callback, so one rejected steer cannot become a noisy retry loop on every poll.
   */
  steer: (sessionId: string, message: string) => Promise<boolean | void>
  enabled?: () => boolean
  pollMs?: number
}

function pathKey(value: string): string {
  const normalized = value.replaceAll('\\', '/')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function repoKey(value: string): string {
  return pathKey(path.resolve(value))
}

const execFileAsync = promisify(execFile)

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  })
  return stdout
}

function addChanged(
  changed: Map<string, ChangedPath>,
  display: string,
  incoming: Exclude<ChangeKind, 'both'>
): void {
  if (!display) return
  const normalized = display.replaceAll('\\', '/')
  const key = pathKey(normalized)
  const existing = changed.get(key)
  changed.set(key, {
    display: existing?.display ?? normalized,
    kind: existing && existing.kind !== incoming ? 'both' : (existing?.kind ?? incoming),
  })
}

/** Paths Git reports as staged, unstaged, deleted, renamed, or untracked. Ignored files are excluded. */
async function uncommittedPaths(worktree: string): Promise<Map<string, ChangedPath>> {
  const changed = new Map<string, ChangedPath>()
  const output = await git(worktree, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  const entries = output.split('\0')
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (!entry || entry.length < 4) continue
    const status = entry.slice(0, 2)
    addChanged(changed, entry.slice(3), 'uncommitted')
    // In -z mode rename/copy records put the original pathname in the next NUL-delimited field.
    if (status.includes('R') || status.includes('C')) {
      const original = entries[++i]
      if (original) addChanged(changed, original, 'uncommitted')
    }
  }
  return changed
}

/**
 * Compare the agent branch with the primary checkout's HEAD. Their merge-base is the commit the worktree
 * branched from even when the primary branch has advanced since creation, so committed agent work remains
 * visible until it is merged back. --no-renames reports both sides of a rename as touched paths.
 */
async function committedPaths(
  record: SessionRecord,
  baseHead: string
): Promise<Map<string, ChangedPath>> {
  const changed = new Map<string, ChangedPath>()
  if (!record.worktree) return changed
  const output = await git(record.worktree, [
    'diff',
    '--name-only',
    '-z',
    '--no-renames',
    `${baseHead}...HEAD`,
  ])
  for (const file of output.split('\0')) addChanged(changed, file, 'committed')
  return changed
}

async function changesFor(record: SessionRecord, baseHead: string): Promise<Map<string, ChangedPath>> {
  const changed = new Map<string, ChangedPath>()
  if (!record.worktree) return changed
  const [uncommitted, committed] = await Promise.all([
    uncommittedPaths(record.worktree),
    committedPaths(record, baseHead),
  ])
  for (const value of uncommitted.values()) addChanged(changed, value.display, 'uncommitted')
  for (const value of committed.values()) addChanged(changed, value.display, 'committed')
  for (const [key, value] of changed) {
    if (value.display !== 'CLAUDE.md' && value.display !== 'AGENTS.md') continue
    try {
      const text = await fs.readFile(path.join(record.worktree, value.display), 'utf8')
      if (isSolelyHubManagedInstructions(text)) changed.delete(key)
    } catch {
      // A missing/deleted instruction file is an agent write, not a generated file we can prove safe.
    }
  }
  return changed
}

function agentName(record: SessionRecord): string {
  return record.title?.trim() || record.profileId || record.id
}

function detail(name: string, file: string, kind: ChangeKind): string {
  if (kind === 'committed') return `${name}'s branch has committed changes to ${file}.`
  if (kind === 'both') return `${name}'s branch has committed and uncommitted changes to ${file}.`
  return `${name} has uncommitted changes in ${file}.`
}

/**
 * Polls only active, worktree-backed sessions that share a repository. A lone active worktree causes no
 * Git subprocess at all. Collisions notify the later writer only: that is the agent with the cheapest
 * opportunity to change course, and sending the same fact to both doubles interruption/token cost.
 */
export class WorktreeCollisionDetector {
  private readonly firstSeen = new Map<string, number>()
  private readonly notified = new Set<string>()
  private nextSeen = 1
  private timer: ReturnType<typeof setInterval> | undefined
  private polling = false

  constructor(private readonly options: WorktreeCollisionDetectorOptions) {}

  start(): void {
    if (this.timer) return
    const pollMs = this.options.pollMs ?? WORKTREE_COLLISION_POLL_MS
    this.timer = setInterval(() => void this.poll(), pollMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  async poll(): Promise<void> {
    if (this.polling || this.options.enabled?.() === false) return
    this.polling = true
    try {
      const groups = new Map<string, SessionRecord[]>()
      for (const record of this.options.sessions()) {
        if (record.status !== 'active' || !record.repo || !record.worktree) continue
        const key = repoKey(record.repo)
        const group = groups.get(key) ?? []
        group.push(record)
        groups.set(key, group)
      }

      for (const records of groups.values()) {
        if (records.length < 2) continue
        let baseHead: string
        try {
          baseHead = (await git(records[0]!.repo!, ['rev-parse', 'HEAD'])).trim()
        } catch (error) {
          console.warn(
            `[worktree-collision] could not inspect repository ${records[0]!.repo}: ${
              error instanceof Error ? error.message : String(error)
            }`
          )
          continue
        }
        const inspected = await Promise.all(
          records.map(async (record) => {
            try {
              return await changesFor(record, baseHead)
            } catch (error) {
              // A disappearing/broken worktree must not stop the hub or suppress checks for healthy peers.
              console.warn(
                `[worktree-collision] could not inspect ${record.worktree}: ${
                  error instanceof Error ? error.message : String(error)
                }`
              )
              return new Map<string, ChangedPath>()
            }
          })
        )
        const writersByPath = new Map<string, Writer[]>()
        for (let recordIndex = 0; recordIndex < records.length; recordIndex++) {
          const record = records[recordIndex]!
          const changes = inspected[recordIndex]!
          for (const [fileKey, changedPath] of changes) {
            const seenKey = `${record.id}\0${fileKey}`
            let seen = this.firstSeen.get(seenKey)
            if (seen === undefined) {
              seen = this.nextSeen++
              this.firstSeen.set(seenKey, seen)
            }
            const writers = writersByPath.get(fileKey) ?? []
            writers.push({ record, path: changedPath, firstSeen: seen })
            writersByPath.set(fileKey, writers)
          }
        }

        for (const [fileKey, writers] of writersByPath) {
          if (writers.length < 2) continue
          for (let left = 0; left < writers.length - 1; left++) {
            for (let right = left + 1; right < writers.length; right++) {
              const a = writers[left]!
              const b = writers[right]!
              const ids = [a.record.id, b.record.id].sort()
              const collisionKey = `${ids[0]}\0${ids[1]}\0${fileKey}`
              if (this.notified.has(collisionKey)) continue
              this.notified.add(collisionKey)

              const later = a.firstSeen > b.firstSeen ? a : b
              const other = later === a ? b : a
              const name = agentName(other.record)
              const file = later.path.display
              const message =
                `Heads up: ${name} is also editing ${file} right now. ` +
                detail(name, other.path.display, other.path.kind)
              await this.options.steer(later.record.id, message)
            }
          }
        }
      }
    } finally {
      this.polling = false
    }
  }
}

import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { isSolelyHubManagedInstructions } from './instructions.js'
import type { SessionRecord } from './types.js'

export const WORKTREE_COLLISION_POLL_MS = 2_000

export type WorktreeChangeKind = 'uncommitted' | 'committed' | 'both'
type ChangeKind = WorktreeChangeKind

interface ChangedPath {
  display: string
  kind: ChangeKind
}

export interface WorktreeAdvanceCommit {
  commit: string
  subject: string
}

export interface WorktreeRiskSession {
  sessionId: string
  label: string
  branch: string | null
  worktree: string
  role: 'writer' | 'later-writer' | 'stale-writer'
}

export interface WorktreeRiskEvent {
  version: 1
  risk: 'concurrent-write' | 'stale-base'
  repo: string
  projectId: string | null
  file: string
  detectedAt: string
  key: string
  sessions: WorktreeRiskSession[]
  baseCommit: string | null
  mainCommit: string
  commitsBehind: number
  mainAdvance: WorktreeAdvanceCommit[]
  steeredSessionIds: string[]
}

/**
 * Read model for the project dashboard. This is deliberately produced by the detector's normal poll:
 * consumers never run a second `git status`/`git diff`, and they never scrape transcripts for filenames.
 */
export interface WorktreeAgentActivity {
  sessionId: string
  label: string
  branch: string | null
  worktree: string
  files: Array<{ file: string; kind: WorktreeChangeKind }>
  baseCommit: string
  mainCommit: string
  commitsBehind: number
  diverged: boolean
}

export interface WorktreeRiskSnapshot {
  risk: WorktreeRiskEvent['risk']
  file: string
  sessionIds: string[]
  commitsBehind: number
  mainAdvance: WorktreeAdvanceCommit[]
}

export interface WorktreeProjectActivity {
  projectId: string
  observedAt: string | null
  agents: WorktreeAgentActivity[]
  risks: WorktreeRiskSnapshot[]
}

export interface WorktreeStaleFile {
  file: string
  kind: ChangeKind
  commits: WorktreeAdvanceCommit[]
}

export interface WorktreeStalenessCheck {
  ok: boolean
  baseCommit: string
  mainCommit: string
  baseRef: string | null
  commitsBehind: number
  diverged: boolean
  staleFiles: WorktreeStaleFile[]
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
  report?: (event: WorktreeRiskEvent) => Promise<void> | void
  enabled?: () => boolean
  pollMs?: number
}

function pathKey(value: string): string {
  const normalized = value.replaceAll('\\', '/')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function isTestPath(value: string): boolean {
  const normalized = value.replaceAll('\\', '/').toLowerCase()
  return (
    /(?:^|\/)(?:test|tests|__tests__|fixtures?)(?:\/|$)/.test(normalized) ||
    /\.(?:test|spec)\.[^/]+$/.test(normalized)
  )
}

function compareRiskSeverity(a: WorktreeRiskSnapshot, b: WorktreeRiskSnapshot): number {
  if (a.risk !== b.risk) return a.risk === 'concurrent-write' ? -1 : 1
  if (a.risk === 'concurrent-write') {
    const participants = b.sessionIds.length - a.sessionIds.length
    if (participants) return participants
    const testRank = Number(isTestPath(a.file)) - Number(isTestPath(b.file))
    if (testRank) return testRank
  } else {
    const commits = b.commitsBehind - a.commitsBehind
    if (commits) return commits
  }
  return a.file.localeCompare(b.file)
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
 * Compare the agent branch with the current primary branch. The three-dot merge-base keeps only the
 * branch's committed work both before and after a rebase; comparing with the original base would falsely
 * attribute commits replayed from main to the agent. --no-renames reports both sides of a rename.
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

async function resolvesToCommit(repo: string, ref: string): Promise<string> {
  return (await git(repo, ['rev-parse', '--verify', `${ref}^{commit}`])).trim()
}

async function mainCommitFor(record: SessionRecord): Promise<string> {
  if (!record.repo) throw new Error(`session ${record.id} has no repository`)
  if (record.baseRef) {
    try {
      return await resolvesToCommit(record.repo, record.baseRef)
    } catch {
      // A renamed/deleted base branch should not make monitoring disappear. The primary checkout's HEAD
      // is the best honest fallback for legacy repositories whose branch topology changed after spawn.
    }
  }
  return resolvesToCommit(record.repo, 'HEAD')
}

async function baseCommitFor(record: SessionRecord, mainCommit: string): Promise<string> {
  // New records persist the exact object id at worktree creation. Trust that immutable id directly; a
  // missing/pruned object will fail the diff below, without paying a rev-parse subprocess every poll.
  if (record.baseCommit) return record.baseCommit
  // Legacy sessions predate persisted branch-point metadata. A merge-base is the narrowest honest
  // reconstruction; new sessions never take this path because WorkspaceManager records the exact commit.
  return (await git(record.worktree!, ['merge-base', 'HEAD', mainCommit])).trim()
}

async function isAncestor(repo: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await git(repo, ['merge-base', '--is-ancestor', ancestor, descendant])
    return true
  } catch {
    return false
  }
}

async function advanceCommitsForFile(
  repo: string,
  baseCommit: string,
  mainCommit: string,
  file: string
): Promise<WorktreeAdvanceCommit[]> {
  const output = await git(repo, [
    'log',
    '--format=%H%x09%s',
    `${baseCommit}..${mainCommit}`,
    '--',
    file,
  ])
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf('\t')
      return tab < 0
        ? { commit: line, subject: '' }
        : { commit: line.slice(0, tab), subject: line.slice(tab + 1) }
    })
}

interface SessionInspection {
  record: SessionRecord
  baseCommit: string
  mainCommit: string
  commitsBehind: number
  diverged: boolean
  changes: Map<string, ChangedPath>
  staleFiles: WorktreeStaleFile[]
}

async function inspectSession(record: SessionRecord): Promise<SessionInspection> {
  const mainCommit = await mainCommitFor(record)
  const baseCommit = await baseCommitFor(record, mainCommit)
  const changes = await changesFor(record, mainCommit)
  const diverged =
    baseCommit === mainCommit ? false : !(await isAncestor(record.repo!, baseCommit, mainCommit))
  const commitsBehind =
    baseCommit === mainCommit
      ? 0
      : Number((await git(record.repo!, ['rev-list', '--count', `${baseCommit}..${mainCommit}`])).trim())
  const staleFiles: WorktreeStaleFile[] = []
  if (baseCommit !== mainCommit) {
    const advancedPaths = new Set<string>()
    const output = await git(record.repo!, [
      'diff',
      '--name-only',
      '-z',
      '--no-renames',
      baseCommit,
      mainCommit,
    ])
    for (const file of output.split('\0')) if (file) advancedPaths.add(pathKey(file))
    for (const [key, changed] of changes) {
      if (!advancedPaths.has(key)) continue
      staleFiles.push({
        file: changed.display,
        kind: changed.kind,
        commits: await advanceCommitsForFile(record.repo!, baseCommit, mainCommit, changed.display),
      })
    }
  }
  return { record, baseCommit, mainCommit, commitsBehind, diverged, changes, staleFiles }
}

/**
 * Synchronous-at-the-call-site integration gate for a push/merge workflow. Ambient monitoring calls the
 * same inspection, so "safe in the background" and "safe to integrate now" cannot drift into two rules.
 */
export async function checkWorktreeStaleness(record: SessionRecord): Promise<WorktreeStalenessCheck> {
  if (!record.repo || !record.worktree) {
    throw new Error(`session ${record.id} is not backed by an isolated repository worktree`)
  }
  const inspected = await inspectSession(record)
  return {
    ok: !inspected.diverged && inspected.staleFiles.length === 0,
    baseCommit: inspected.baseCommit,
    mainCommit: inspected.mainCommit,
    baseRef: record.baseRef ?? null,
    commitsBehind: inspected.commitsBehind,
    diverged: inspected.diverged,
    staleFiles: inspected.staleFiles,
  }
}

function agentName(record: SessionRecord): string {
  return record.title?.trim() || record.profileId || record.id
}

function riskSession(record: SessionRecord, role: WorktreeRiskSession['role']): WorktreeRiskSession {
  return {
    sessionId: record.id,
    label: agentName(record),
    branch: record.branch ?? null,
    worktree: record.worktree!,
    role,
  }
}

function shortCommit(commit: string): string {
  return commit.slice(0, 8)
}

function staleMessage(
  file: WorktreeStaleFile,
  baseCommit: string,
  mainCommit: string,
  commitsBehind: number
): string {
  const commits = file.commits.length
    ? file.commits
        .slice(0, 3)
        .map((entry) => `${shortCommit(entry.commit)}${entry.subject ? ` (${entry.subject})` : ''}`)
        .join(', ')
    : shortCommit(mainCommit)
  return (
    `Heads up: ${file.file} that you are editing is stale. Main advanced from ` +
    `${shortCommit(baseCommit)} to ${shortCommit(mainCommit)} (${commitsBehind} ` +
    `${commitsBehind === 1 ? 'commit' : 'commits'}); ${commits} touched this file. ` +
    'Rebase or coordinate before integrating.'
  )
}

function detail(name: string, file: string, kind: ChangeKind): string {
  if (kind === 'committed') return `${name}'s branch has committed changes to ${file}.`
  if (kind === 'both') return `${name}'s branch has committed and uncommitted changes to ${file}.`
  return `${name} has uncommitted changes in ${file}.`
}

/**
 * Polls only active, worktree-backed sessions. Staleness applies even to a lone writer; concurrent-write
 * comparison begins only when a repository has at least two active writers. Collisions notify the later
 * writer only: that is the agent with the cheapest opportunity to change course, and sending the same
 * fact to both doubles interruption/token cost.
 */
export class WorktreeCollisionDetector {
  private readonly firstSeen = new Map<string, number>()
  private readonly notified = new Set<string>()
  private nextSeen = 1
  private timer: ReturnType<typeof setInterval> | undefined
  private polling = false
  private activityByProject = new Map<string, WorktreeProjectActivity>()

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

  projectActivity(projectId: string): WorktreeProjectActivity {
    return (
      this.activityByProject.get(projectId) ?? {
        projectId,
        observedAt: null,
        agents: [],
        risks: [],
      }
    )
  }

  async poll(): Promise<void> {
    if (this.polling) return
    if (this.options.enabled?.() === false) {
      this.activityByProject = new Map()
      return
    }
    this.polling = true
    try {
      const observedAt = new Date().toISOString()
      const nextActivity = new Map<string, WorktreeProjectActivity>()
      const activityFor = (projectId: string): WorktreeProjectActivity => {
        let activity = nextActivity.get(projectId)
        if (!activity) {
          activity = { projectId, observedAt, agents: [], risks: [] }
          nextActivity.set(projectId, activity)
        }
        return activity
      }
      const addRisk = (projectIds: Array<string | undefined>, risk: WorktreeRiskSnapshot): void => {
        for (const projectId of new Set(projectIds.filter((id): id is string => Boolean(id)))) {
          const activity = activityFor(projectId)
          if (risk.risk === 'concurrent-write') {
            const existing = activity.risks.find(
              (candidate) =>
                candidate.risk === 'concurrent-write' &&
                pathKey(candidate.file) === pathKey(risk.file)
            )
            if (existing) {
              existing.sessionIds = [...new Set([...existing.sessionIds, ...risk.sessionIds])].sort()
              existing.commitsBehind = Math.max(existing.commitsBehind, risk.commitsBehind)
              continue
            }
            activity.risks.push({
              ...risk,
              sessionIds: [...new Set(risk.sessionIds)].sort(),
            })
            continue
          }
          activity.risks.push(risk)
        }
      }
      const groups = new Map<string, SessionRecord[]>()
      for (const record of this.options.sessions()) {
        if (record.status !== 'active' || !record.repo || !record.worktree) continue
        const key = repoKey(record.repo)
        const group = groups.get(key) ?? []
        group.push(record)
        groups.set(key, group)
      }

      for (const records of groups.values()) {
        const inspected = await Promise.all(
          records.map(async (record) => {
            try {
              return await inspectSession(record)
            } catch (error) {
              // A disappearing/broken worktree must not stop the hub or suppress checks for healthy peers.
              console.warn(
                `[worktree-collision] could not inspect ${record.worktree}: ${
                  error instanceof Error ? error.message : String(error)
                }`
              )
              return undefined
            }
          })
        )
        const healthy = inspected.filter((item): item is SessionInspection => item !== undefined)

        for (const item of healthy) {
          const projectId = item.record.projectId
          if (!projectId) continue
          activityFor(projectId).agents.push({
            sessionId: item.record.id,
            label: agentName(item.record),
            branch: item.record.branch ?? null,
            worktree: item.record.worktree!,
            files: [...item.changes.values()]
              .map((changed) => ({ file: changed.display, kind: changed.kind }))
              .sort((a, b) => a.file.localeCompare(b.file)),
            baseCommit: item.baseCommit,
            mainCommit: item.mainCommit,
            commitsBehind: item.commitsBehind,
            diverged: item.diverged,
          })
        }

        for (const item of healthy) {
          for (const staleFile of item.staleFiles) {
            const advanceKey = staleFile.commits[0]?.commit ?? item.mainCommit
            const riskKey = `stale-base\0${item.record.id}\0${pathKey(staleFile.file)}\0${advanceKey}`
            addRisk([item.record.projectId], {
              risk: 'stale-base',
              file: staleFile.file,
              sessionIds: [item.record.id],
              commitsBehind: item.commitsBehind,
              mainAdvance: staleFile.commits,
            })
            if (this.notified.has(riskKey)) continue
            this.notified.add(riskKey)
            const accepted = await this.options.steer(
              item.record.id,
              staleMessage(staleFile, item.baseCommit, item.mainCommit, item.commitsBehind)
            )
            await this.report({
              version: 1,
              risk: 'stale-base',
              repo: item.record.repo!,
              projectId: item.record.projectId ?? null,
              file: staleFile.file,
              detectedAt: new Date().toISOString(),
              key: riskKey,
              sessions: [riskSession(item.record, 'stale-writer')],
              baseCommit: item.baseCommit,
              mainCommit: item.mainCommit,
              commitsBehind: item.commitsBehind,
              mainAdvance: staleFile.commits,
              steeredSessionIds: accepted === false ? [] : [item.record.id],
            })
          }
        }

        if (healthy.length < 2) continue
        const writersByPath = new Map<string, Writer[]>()
        for (const item of healthy) {
          const record = item.record
          const changes = item.changes
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
              const collisionKey = `concurrent-write\0${ids[0]}\0${ids[1]}\0${fileKey}`
              const later = a.firstSeen > b.firstSeen ? a : b
              const other = later === a ? b : a
              const laterInspection = healthy.find((item) => item.record.id === later.record.id)!
              addRisk([a.record.projectId, b.record.projectId], {
                risk: 'concurrent-write',
                file: later.path.display,
                sessionIds: ids,
                commitsBehind: laterInspection.commitsBehind,
                mainAdvance: [],
              })
              if (this.notified.has(collisionKey)) continue
              this.notified.add(collisionKey)

              const name = agentName(other.record)
              const file = later.path.display
              const message =
                `Heads up: ${name} is also editing ${file} right now. ` +
                detail(name, other.path.display, other.path.kind)
              const accepted = await this.options.steer(later.record.id, message)
              await this.report({
                version: 1,
                risk: 'concurrent-write',
                repo: later.record.repo!,
                projectId: later.record.projectId ?? other.record.projectId ?? null,
                file,
                detectedAt: new Date().toISOString(),
                key: collisionKey,
                sessions: [
                  riskSession(other.record, 'writer'),
                  riskSession(later.record, 'later-writer'),
                ],
                baseCommit: null,
                mainCommit: laterInspection.mainCommit,
                commitsBehind: laterInspection.commitsBehind,
                mainAdvance: [],
                steeredSessionIds: accepted === false ? [] : [later.record.id],
              })
            }
          }
        }
      }
      for (const activity of nextActivity.values()) {
        activity.agents.sort((a, b) => a.label.localeCompare(b.label))
        activity.risks.sort(compareRiskSeverity)
      }
      this.activityByProject = nextActivity
    } finally {
      this.polling = false
    }
  }

  private async report(event: WorktreeRiskEvent): Promise<void> {
    if (!this.options.report) return
    try {
      await this.options.report(event)
    } catch (error) {
      console.warn(
        `[worktree-collision] could not report ${event.risk} for ${event.file}: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  }
}

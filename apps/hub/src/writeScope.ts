import path from 'node:path'
import type { WorkerSessionSpec } from './workerProtocol.js'

/**
 * The worktree containment guard, shared by BOTH executors.
 *
 * It lived twice — once in InProcessExecutor, once in AgentWorker — and both copies carried the same
 * escape, which is the argument for having one. A second authority that agrees with the first is only
 * ever a liability: it can disagree later, and a bug has to be found twice.
 *
 * Each write tool names its path field differently, and reading the wrong one does not fail loudly — it
 * silently produces `undefined`, which the old code treated as "nothing to check, allow". So
 * `NotebookEdit({notebook_path: 'C:\\outside\\victim.ipynb'})` was enumerated as a write tool, yielded no
 * `file_path`, and was permitted straight out of the worktree the session advertises as its boundary.
 */
const PATH_FIELD: Record<string, string> = {
  Write: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  // Per the SDK's own schema (sdk-tools.d.ts NotebookEditInput): `notebook_path`, documented absolute.
  NotebookEdit: 'notebook_path',
}

/**
 * The tools that "Edits" mode means — the single definition of "this writes a file", shared by the
 * containment guard here and the hub's auto-approve policy.
 *
 * Deliberately derived from the same table rather than written out again next to the policy. The picker
 * promises "auto-approve file edits", and a second hand-maintained list is how that promise drifts from
 * what the policy actually frees: add a write tool to one list, forget the other, and either the guard
 * stops containing it or the mode stops covering it. One list cannot disagree with itself.
 */
export const EDIT_TOOLS: ReadonlySet<string> = new Set(Object.keys(PATH_FIELD))

/**
 * Windows and macOS default to case-insensitive filesystems; Linux does not. The previous code lowercased
 * both sides unconditionally, which is not merely cosmetic: on a case-sensitive filesystem it makes
 * `/work/Repo` and `/work/repo` compare equal, so a path genuinely OUTSIDE the worktree can match the
 * root and be allowed. Comparing case-insensitively is the safe choice only where the filesystem agrees.
 */
const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin'

const normalize = (p: string): string => (CASE_INSENSITIVE_FS ? p.toLowerCase() : p)

/**
 * Returns a denial reason when `toolName` would write outside the session's worktree, or undefined when
 * the write is in scope (or the session has no worktree to contain).
 *
 * FAILS CLOSED: a recognised write tool whose path argument is missing or not a string is denied rather
 * than allowed. "I could not tell where this writes" is not a reason to permit it — that assumption is
 * exactly what let NotebookEdit through.
 */
export function checkWriteScope(
  spec: Pick<WorkerSessionSpec, 'worktree' | 'cwd'>,
  toolName: string,
  input: unknown
): string | undefined {
  if (!spec.worktree) return undefined
  const field = PATH_FIELD[toolName]
  if (!field) return undefined // not a write tool
  const raw = (input as Record<string, unknown> | null)?.[field]
  if (typeof raw !== 'string' || !raw) {
    return `${toolName} did not specify a ${field}, so it cannot be checked against this session's worktree (${spec.worktree})`
  }
  const resolved = normalize(path.resolve(spec.cwd, raw))
  const root = normalize(spec.worktree)
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    return `write to ${raw} is outside this session's worktree (${spec.worktree}) — use a path inside the worktree`
  }
  return undefined
}

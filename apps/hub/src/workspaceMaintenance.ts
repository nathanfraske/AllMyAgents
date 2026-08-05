/**
 * One-shot orphan-worktree housekeeping worker.
 *
 * Git inspection and recursive build-artifact removal are intentionally synchronous inside this child:
 * they are easy to reason about here and can never block the hub's HTTP/WS event loop or readiness probe.
 * WorkspaceManager keeps the fail-closed containment/work-preservation rules authoritative.
 */
import { performance } from 'node:perf_hooks'
import { WorkspaceManager } from './workspace.js'

type ReapRequest = { type: 'reap'; liveWorktrees: string[]; eligibleBeforeMs: number }
type ReapResult =
  | {
      type: 'workspace-reaped'
      durationMs: number
      liveCount: number
      removed: string[]
      keptWithWork: Array<{ worktree: string; reason: string }>
    }
  | { type: 'workspace-reap-error'; error: string }

const [worktreesRoot, scratchRoot] = process.argv.slice(2)
let handled = false

function finish(result: ReapResult, exitCode: number): void {
  process.exitCode = exitCode
  if (!process.send) return
  process.send(result, () => process.disconnect?.())
}

process.once('message', (raw: unknown) => {
  if (handled) return
  handled = true
  const request = raw as Partial<ReapRequest> | null
  if (
    !worktreesRoot ||
    !scratchRoot ||
    request?.type !== 'reap' ||
    !Array.isArray(request.liveWorktrees) ||
    request.liveWorktrees.some((value) => typeof value !== 'string') ||
    typeof request.eligibleBeforeMs !== 'number' ||
    !Number.isFinite(request.eligibleBeforeMs)
  ) {
    finish({ type: 'workspace-reap-error', error: 'workspace maintenance request is invalid' }, 1)
    return
  }
  const started = performance.now()
  try {
    const workspace = new WorkspaceManager(worktreesRoot, scratchRoot)
    const result = workspace.reapOrphanWorktrees(request.liveWorktrees, {
      eligibleBeforeMs: request.eligibleBeforeMs,
    })
    finish(
      {
        type: 'workspace-reaped',
        durationMs: Math.round((performance.now() - started) * 10) / 10,
        liveCount: request.liveWorktrees.length,
        ...result,
      },
      0,
    )
  } catch (error) {
    finish(
      {
        type: 'workspace-reap-error',
        error: (error instanceof Error ? error.message : String(error))
          .replace(/[\u0000-\u001f\u007f]/g, ' ')
          .slice(0, 512),
      },
      1,
    )
  }
})

process.once('disconnect', () => {
  if (!handled) process.exit(1)
})

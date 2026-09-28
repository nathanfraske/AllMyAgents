import type { DurableRun } from './durableRuns.js'
import { stripVTControlCharacters } from 'node:util'

function noticeText(value: string, limit: number): string {
  const text = Array.from(stripVTControlCharacters(value).replace(/\s+/gu, ' ').trim())
  return text.length > limit ? `${text.slice(0, limit).join('')}… [truncated]` : text.join('')
}

/** The wake-up is a pointer, not a second copy of the command and log tail. No retained data changes. */
export function durableRunTerminalNotice(
  run: Pick<DurableRun, 'id' | 'kind' | 'state' | 'exitCode' | 'signal' | 'commandSummary' | 'error' | 'stderrBytes' | 'logsTruncated'>,
  targetLabel: string,
): string {
  if (run.state === 'running' || run.state === 'queued') throw new Error('Run is not terminal')
  const exit = run.exitCode === undefined || run.exitCode === null ? '' : ` (exit ${run.exitCode})`
  const signal = run.signal ? `, signal ${noticeText(run.signal, 32)}` : ''
  const outcome = run.state === 'succeeded' ? `succeeded${exit}`
    : run.state === 'failed' ? `failed${exit}${signal}`
      : run.state === 'cancelled' ? `was cancelled${exit}${signal}`
        : 'has an unknown outcome; it may still be running or may have completed on the target'
  const error = run.error && noticeText(run.error, 500)
  return [
    `Durable ${run.kind} run ${run.id} for ${noticeText(targetLabel, 96)} ${outcome}.`,
    `Command preview: ${noticeText(run.commandSummary, 180)}`,
    ...(run.state !== 'succeeded' && error ? [`Bounded failure detail: ${error}`] : []),
    ...(run.state === 'succeeded' && (run.stderrBytes > 0 || error)
      ? ['Stderr/diagnostics retained; inspect logs if needed.'] : []),
    ...(run.logsTruncated ? ['Retained logs are truncated.'] : []),
    run.state === 'outcome_unknown'
      ? `Inspect run ${run.id} before deciding what happened. Do not retry it blindly.`
      : `Inspect run ${run.id} for retained evidence and continue from this terminal state.`,
    'Use detail=full for the exact command/record.',
  ].join('\n')
}

/** Model-facing projection only. The durable record and log cursors remain authoritative. */
export function summarizeDurableRun(run: DurableRun, stateOnly = false) {
  const result = run.result && typeof run.result === 'object'
    ? run.result as { failure?: unknown; transport?: unknown } : undefined
  return {
    id: run.id, projectId: run.projectId, actorSessionId: run.actorSessionId,
    actorLabel: run.actorLabel, targetSessionId: run.targetSessionId,
    state: run.state, kind: run.kind, dependsOnRunId: run.dependsOnRunId,
    createdAt: run.createdAt, startedAt: run.startedAt, completedAt: run.completedAt,
    timeoutMs: run.timeoutMs, cancelRequested: run.cancelRequested,
    exitCode: run.exitCode, signal: run.signal,
    error: run.state === 'succeeded' ? undefined : run.error,
    failure: result?.failure, transport: result?.transport,
    stdoutBytes: run.stdoutBytes, stderrBytes: run.stderrBytes, logsTruncated: run.logsTruncated,
    ...(!stateOnly ? {
      commandSummary: run.commandSummary, commandSha256: run.commandSha256,
      executionTarget: run.executionTarget?.kind === 'remote'
        ? { kind: 'remote', siteId: run.executionTarget.siteId, rootId: run.executionTarget.rootId,
          cwd: run.executionTarget.cwd, requiredTools: run.executionTarget.requiredTools }
        : run.executionTarget,
      cwd: run.cwd,
      platform: run.provenance?.platform, architecture: run.provenance?.architecture,
      gitHead: run.provenance?.git?.head,
      sourceManifestSha256: run.provenance?.git?.sourceManifestSha256,
    } : {}),
  }
}

export function durableRunView(run: DurableRun, detail?: 'summary' | 'full', stateOnly = false) {
  return detail === 'full' ? run : summarizeDurableRun(run, stateOnly)
}

import type { DurableRun } from './durableRuns.js'

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

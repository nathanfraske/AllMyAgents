import fs from 'node:fs'

export const MAX_REVIVE_FAILURES = 5

export interface SupervisorRuntimePaths {
  supervisorEntry: string
  hubEntry: string
  workingDirectory: string
  exists?: (candidate: string) => boolean
}

/**
 * A supervisor already resident in memory can outlive the checkout that supplied
 * it. No retry can repair that process: it cannot reload code or spawn the entry
 * that was deleted underneath it.
 */
export function supervisorRuntimeIssue(paths: SupervisorRuntimePaths): string | null {
  const exists = paths.exists ?? fs.existsSync
  if (!exists(paths.supervisorEntry)) {
    return `supervisor entry no longer exists: ${paths.supervisorEntry}`
  }
  if (!exists(paths.workingDirectory)) {
    return `supervisor working directory no longer exists: ${paths.workingDirectory}`
  }
  if (!exists(paths.hubEntry)) {
    return `hub entry no longer exists: ${paths.hubEntry}`
  }
  return null
}

export function revivePreflightIssue(
  runtimeIssue: string | null,
  fixedPort: number,
  portOccupied: boolean
): string | null {
  if (runtimeIssue) return runtimeIssue
  if (portOccupied) {
    return `fixed port ${fixedPort} is still held after the live hub died; another replacement cannot bind it`
  }
  return null
}

export interface ReviveFailureState {
  attempts: number
  repeated: number
  exhausted: boolean
}

/**
 * One recovery episode is finite. `repeated` makes the identical-failure case
 * explicit in diagnostics; `attempts` is also bounded so alternating permanent
 * failures cannot evade the guard forever.
 */
export class ReviveFailureGuard {
  private attempts = 0
  private previous = ''
  private repeated = 0

  constructor(private readonly maximum = MAX_REVIVE_FAILURES) {}

  record(cause: string): ReviveFailureState {
    this.attempts++
    if (cause === this.previous) this.repeated++
    else {
      this.previous = cause
      this.repeated = 1
    }
    return {
      attempts: this.attempts,
      repeated: this.repeated,
      exhausted: this.attempts >= this.maximum || this.repeated >= this.maximum,
    }
  }

  reset(): void {
    this.attempts = 0
    this.previous = ''
    this.repeated = 0
  }
}

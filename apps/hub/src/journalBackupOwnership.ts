import { randomUUID } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import {
  requestJournalBackupControl,
  type JournalBackupControlCommand,
} from './restartHandshake.js'

export const JOURNAL_BACKUP_CONTROL_TIMEOUT_MS = 120_000
export const JOURNAL_BACKUP_ACTIVATION_TIMEOUT_MS = 5_000

export interface JournalBackupOwnershipOptions {
  requestId?: () => string
  /** Backward-compatible test override for both pause and activation. */
  timeoutMs?: number
  pauseTimeoutMs?: number
  activationTimeoutMs?: number
}

/**
 * Parent-side single-owner protocol for hub processes sharing one journal/backup directory.
 *
 * The coordinator never infers ownership from process color or listener state. Call sites name the four
 * legal transitions explicitly, and every wire command carries a global monotonic epoch plus a unique
 * request id. The hub endpoint rejects older epochs; the request id prevents a late pause acknowledgement
 * from satisfying a newer resume waiter.
 */
export class JournalBackupOwnershipProtocol {
  private epoch = 0
  private owner: ChildProcess | undefined
  private readonly requestId: () => string
  private readonly pauseTimeoutMs: number
  private readonly activationTimeoutMs: number

  constructor(options: JournalBackupOwnershipOptions = {}) {
    this.requestId = options.requestId ?? randomUUID
    this.pauseTimeoutMs =
      options.pauseTimeoutMs ??
      options.timeoutMs ??
      JOURNAL_BACKUP_CONTROL_TIMEOUT_MS
    this.activationTimeoutMs =
      options.activationTimeoutMs ??
      options.timeoutMs ??
      JOURNAL_BACKUP_ACTIVATION_TIMEOUT_MS
  }

  /** Initial/revived blue only: call after the parent has consumed ready and completed HTTP health. */
  async activateInitialBlueAfterHealth(blue: ChildProcess): Promise<void> {
    this.assertNoOtherOwner(blue)
    // Ownership is provisional before send: if the acknowledgement is lost after the hub applied the
    // command, no replacement may activate until this process is known dead or explicitly paused.
    this.owner = blue
    await this.setActive(blue, true, this.activationTimeoutMs)
  }

  /** Blue only: settle its generation and receive the pause acknowledgement before sending drain. */
  async pauseBlueBeforeDrain(blue: ChildProcess): Promise<void> {
    this.assertNoOtherOwner(blue)
    await this.setActive(blue, false, this.pauseTimeoutMs)
    if (this.owner === blue) this.owner = undefined
  }

  /** Rollback only: a higher epoch reactivates blue even if an older pause acknowledgement arrives late. */
  async resumeBlueAfterRollback(blue: ChildProcess): Promise<void> {
    this.assertNoOtherOwner(blue)
    this.owner = blue
    await this.setActive(blue, true, this.activationTimeoutMs)
  }

  /** Green only: call after the parent has received `promoted`, never after ephemeral health alone. */
  async activatePromotedGreen(green: ChildProcess): Promise<void> {
    this.assertNoOtherOwner(green)
    this.owner = green
    await this.setActive(green, true, this.activationTimeoutMs)
  }

  private assertNoOtherOwner(candidate: ChildProcess): void {
    if (
      this.owner &&
      (this.owner.exitCode !== null || this.owner.signalCode !== null)
    ) {
      this.owner = undefined
    }
    if (this.owner && this.owner !== candidate) {
      throw new Error('journal backup ownership already belongs to another hub process')
    }
  }

  private async setActive(
    child: ChildProcess,
    active: boolean,
    timeoutMs: number
  ): Promise<void> {
    const command: JournalBackupControlCommand = {
      type: 'journal-backup-control',
      requestId: this.requestId(),
      epoch: ++this.epoch,
      active,
    }
    const result = await requestJournalBackupControl(
      child,
      command,
      timeoutMs
    )
    if (result.epoch !== command.epoch) {
      throw new Error(
        `journal backup control ${command.requestId} acknowledged epoch ${result.epoch}, expected ${command.epoch}`
      )
    }
    if (result.error) {
      throw new Error(`journal backup control ${command.requestId} failed: ${result.error}`)
    }
    if (!result.applied || result.active !== active) {
      throw new Error(
        `journal backup control ${command.requestId} was superseded (wanted active=${String(active)}, got active=${String(result.active)})`
      )
    }
  }
}

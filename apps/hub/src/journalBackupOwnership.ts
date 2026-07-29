import { randomUUID } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import {
  requestJournalBackupControl,
  type JournalBackupControlCommand,
} from './restartHandshake.js'

export const JOURNAL_BACKUP_CONTROL_TIMEOUT_MS = 120_000

export interface JournalBackupOwnershipOptions {
  requestId?: () => string
  timeoutMs?: number
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
  private readonly timeoutMs: number

  constructor(options: JournalBackupOwnershipOptions = {}) {
    this.requestId = options.requestId ?? randomUUID
    this.timeoutMs = options.timeoutMs ?? JOURNAL_BACKUP_CONTROL_TIMEOUT_MS
  }

  /** Initial/revived blue only: call after the parent has consumed ready and completed HTTP health. */
  async activateInitialBlueAfterHealth(blue: ChildProcess): Promise<void> {
    this.assertNoOtherOwner(blue)
    // Ownership is provisional before send: if the acknowledgement is lost after the hub applied the
    // command, no replacement may activate until this process is known dead or explicitly paused.
    this.owner = blue
    await this.setActive(blue, true)
  }

  /** Blue only: settle its generation and receive the pause acknowledgement before sending drain. */
  async pauseBlueBeforeDrain(blue: ChildProcess): Promise<void> {
    this.assertNoOtherOwner(blue)
    await this.setActive(blue, false)
    if (this.owner === blue) this.owner = undefined
  }

  /** Rollback only: a higher epoch reactivates blue even if an older pause acknowledgement arrives late. */
  async resumeBlueAfterRollback(blue: ChildProcess): Promise<void> {
    this.assertNoOtherOwner(blue)
    this.owner = blue
    await this.setActive(blue, true)
  }

  /** Green only: call after the parent has received `promoted`, never after ephemeral health alone. */
  async activatePromotedGreen(green: ChildProcess): Promise<void> {
    this.assertNoOtherOwner(green)
    this.owner = green
    await this.setActive(green, true)
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

  private async setActive(child: ChildProcess, active: boolean): Promise<void> {
    const command: JournalBackupControlCommand = {
      type: 'journal-backup-control',
      requestId: this.requestId(),
      epoch: ++this.epoch,
      active,
    }
    const result = await requestJournalBackupControl(
      child,
      command,
      this.timeoutMs
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

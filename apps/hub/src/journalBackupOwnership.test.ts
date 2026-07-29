import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import type { ChildProcess } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createJournalBackupSupervisor, type SnapshotResult } from './journalBackup.js'
import { JournalBackupOwnershipProtocol } from './journalBackupOwnership.js'
import type {
  HubMsg,
  JournalBackupControlCommand,
  SupervisorMsg,
} from './restartHandshake.js'

class FakeHub extends EventEmitter {
  readonly sent: SupervisorMsg[] = []
  active = false
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null

  constructor(
    private readonly respond: (
      hub: FakeHub,
      command: JournalBackupControlCommand
    ) => void = FakeHub.applyAndAcknowledge
  ) {
    super()
  }

  send(message: SupervisorMsg): boolean {
    this.sent.push(message)
    if (message.type === 'journal-backup-control') this.respond(this, message)
    return true
  }

  asChild(): ChildProcess {
    return this as unknown as ChildProcess
  }

  static applyAndAcknowledge(hub: FakeHub, command: JournalBackupControlCommand): void {
    queueMicrotask(() => {
      hub.active = command.active
      const result: HubMsg = {
        type: 'journal-backup-control-result',
        requestId: command.requestId,
        epoch: command.epoch,
        active: command.active,
        applied: true,
      }
      hub.emit('message', result)
    })
  }
}

class ThrowingHub extends FakeHub {
  override send(): boolean {
    throw new Error('test IPC channel closed')
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
} {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('supervised journal backup ownership protocol', () => {
  it('keeps green inactive through health, pauses blue before handoff, and activates only promoted green', async () => {
    const requestIds = ['blue-after-health', 'blue-before-drain', 'green-after-promote']
    const protocol = new JournalBackupOwnershipProtocol({
      requestId: () => requestIds.shift() ?? 'unexpected',
      timeoutMs: 1_000,
    })
    const blue = new FakeHub()
    const green = new FakeHub()

    // The parent has now processed blue's ready message and health response.
    await protocol.activateInitialBlueAfterHealth(blue.asChild())
    expect(blue.active).toBe(true)
    expect(green.sent).toEqual([]) // green boot + ephemeral health do not acquire ownership

    await protocol.pauseBlueBeforeDrain(blue.asChild())
    expect(blue.active).toBe(false)
    expect(green.active).toBe(false)

    // Called only after the parent receives `promoted`.
    await protocol.activatePromotedGreen(green.asChild())
    expect(blue.active).toBe(false)
    expect(green.active).toBe(true)

    const commands = [...blue.sent, ...green.sent].filter(
      (message): message is JournalBackupControlCommand =>
        message.type === 'journal-backup-control'
    )
    expect(commands.map(({ requestId, epoch, active }) => ({ requestId, epoch, active }))).toEqual([
      { requestId: 'blue-after-health', epoch: 1, active: true },
      { requestId: 'blue-before-drain', epoch: 2, active: false },
      { requestId: 'green-after-promote', epoch: 3, active: true },
    ])
  })

  it('resumes blue with a newer epoch on rollback and refuses two acknowledged owners', async () => {
    let request = 0
    const protocol = new JournalBackupOwnershipProtocol({
      requestId: () => `request-${++request}`,
      timeoutMs: 1_000,
    })
    const blue = new FakeHub()
    const green = new FakeHub()

    await protocol.activateInitialBlueAfterHealth(blue.asChild())
    await expect(protocol.activatePromotedGreen(green.asChild())).rejects.toThrow(/owner/i)
    expect(green.sent).toEqual([])

    await protocol.pauseBlueBeforeDrain(blue.asChild())
    await protocol.resumeBlueAfterRollback(blue.asChild())
    expect(blue.active).toBe(true)
    const controls = blue.sent.filter(
      (message): message is JournalBackupControlCommand =>
        message.type === 'journal-backup-control'
    )
    expect(controls.map(({ epoch, active }) => ({ epoch, active }))).toEqual([
      { epoch: 1, active: true },
      { epoch: 2, active: false },
      { epoch: 3, active: true },
    ])
  })

  it('correlates acknowledgements by request id so a late pause result cannot satisfy resume', async () => {
    const acknowledgements: Array<() => void> = []
    const blue = new FakeHub((hub, command) => {
      acknowledgements.push(() => FakeHub.applyAndAcknowledge(hub, command))
    })
    let request = 0
    const protocol = new JournalBackupOwnershipProtocol({
      requestId: () => `request-${++request}`,
      timeoutMs: 1_000,
    })

    const activating = protocol.activateInitialBlueAfterHealth(blue.asChild())
    acknowledgements.shift()?.()
    await activating

    const pausing = protocol.pauseBlueBeforeDrain(blue.asChild())
    const pauseAck = acknowledgements.shift()
    pauseAck?.()
    await pausing

    const resuming = protocol.resumeBlueAfterRollback(blue.asChild())
    // Re-deliver the old pause acknowledgement before the matching resume acknowledgement.
    pauseAck?.()
    let resumed = false
    void resuming.then(() => {
      resumed = true
    })
    await Promise.resolve()
    expect(resumed).toBe(false)

    acknowledgements.shift()?.()
    await resuming
    expect(blue.active).toBe(true)
  })

  it('fences an activation with a lost acknowledgement until that provisional owner is confirmed dead', async () => {
    let request = 0
    const protocol = new JournalBackupOwnershipProtocol({
      requestId: () => `request-${++request}`,
      timeoutMs: 10,
    })
    const blue = new FakeHub()
    const silentGreen = new FakeHub(() => {
      /* applied state is unknown to the parent because no acknowledgement arrives */
    })

    await protocol.activateInitialBlueAfterHealth(blue.asChild())
    await protocol.pauseBlueBeforeDrain(blue.asChild())
    await expect(
      protocol.activatePromotedGreen(silentGreen.asChild())
    ).rejects.toThrow(/timed out/i)

    await expect(protocol.resumeBlueAfterRollback(blue.asChild())).rejects.toThrow(/owner/i)
    silentGreen.exitCode = 1
    await protocol.resumeBlueAfterRollback(blue.asChild())
    expect(blue.active).toBe(true)
  })

  it('fails a closed IPC send immediately and cleans the matching acknowledgement listeners', async () => {
    const protocol = new JournalBackupOwnershipProtocol({
      requestId: () => 'closed-channel',
      timeoutMs: 1_000,
    })
    const hub = new ThrowingHub()

    await expect(
      protocol.activateInitialBlueAfterHealth(hub.asChild())
    ).rejects.toThrow(/channel closed/i)
    expect(hub.listenerCount('message')).toBe(0)
    expect(hub.listenerCount('exit')).toBe(0)
  })

  it('bounds a hung pause, aborts handoff, and resumes blue with its partial still invisible', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-journal-backup-hung-'))
    const firstStarted = deferred<void>()
    const releaseFirst = deferred<SnapshotResult>()
    const resumedRunStarted = deferred<void>()
    let calls = 0
    const backups = createJournalBackupSupervisor(
      {} as never,
      { dir: root, intervalMs: 1 },
      async (): Promise<SnapshotResult> => {
        calls += 1
        const partial = path.join(root, `hung-${calls}.db.partial`)
        fs.writeFileSync(partial, 'not published')
        if (calls === 1) {
          firstStarted.resolve()
          const result = await releaseFirst.promise
          fs.rmSync(partial, { force: true })
          return result
        }
        fs.rmSync(partial, { force: true })
        resumedRunStarted.resolve()
        return { ok: true }
      }
    )
    const blue = new FakeHub((hub, command) => {
      void backups.applyControl(command).then((result) => {
        hub.active = result.active
        hub.emit('message', result)
      })
    })
    const green = new FakeHub()
    let request = 0
    const protocol = new JournalBackupOwnershipProtocol({
      requestId: () => `hung-${++request}`,
      timeoutMs: 15,
    })

    try {
      await protocol.activateInitialBlueAfterHealth(blue.asChild())
      await firstStarted.promise

      await expect(protocol.pauseBlueBeforeDrain(blue.asChild())).rejects.toThrow(/timed out/i)
      expect(fs.readdirSync(root).filter((name) => name.endsWith('.db'))).toEqual([])
      await expect(protocol.activatePromotedGreen(green.asChild())).rejects.toThrow(/owner/i)

      // This is the restart rollback: blue receives a higher epoch immediately even though its old
      // pause handler is still waiting for SQLite. The old acknowledgement cannot defeat this resume.
      await protocol.resumeBlueAfterRollback(blue.asChild())
      expect(blue.active).toBe(true)

      releaseFirst.resolve({ ok: false, error: 'interrupted test generation' })
      await resumedRunStarted.promise
      expect(calls).toBe(2)
    } finally {
      releaseFirst.resolve({ ok: false, error: 'test cleanup' })
      await backups.stop()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

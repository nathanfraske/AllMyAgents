import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  NotificationService,
} from './notifications.js'

const opened: Database.Database[] = []
const roots: string[] = []

function service(): NotificationService {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-notifications-'))
  roots.push(root)
  const db = new Database(path.join(root, 'hub.db'))
  opened.push(db)
  return new NotificationService(db)
}

afterEach(() => {
  vi.useRealTimers()
  for (const db of opened.splice(0)) db.close()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('NotificationService', () => {
  it('defaults routine completions to managers and Overseers, not child agents', () => {
    const notifications = service()
    expect(notifications.getPreferences()).toEqual(DEFAULT_NOTIFICATION_PREFERENCES)
    expect(notifications.publish({
      kind: 'session-completed',
      sourceRole: 'agent',
      title: 'Child complete',
      body: 'Routine child completion.',
    })).toBeUndefined()
    expect(notifications.publish({
      kind: 'session-completed',
      sourceRole: 'manager',
      title: 'Manager complete',
      body: 'Manager finished.',
    })?.title).toBe('Manager complete')
    expect(notifications.publish({
      kind: 'session-completed',
      sourceRole: 'overseer',
      title: 'Overseer complete',
      body: 'Overseer finished.',
    })?.title).toBe('Overseer complete')
    expect(notifications.unreadCount()).toBe(2)
  })

  it('persists preferences and never retroactively turns old inbox rows into desktop alerts', () => {
    const notifications = service()
    const before = notifications.publish({
      kind: 'session-error',
      sourceRole: 'agent',
      title: 'Error',
      body: 'Needs attention.',
    })!
    expect(before.desktopEligible).toBe(false)
    notifications.setPreferences({ desktopEnabled: true, agentCompletions: true })
    const after = notifications.publish({
      kind: 'session-completed',
      sourceRole: 'agent',
      title: 'Complete',
      body: 'Now opted in.',
    })!
    expect(after.desktopEligible).toBe(true)

    const reopened = new NotificationService(opened[0]!)
    expect(reopened.getPreferences()).toMatchObject({ desktopEnabled: true, agentCompletions: true })
    expect(reopened.list().find((row) => row.id === before.id)?.desktopEligible).toBe(false)
  })

  it('deduplicates replayed lifecycle facts and supports read/delivery acknowledgement', () => {
    const notifications = service()
    notifications.setPreferences({ desktopEnabled: true })
    const first = notifications.publish({
      kind: 'approval-required',
      sourceRole: 'agent',
      title: 'Approval required',
      body: 'Command execution is waiting.',
      dedupeKey: 'approval:one',
    })!
    const replay = notifications.publish({
      kind: 'approval-required',
      sourceRole: 'agent',
      title: 'Approval required',
      body: 'Command execution is waiting.',
      dedupeKey: 'approval:one',
    })!
    expect(replay.id).toBe(first.id)
    expect(notifications.list()).toHaveLength(1)
    expect(notifications.markDesktopDelivered([first.id])).toBe(1)
    expect(notifications.markDesktopDelivered([first.id])).toBe(1)
    expect(notifications.markRead([first.id])).toBe(1)
    expect(notifications.unreadCount()).toBe(0)
    expect(notifications.list()[0]).toMatchObject({
      id: first.id,
      desktopEligible: true,
    })
    expect(notifications.list()[0]?.desktopDeliveredAt).toBeTruthy()
    expect(notifications.list()[0]?.readAt).toBeTruthy()
  })

  it('bounds title/body data copied from provider lifecycle payloads', () => {
    const notifications = service()
    const row = notifications.publish({
      kind: 'session-error',
      sourceRole: 'agent',
      title: 't'.repeat(1_000),
      body: 'b'.repeat(10_000),
    })!
    expect(row.title).toHaveLength(180)
    expect(row.body).toHaveLength(2_000)
  })
})

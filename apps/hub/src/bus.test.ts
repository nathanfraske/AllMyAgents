import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentBus } from './bus.js'
import type { SessionIdentity } from './identity.js'

const databases: Database.Database[] = []

afterEach(() => {
  while (databases.length) databases.pop()?.close()
})

function harness(): { db: Database.Database; bus: AgentBus; from: SessionIdentity } {
  const db = new Database(':memory:')
  databases.push(db)
  return {
    db,
    bus: new AgentBus(db),
    from: {
      sessionId: 'remote-overseer:peerhub',
      profileId: 'remote-hub:peerhub',
      provider: 'codex',
      label: 'Peer Hub Overseer',
    },
  }
}

describe('AgentBus external delivery receipts', () => {
  it('pages a scoped team view by stable cursor without consuming or reading mail', () => {
    const { bus, from } = harness()
    const first = bus.post({
      from,
      project: 'project',
      to: { kind: 'session', id: 'child-a' },
      body: 'first',
      recipients: ['child-a'],
    })[0]!
    const second = bus.post({
      from: { ...from, sessionId: 'child-b', label: 'Child B' },
      project: 'project',
      to: { kind: 'session', id: 'manager' },
      body: 'second',
      recipients: ['manager'],
    })[0]!
    bus.post({
      from,
      project: 'other-project',
      to: { kind: 'session', id: 'outsider' },
      body: 'outside scope',
      recipients: ['outsider'],
    })

    const page1 = bus.query({ visibleSessionIds: ['child-a', 'manager'], limit: 1 })
    expect(page1).toMatchObject({ hasMore: true, items: [{ message: { id: first.id, body: 'first' } }] })
    const page2 = bus.query({
      visibleSessionIds: ['child-a', 'manager'],
      fromSessionIds: ['child-b'],
      afterCursor: page1.nextCursor,
      unreadOnly: true,
      limit: 10,
    })
    expect(page2).toMatchObject({ hasMore: false, items: [{ message: { id: second.id, body: 'second' } }] })
    expect(bus.pending('child-a')).toHaveLength(1)
    expect(bus.pending('manager')).toHaveLength(1)
    expect(bus.get(first.id)?.readAt).toBeNull()
    expect(bus.get(second.id)?.readAt).toBeNull()
  })

  it('migrates legacy mail and durably records wake and hub-attention delivery intent', () => {
    const db = new Database(':memory:')
    databases.push(db)
    db.exec(`CREATE TABLE bus_messages (
      id TEXT PRIMARY KEY, groupId TEXT NOT NULL, ts TEXT NOT NULL,
      fromSession TEXT NOT NULL, fromProfile TEXT NOT NULL, fromLabel TEXT NOT NULL,
      project TEXT, toKind TEXT NOT NULL, toId TEXT NOT NULL, toSession TEXT NOT NULL,
      subject TEXT, body TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0, readAt TEXT)`)
    const bus = new AgentBus(db)
    const from: SessionIdentity = {
      sessionId: 'manager',
      profileId: 'profile',
      provider: 'claude',
      projectId: 'project',
      label: 'Manager',
    }

    bus.post({
      from,
      project: 'project',
      to: { kind: 'session', id: 'child' },
      body: 'hold this note',
      recipients: ['child'],
      wake: false,
    })
    bus.post({
      from,
      project: 'project',
      to: { kind: 'session', id: 'manager' },
      body: 'approval requires a decision',
      recipients: ['manager'],
      attentionRequired: true,
    })

    expect(bus.pending('child')).toMatchObject([{ wake: false, attentionRequired: false }])
    expect(bus.pending('manager')).toMatchObject([{ wake: true, attentionRequired: true }])
    expect(
      db.prepare("SELECT 1 FROM pragma_table_info('bus_messages') WHERE name = 'wake'").get(),
    ).toBeTruthy()
    expect(
      db.prepare("SELECT 1 FROM pragma_table_info('bus_messages') WHERE name = 'attentionRequired'").get(),
    ).toBeTruthy()
  })

  it('fans an authenticated cross-hub message out exactly once across retries', () => {
    const { bus, from } = harness()
    const input = {
      receiptKey: 'peerhub:message-1',
      from,
      project: null,
      to: { kind: 'session' as const, id: 'local-overseer' },
      subject: 'remote status',
      body: 'The remote build completed.',
      recipients: ['local-overseer'],
    }

    expect(bus.postExternal(input)).toMatchObject({ accepted: true, messages: [{ toSession: 'local-overseer' }] })
    expect(bus.postExternal(input)).toEqual({ accepted: false, messages: [] })
    expect(bus.pending('local-overseer')).toHaveLength(1)
  })

  it('retargets only pending mail and preserves direct-address semantics during a session handoff', () => {
    const { db, bus, from } = harness()
    const [direct] = bus.post({
      from,
      project: 'project',
      to: { kind: 'session', id: 'old-manager' },
      body: 'pending direct note',
      recipients: ['old-manager'],
    })
    const [broadcast] = bus.post({
      from,
      project: 'project',
      to: { kind: 'project', id: 'project' },
      body: 'pending project note',
      recipients: ['old-manager'],
      wake: false,
    })
    const [delivered] = bus.post({
      from,
      project: 'project',
      to: { kind: 'session', id: 'old-manager' },
      body: 'already delivered',
      recipients: ['old-manager'],
    })
    bus.markDelivered([delivered!.id])

    expect(bus.retargetPending('old-manager', 'new-manager')).toBe(2)
    expect(bus.pending('old-manager')).toEqual([])
    expect(bus.pending('new-manager')).toMatchObject([
      { id: direct!.id, toKind: 'session', toId: 'new-manager', wake: true },
      { id: broadcast!.id, toKind: 'project', toId: 'project', wake: false },
    ])
    expect(db.prepare('SELECT toSession, toId FROM bus_messages WHERE id = ?').get(delivered!.id)).toEqual({
      toSession: 'old-manager',
      toId: 'old-manager',
    })
  })

  it('rolls the receipt claim back when message insertion fails', () => {
    const { db, bus, from } = harness()
    db.exec(`CREATE TRIGGER reject_external_message BEFORE INSERT ON bus_messages
      WHEN NEW.body = 'reject-me' BEGIN SELECT RAISE(ABORT, 'fixture rejection'); END`)
    const base = {
      receiptKey: 'peerhub:message-2',
      from,
      project: null,
      to: { kind: 'session' as const, id: 'local-overseer' },
      recipients: ['local-overseer'],
    }
    expect(() => bus.postExternal({ ...base, body: 'reject-me' })).toThrow(/fixture rejection/u)
    db.exec('DROP TRIGGER reject_external_message')
    expect(bus.postExternal({ ...base, body: 'accepted-after-retry' }).accepted).toBe(true)
    expect(bus.pending('local-overseer')).toHaveLength(1)
  })
})

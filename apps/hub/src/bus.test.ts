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

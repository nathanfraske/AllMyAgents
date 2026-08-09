import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { TestbedReservationConflictError, TestbedReservationStore } from './testbedReservations.js'

describe('TestbedReservationStore', () => {
  it('exclusively leases one replica and releases it for the next agent', () => {
    const db = new Database(':memory:')
    const reservations = new TestbedReservationStore(db)
    const first = reservations.acquire({
      projectId: 'project-1', replicaId: 'replica-1', sessionId: 'session-a', agentId: 'agent-a',
    }).reservation

    expect(() => reservations.acquire({
      projectId: 'project-1', replicaId: 'replica-1', sessionId: 'session-b', agentId: 'agent-b',
    })).toThrow(TestbedReservationConflictError)
    expect(reservations.release(first.id)).toMatchObject({ state: 'released', reason: 'run-finished' })
    expect(reservations.acquire({
      projectId: 'project-1', replicaId: 'replica-1', sessionId: 'session-b', agentId: 'agent-b',
    }).reservation).toMatchObject({ state: 'active', agentId: 'agent-b' })
  })

  it('expires stale leases atomically and reconciles active leases after an owner restart', () => {
    const db = new Database(':memory:')
    const reservations = new TestbedReservationStore(db)
    const stale = reservations.acquire({
      projectId: 'project-1', replicaId: 'replica-1', sessionId: 'session-a', agentId: 'agent-a', ttlMs: 10_000,
    }).reservation
    db.prepare('UPDATE testbed_reservations SET expiresAt = ? WHERE id = ?').run(new Date(0).toISOString(), stale.id)

    const acquired = reservations.acquire({
      projectId: 'project-1', replicaId: 'replica-1', sessionId: 'session-b', agentId: 'agent-b',
    })
    expect(acquired.expired).toEqual([expect.objectContaining({ id: stale.id, state: 'expired' })])
    expect(reservations.reconcileInterrupted()).toEqual([
      expect.objectContaining({ id: acquired.reservation.id, state: 'interrupted', reason: 'source-restart' }),
    ])
    expect(reservations.reconcileInterrupted()).toEqual([])
  })
})

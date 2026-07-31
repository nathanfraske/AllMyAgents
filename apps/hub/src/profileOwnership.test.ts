import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProfileOwnership, ProfileOwnershipError } from './profileOwnership.js'

const roots: string[] = []
const tmp = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-profile-owner-'))
  roots.push(dir)
  return dir
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('profile single-writer ownership', () => {
  it('allows only one independent hub to claim a profile', () => {
    const dir = tmp()
    const a = new ProfileOwnership({ ownerId: 'hub-a', pid: process.pid, port: 7819 })
    const b = new ProfileOwnership({ ownerId: 'hub-b', pid: process.pid, port: 7820 })
    expect(a.claim('claude-a', dir).owned).toBe(true)
    expect(b.claim('claude-a', dir)).toMatchObject({
      owned: false,
      owner: { ownerId: 'hub-a', port: 7819 },
    })
  })

  // THE OPERATOR'S APP OUTRANKS A SANDBOX. An agent's throwaway hub claimed all four of the operator's
  // accounts and held them while idle; nothing could take them back short of killing the process. Ties are
  // now broken by role, not by who booted first.
  it('lets the operator app reclaim an account a live sandbox is sitting on', () => {
    const dir = tmp()
    const sandbox = new ProfileOwnership({ ownerId: 'sandbox', pid: process.pid, port: 7788, transient: true })
    const app = new ProfileOwnership({ ownerId: 'installed-app', pid: process.pid, port: 7777 })

    expect(sandbox.claim('claude-a', dir).owned).toBe(true)
    // process.pid is this very process, so the sandbox's claim is unambiguously LIVE — this is a
    // preemption, not stale-claim reclamation.
    const taken = app.claim('claude-a', dir)
    expect(taken.owned).toBe(true)
    expect(taken.reclaimed).toBe(true)
  })

  it('never lets a sandbox evict the operator app', () => {
    const dir = tmp()
    const app = new ProfileOwnership({ ownerId: 'installed-app', pid: process.pid, port: 7777 })
    const sandbox = new ProfileOwnership({ ownerId: 'sandbox', pid: process.pid, port: 7788, transient: true })

    expect(app.claim('claude-a', dir).owned).toBe(true)
    expect(sandbox.claim('claude-a', dir)).toMatchObject({
      owned: false,
      owner: { ownerId: 'installed-app', port: 7777 },
    })
    // And the refresh-capable path stays closed, so a sandbox cannot rotate a token out from under the app.
    expect(() => sandbox.assertOwned('claude-a', dir, 'replace credentials')).toThrow(ProfileOwnershipError)
  })

  it('does not let one sandbox evict another', () => {
    const dir = tmp()
    const first = new ProfileOwnership({ ownerId: 's1', pid: process.pid, port: 7801, transient: true })
    const second = new ProfileOwnership({ ownerId: 's2', pid: process.pid, port: 7802, transient: true })
    expect(first.claim('codex-a', dir).owned).toBe(true)
    expect(second.claim('codex-a', dir).owned).toBe(false)
  })

  it('reclaims a stale claim whose pid is dead', () => {
    const dir = tmp()
    fs.writeFileSync(
      path.join(dir, '.allmyagents-owner.json'),
      JSON.stringify({ ownerId: 'dead-hub', pid: 2147483647, port: 7788, startedAt: '2020-01-01T00:00:00.000Z' })
    )
    const owner = new ProfileOwnership({ ownerId: 'new-hub', pid: process.pid, port: 7819 })
    expect(owner.claim('claude-a', dir)).toMatchObject({ owned: true, reclaimed: true })
  })

  it('refuses a refresh-capable operation from a non-owner', () => {
    const dir = tmp()
    new ProfileOwnership({ ownerId: 'hub-a', pid: process.pid, port: 7819 }).claim('claude-a', dir)
    const other = new ProfileOwnership({ ownerId: 'hub-b', pid: process.pid, port: 7820 })
    expect(() => other.assertOwned('claude-a', dir, 'refresh credentials')).toThrow(ProfileOwnershipError)
    expect(() => other.assertOwned('claude-a', dir, 'refresh credentials')).toThrow(
      'Another AllMyAgents hub (port 7819) is using claude-a'
    )
  })

  it('lets blue and green generations share one logical supervisor owner', () => {
    const dir = tmp()
    new ProfileOwnership({ ownerId: 'supervisor-1', pid: process.pid, port: 7819 }).claim('claude-a', dir)
    expect(
      new ProfileOwnership({ ownerId: 'supervisor-1', pid: process.pid, port: 7819 }).claim('claude-a', dir).owned
    ).toBe(true)
  })

  it('lets only the active public hub generation hold a credential mutation lease', () => {
    const dir = tmp()
    const blue = new ProfileOwnership(
      { ownerId: 'supervisor-1', pid: process.pid, port: 7819 },
      { generationId: 'blue-generation', publicGenerationActive: true },
    )
    const green = new ProfileOwnership(
      { ownerId: 'supervisor-1', pid: process.pid, port: 7819 },
      { generationId: 'green-generation', publicGenerationActive: false },
    )

    expect(blue.claim('claude-a', dir).owned).toBe(true)
    expect(green.claim('claude-a', dir).owned).toBe(true)
    expect(() => green.acquireRefreshLease('claude-a', dir, 'replace credentials')).toThrow(
      /active public hub generation/i,
    )

    const blueLease = blue.acquireRefreshLease('claude-a', dir, 'replace credentials')
    expect(blueLease.isCurrent()).toBe(true)
    expect(() => green.acquireRefreshLease('claude-a', dir, 'replace credentials')).toThrow()
    blueLease.release()
    expect(blueLease.isCurrent()).toBe(false)

    blue.setPublicGenerationActive(false, 1)
    green.setPublicGenerationActive(true, 2)
    const greenLease = green.acquireRefreshLease('claude-a', dir, 'replace credentials')
    expect(greenLease).toMatchObject({ publicEpoch: 2 })
    expect(greenLease.isCurrent()).toBe(true)
    // A delayed release from the old generation is idempotent and cannot release green's lease.
    blueLease.release()
    expect(() => blue.acquireRefreshLease('claude-a', dir, 'replace credentials')).toThrow()
    greenLease.release()
  })

  it('keeps the supervisor claim authoritative when blue retires after green observes it', () => {
    const dir = tmp()
    const blue = new ProfileOwnership(
      { ownerId: 'supervisor-1', pid: 4301, port: 7819 },
      { generationId: 'blue-generation', publicGenerationActive: true, isProcessLive: () => true },
    )
    const green = new ProfileOwnership(
      { ownerId: 'supervisor-1', pid: 4301, port: 7819 },
      { generationId: 'green-generation', publicGenerationActive: false, isProcessLive: () => true },
    )
    const foreign = new ProfileOwnership(
      { ownerId: 'foreign-supervisor', pid: 4302, port: 7820 },
      { generationId: 'foreign-generation', isProcessLive: () => true },
    )

    const blueClaim = blue.claim('claude-a', dir)
    const greenClaim = green.claim('claude-a', dir)
    expect(greenClaim).toMatchObject({
      owned: true,
      owner: { ownerId: 'supervisor-1', epoch: blueClaim.owner.epoch },
    })

    blue.releaseAll()

    expect(foreign.claim('claude-a', dir)).toMatchObject({
      owned: false,
      owner: { ownerId: 'supervisor-1', epoch: blueClaim.owner.epoch },
    })
    expect(green.claim('claude-a', dir)).toMatchObject({
      owned: true,
      owner: { ownerId: 'supervisor-1', epoch: blueClaim.owner.epoch },
    })
  })

  it('invalidates an in-flight lease whenever its public generation is frozen or superseded', () => {
    const dir = tmp()
    const blue = new ProfileOwnership(
      { ownerId: 'supervisor-1', pid: process.pid, port: 7819 },
      { generationId: 'blue-generation', publicGenerationActive: true, publicEpoch: 7 },
    )
    blue.claim('claude-a', dir)
    const lease = blue.acquireRefreshLease('claude-a', dir, 'replace credentials')
    expect(lease.isCurrent()).toBe(true)

    blue.setPublicGenerationActive(false, 7)
    expect(lease.isCurrent()).toBe(false)
    blue.setPublicGenerationActive(true, 8)
    expect(lease.isCurrent()).toBe(false)
    lease.release()
  })

  it('does not let a stale generation release a successor claim with a different epoch', () => {
    const dir = tmp()
    let oldLive = true
    const old = new ProfileOwnership(
      { ownerId: 'old-supervisor', pid: 4101, port: 7819 },
      { isProcessLive: () => oldLive, generationId: 'old-generation' },
    )
    expect(old.claim('claude-a', dir).owned).toBe(true)

    oldLive = false
    const successor = new ProfileOwnership(
      { ownerId: 'new-supervisor', pid: 4102, port: 7820 },
      { isProcessLive: (pid) => pid === 4102, generationId: 'new-generation' },
    )
    const reclaimed = successor.claim('claude-a', dir)
    expect(reclaimed).toMatchObject({ owned: true, reclaimed: true })
    expect(reclaimed.owner.epoch).toEqual(expect.any(String))

    old.releaseAll()
    expect(successor.claim('claude-a', dir)).toMatchObject({
      owned: true,
      owner: { ownerId: 'new-supervisor', epoch: reclaimed.owner.epoch },
    })
  })

  it('fails a refresh lease promptly while a live foreign owner remains authoritative', () => {
    const dir = tmp()
    const owner = new ProfileOwnership(
      { ownerId: 'live-owner', pid: 4201, port: 7819 },
      { isProcessLive: () => true, generationId: 'owner-generation' },
    )
    const contender = new ProfileOwnership(
      { ownerId: 'contender', pid: 4202, port: 7820 },
      { isProcessLive: () => true, generationId: 'contender-generation' },
    )
    expect(owner.claim('codex-a', dir).owned).toBe(true)
    expect(() => contender.acquireRefreshLease('codex-a', dir, 'replace credentials')).toThrow(
      ProfileOwnershipError,
    )
    expect(owner.claim('codex-a', dir).owned).toBe(true)
  })

  it.each([
    'after-takeover-intent',
    'after-predecessor-rename',
    'after-successor-claim',
  ] as const)(
    'preserves the root dead-predecessor proof across a crash at %s',
    (edge) => {
      const dir = tmp()
      let oldLive = true
      const predecessor = new ProfileOwnership(
        { ownerId: 'old-supervisor', pid: 6101, port: 7819 },
        { isProcessLive: (pid) => pid === 6101 && oldLive },
      )
      const original = predecessor.claim('claude-a', dir)
      oldLive = false

      const crashed = new ProfileOwnership(
        { ownerId: 'crashed-successor', pid: 6102, port: 7820 },
        {
          isProcessLive: (pid) => pid === 6102,
          failpoint: (actual) => {
            if (actual === edge) throw new Error(`simulated crash at ${edge}`)
          },
        },
      )
      expect(() => crashed.claim('claude-a', dir)).toThrow(/simulated crash/)

      const final = new ProfileOwnership(
        { ownerId: 'final-supervisor', pid: 6103, port: 7821 },
        {
          generationId: 'final-generation',
          publicEpoch: 1,
          isProcessLive: (pid) => pid === 6103,
        },
      )
      const recovered = final.claim('claude-a', dir)
      expect(recovered).toMatchObject({
        owned: true,
        reclaimed: true,
        takeover: {
          predecessorOwnerId: 'old-supervisor',
          predecessorOwnerEpoch: original.owner.epoch,
          predecessorPid: 6101,
          successorOwnerId: 'final-supervisor',
          successorOwnerEpoch: recovered.owner.epoch,
          successorPid: 6103,
          reason: 'dead-predecessor',
        },
      })
      const lease = final.acquireRefreshLease('claude-a', dir, 'reconcile interrupted sign-in')
      expect(lease.takeover).toMatchObject({
        predecessorOwnerId: 'old-supervisor',
        predecessorOwnerEpoch: original.owner.epoch,
        successorOwnerId: 'final-supervisor',
      })
      lease.release()
    },
  )
})

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Journal } from './journal.js'
import { ProfileOwnership } from './profileOwnership.js'
import {
  PROFILE_LOGIN_RESTART_SETTLEMENT_TIMEOUT_MS,
  ProfileRuntime,
} from './profileRuntime.js'
import type { HubConfig, Profile } from './types.js'
import { UsageMonitor } from './usage.js'

const roots: string[] = []
const journals: Journal[] = []

afterEach(() => {
  for (const journal of journals.splice(0)) journal.db.close()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function root(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-profile-runtime-'))
  roots.push(value)
  return value
}

function profile(dir: string, id = 'codex-a'): Profile {
  return { id, provider: 'codex', dir }
}

function usageStub() {
  return {
    addProfile: vi.fn(),
    setProfileAuthority: vi.fn(),
  }
}

function currentLease(publicEpoch = 1) {
  return {
    ownerId: 'supervisor-1',
    ownerEpoch: 'owner-epoch',
    publicEpoch,
    generationId: 'blue-generation',
    leaseId: 'lease-1',
    isCurrent: () => true,
    release: vi.fn(),
  }
}

function runtimeOptions(input: {
  profilesDir: string
  profiles: Profile[]
  ownership: ProfileOwnership
  generationId: string
  publicEpoch: number
  active: boolean
  usage?: ReturnType<typeof usageStub> | UsageMonitor
  scan?: () => Profile[]
  refreshAuth?: (profile: Profile) => void
  applyConnectorPolicy?: () => void
  discoverInterrupted?: () => { profiles: Profile[]; notices: [] }
  reconcileInterrupted?: () => never[]
  setLoginAdmission?: (open: boolean) => void
  settleLoginsForRestart?: (timeoutMs: number) => Promise<{ settled: number; outcomeUnknown: number }>
}) {
  const profileMap = new Map(input.profiles.map((item) => [item.id, item]))
  const usage = input.usage ?? usageStub()
  return {
    runtime: new ProfileRuntime({
      profilesDir: input.profilesDir,
      profiles: input.profiles,
      profileMap,
      profileOwnership: input.ownership,
      usage,
      generation: {
        generationId: input.generationId,
        publicEpoch: input.publicEpoch,
        active: input.active,
      },
      scanProfiles: input.scan ?? (() => []),
      refreshAuth:
        input.refreshAuth ??
        ((item) => {
          item.authStatus = 'signed_in'
          delete item.authError
        }),
      onAdded: (item) => usage.addProfile(item),
      applyConnectorPolicy: input.applyConnectorPolicy ?? (() => {}),
      discoverInterrupted:
        input.discoverInterrupted ?? (() => ({ profiles: [], notices: [] })),
      reconcileInterrupted: input.reconcileInterrupted ?? (() => []),
      setLoginAdmission: input.setLoginAdmission ?? (() => {}),
      settleLoginsForRestart:
        input.settleLoginsForRestart ??
        (async () => ({ settled: 0, outcomeUnknown: 0 })),
    }),
    profileMap,
    usage,
  }
}

describe('profile public-generation runtime', () => {
  it('keeps green read-only until a strictly newer promotion and returns authority at a later rollback epoch', () => {
    const profilesDir = root()
    const profileDir = path.join(profilesDir, 'codex-a')
    fs.mkdirSync(profileDir)
    fs.writeFileSync(path.join(profileDir, 'auth.json'), '{"tokens":{"access_token":"a.b.c"}}')
    const scanned = () => [profile(profileDir)]
    const owner = { ownerId: 'supervisor-1', pid: process.pid, port: 7819 }
    const blueOwnership = new ProfileOwnership(owner, {
      generationId: 'blue-generation',
      publicGenerationActive: true,
      publicEpoch: 1,
    })
    const greenOwnership = new ProfileOwnership(owner, {
      generationId: 'green-generation',
      publicGenerationActive: false,
      publicEpoch: 1,
    })
    const blueConnectorWrites = vi.fn()
    const greenConnectorWrites = vi.fn()
    const greenRefresh = vi.fn()
    const greenReconcile = vi.fn((): never[] => [])
    const blue = runtimeOptions({
      profilesDir,
      profiles: [],
      ownership: blueOwnership,
      generationId: 'blue-generation',
      publicEpoch: 1,
      active: true,
      scan: scanned,
      applyConnectorPolicy: blueConnectorWrites,
    }).runtime
    const greenState = runtimeOptions({
      profilesDir,
      profiles: [],
      ownership: greenOwnership,
      generationId: 'green-generation',
      publicEpoch: 1,
      active: false,
      scan: scanned,
      refreshAuth: greenRefresh,
      reconcileInterrupted: greenReconcile,
      applyConnectorPolicy: greenConnectorWrites,
    })
    const green = greenState.runtime
    const greenClaim = vi.spyOn(greenOwnership, 'claim')
    const greenLeaseSpy = vi.spyOn(greenOwnership, 'acquireRefreshLease')

    blue.bootstrap()
    green.bootstrap()

    expect(blueConnectorWrites).toHaveBeenCalledOnce()
    expect(greenConnectorWrites).not.toHaveBeenCalled()
    expect(greenClaim).not.toHaveBeenCalled()
    expect(greenLeaseSpy).not.toHaveBeenCalled()
    expect(greenRefresh).not.toHaveBeenCalled()
    expect(greenReconcile).not.toHaveBeenCalled()
    expect(greenState.usage.addProfile).not.toHaveBeenCalled()
    expect(greenState.usage.setProfileAuthority).not.toHaveBeenCalled()
    expect(() =>
      greenOwnership.acquireRefreshLease('codex-a', profileDir, 'booting green write'),
    ).toThrow(/active public hub generation/i)

    blue.deactivatePublicGeneration()
    green.activatePublicGeneration(2)
    expect(greenConnectorWrites).toHaveBeenCalledOnce()
    const greenLease = greenOwnership.acquireRefreshLease(
      'codex-a',
      profileDir,
      'promoted green write',
    )
    expect(greenLease.publicEpoch).toBe(2)
    greenLease.release()
    expect(() => green.activatePublicGeneration(2)).toThrow(/strictly newer/i)

    green.deactivatePublicGeneration()
    blue.activatePublicGeneration(3)
    const blueLease = blueOwnership.acquireRefreshLease(
      'codex-a',
      profileDir,
      'rolled-back blue write',
    )
    expect(blueLease.publicEpoch).toBe(3)
    blueLease.release()
    expect(() =>
      greenOwnership.acquireRefreshLease('codex-a', profileDir, 'stale green write'),
    ).toThrow(/active public hub generation/i)
  })

  it('discovers and reconciles only while active and isolates one failed profile claim', () => {
    const profilesDir = root()
    const first = profile(path.join(profilesDir, 'codex-a'), 'codex-a')
    first.available = false
    first.ownerPort = 7999
    first.unavailableReason = 'stale owner'
    const second = profile(path.join(profilesDir, 'codex-b'), 'codex-b')
    const recovered = profile(path.join(profilesDir, 'codex-c'), 'codex-c')
    const profiles = [first]
    const reconcileInterrupted = vi.fn((): never[] => [])
    const connectorWrites = vi.fn()
    const ownership = {
      claim: vi.fn((profileId: string) => {
        if (profileId === first.id) throw new Error('EACCES')
        return {
          owned: true,
          owner: {
            ownerId: 'supervisor-1',
            pid: process.pid,
            port: 7819,
            startedAt: '2026-07-30T00:00:00.000Z',
            epoch: 'owner-epoch',
          },
        }
      }),
      acquireRefreshLease: vi.fn(() => currentLease()),
      setPublicGenerationActive: vi.fn(),
    } as unknown as ProfileOwnership
    const { runtime, profileMap } = runtimeOptions({
      profilesDir,
      profiles,
      ownership,
      generationId: 'blue-generation',
      publicEpoch: 1,
      active: true,
      scan: () => [first, second],
      discoverInterrupted: () => ({ profiles: [recovered], notices: [] }),
      reconcileInterrupted,
      applyConnectorPolicy: connectorWrites,
    })

    runtime.bootstrap()

    expect(first).toMatchObject({
      available: false,
      ownerPort: 7999,
      unavailableReason: expect.stringMatching(/could not be verified safely/i),
    })
    expect(profileMap.get(second.id)).toMatchObject({ available: true, authStatus: 'signed_in' })
    expect(profileMap.get(recovered.id)).toMatchObject({
      available: true,
      authStatus: 'signed_in',
    })
    expect(reconcileInterrupted).toHaveBeenCalledOnce()
    expect(connectorWrites).toHaveBeenCalledTimes(2)

    runtime.deactivatePublicGeneration()
    runtime.rescan()

    expect(reconcileInterrupted).toHaveBeenCalledOnce()
    expect(connectorWrites).toHaveBeenCalledTimes(2)
  })

  it('discards a delayed usage poll after an epoch flip driven by the runtime', async () => {
    const profilesDir = root()
    const profileDir = path.join(profilesDir, 'codex-a')
    const scanned = profile(profileDir)
    const profiles: Profile[] = []
    const journal = new Journal(path.join(profilesDir, 'hub.db'))
    journals.push(journal)
    const usage = new UsageMonitor(journal, profiles, {} as HubConfig)
    const ownership = {
      claim: () => ({
        owned: true,
        owner: {
          ownerId: 'supervisor-1',
          pid: process.pid,
          port: 7819,
          startedAt: '2026-07-30T00:00:00.000Z',
          epoch: 'owner-epoch',
        },
      }),
      acquireRefreshLease: vi.fn(() => currentLease()),
      setPublicGenerationActive: vi.fn(),
    } as unknown as ProfileOwnership
    const { runtime } = runtimeOptions({
      profilesDir,
      profiles,
      ownership,
      generationId: 'blue-generation',
      publicEpoch: 1,
      active: true,
      usage,
      scan: () => [scanned],
    })
    let resolveRead!: (value: unknown) => void
    usage.setCodexReader(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve
        }),
    )
    runtime.bootstrap()

    const polling = usage.pollCodexOnce()
    runtime.deactivatePublicGeneration()
    runtime.activatePublicGeneration(2)
    resolveRead({
      rateLimits: {
        primary: { rateLimitReachedType: 'requests' },
      },
    })
    await polling

    expect(usage.list()[0]?.codex).toBeUndefined()
    expect(journal.since(0).filter((event) => event.kind === 'usage/snapshot')).toEqual([])
  })

  it('closes login admission before using the bounded restart settlement deadline', async () => {
    const profilesDir = root()
    const setAdmission = vi.fn()
    const settle = vi.fn(async () => ({ settled: 2, outcomeUnknown: 1 }))
    const ownership = {
      claim: vi.fn(),
      acquireRefreshLease: vi.fn(),
      setPublicGenerationActive: vi.fn(),
    } as unknown as ProfileOwnership
    const { runtime } = runtimeOptions({
      profilesDir,
      profiles: [],
      ownership,
      generationId: 'blue-generation',
      publicEpoch: 1,
      active: true,
      setLoginAdmission: setAdmission,
      settleLoginsForRestart: settle,
    })

    await expect(runtime.prepareRestart()).resolves.toEqual({
      settled: 2,
      outcomeUnknown: 1,
    })
    expect(setAdmission).toHaveBeenCalledWith(false)
    expect(settle).toHaveBeenCalledWith(PROFILE_LOGIN_RESTART_SETTLEMENT_TIMEOUT_MS)
  })
})

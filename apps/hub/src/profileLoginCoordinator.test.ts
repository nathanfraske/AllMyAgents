import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ProfileLoginCoordinator,
  ProfileLoginRegistry,
} from './profileLoginCoordinator.js'
import {
  startLogin as launchLogin,
  type LoginAttempt,
  type StartLoginOptions,
} from './loginLauncher.js'
import type { ProfileRefreshLease } from './profileOwnership.js'
import type {
  ProfileTurnFreezeReceipt,
  ProfileTurnSettlementResult,
} from './sessions.js'
import type { Provider } from './types.js'

const roots: string[] = []
const coordinators: ProfileLoginCoordinator[] = []

afterEach(() => {
  for (const coordinator of coordinators.splice(0)) coordinator.dispose()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function lease(): ProfileRefreshLease {
  return {
    ownerId: 'owner',
    ownerEpoch: 'owner-epoch',
    publicEpoch: 7,
    generationId: 'blue',
    leaseId: 'lease',
    isCurrent: () => true,
    release: vi.fn(),
  }
}

function fixture(options: {
  settle?: () => Promise<ProfileTurnSettlementResult>
  startLogin?: (
    provider: Provider,
    profileDir: string,
    options?: StartLoginOptions,
  ) => Promise<LoginAttempt>
  getLogin?: (id: string) => LoginAttempt | undefined
  getLoginForProfile?: (profileDir: string) => LoginAttempt | undefined
  cancelLogin?: (id: string) => LoginAttempt | undefined
} = {}): {
  root: string
  profileDir: string
  credential: string
  registry: ProfileLoginRegistry
  coordinator: ProfileLoginCoordinator
  freeze: ReturnType<typeof vi.fn>
  settle: ReturnType<typeof vi.fn>
  thaw: ReturnType<typeof vi.fn>
  startLogin: ReturnType<typeof vi.fn>
  rescan: ReturnType<typeof vi.fn>
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-profile-login-coordinator-'))
  roots.push(root)
  const profileDir = path.join(root, 'profiles', 'claude-a')
  fs.mkdirSync(profileDir, { recursive: true })
  const credential = path.join(profileDir, '.credentials.json')
  fs.writeFileSync(credential, '{"oauth":"prior"}')
  const receipt: ProfileTurnFreezeReceipt = {
    profileId: 'claude-a',
    publicEpoch: 7,
    generationId: 'blue',
    freezeId: 'freeze-1',
  }
  const freeze = vi.fn(() => receipt)
  const settle = vi.fn(
    options.settle ??
      (async () => ({
        settled: true,
        outcomeUnknownSessionIds: [],
        outcomeUnknownOperationIds: [],
      })),
  )
  const thaw = vi.fn(() => true)
  const rescan = vi.fn(() => [])
  const startLogin = vi.fn(
    options.startLogin ??
      (async () => ({
        id: 'launcher-1',
        provider: 'claude' as const,
        status: 'capturing' as const,
      })),
  )
  const registry = new ProfileLoginRegistry(path.join(root, 'profile-logins.json'))
  const coordinator = new ProfileLoginCoordinator({
    profilesDir: path.join(root, 'profiles'),
    registry,
    profileRuntime: {
      currentGeneration: () => ({
        generationId: 'blue',
        publicEpoch: 7,
        active: true,
      }),
      rescan,
    },
    profileOwnership: {
      acquireRefreshLease: () => lease(),
    },
    sessions: {
      freezeProfileTurnAdmission: freeze,
      settleProfileTurns: settle,
      thawProfileTurnAdmission: thaw,
    },
    startLogin,
    getLogin: options.getLogin ?? (() => undefined),
    getLoginForProfile: options.getLoginForProfile ?? (() => undefined),
    cancelLogin: options.cancelLogin ?? (() => undefined),
    settlementTimeoutMs: 20,
    observeIntervalMs: 5,
  })
  coordinators.push(coordinator)
  return {
    root,
    profileDir,
    credential,
    registry,
    coordinator,
    freeze,
    settle,
    thaw,
    startLogin,
    rescan,
  }
}

describe('ProfileLoginCoordinator production boundary', () => {
  it.each(['delayed runTurn start', 'delayed startThread ACK', 'delayed steer ACK'])(
    'keeps the live credential untouched through %s until exact profile settlement',
    async () => {
      const gate = deferred<ProfileTurnSettlementResult>()
      const f = fixture({ settle: () => gate.promise })

      const starting = f.coordinator.start({
        provider: 'claude',
        profileId: 'claude-a',
        reauth: true,
        idempotencyKey: 'request-1',
      })
      await Promise.resolve()

      expect(f.freeze).toHaveBeenCalledOnce()
      expect(f.startLogin).not.toHaveBeenCalled()
      expect(fs.readFileSync(f.credential, 'utf8')).toBe('{"oauth":"prior"}')
      expect(f.registry.getForProfile('claude-a', 'request-1')).toMatchObject({
        status: 'settling',
      })

      gate.resolve({
        settled: true,
        outcomeUnknownSessionIds: [],
        outcomeUnknownOperationIds: [],
      })
      const result = await starting

      expect(result).toMatchObject({
        ok: true,
        status: 'capturing',
        profileId: 'claude-a',
      })
      expect(result.loginId).not.toBe('launcher-1')
      expect(f.startLogin).toHaveBeenCalledWith(
        'claude',
        f.profileDir,
        expect.objectContaining({
          reauth: true,
          profileId: 'claude-a',
          idempotencyKey: 'request-1',
        }),
      )
    },
  )

  it('keeps duplicate lookup and cancellation settling while the owned pre-launch boundary is unresolved', async () => {
    const gate = deferred<ProfileTurnSettlementResult>()
    const f = fixture({ settle: () => gate.promise })
    const starting = f.coordinator.start({
      provider: 'claude',
      profileId: 'claude-a',
      reauth: true,
      idempotencyKey: 'pre-launch-duplicate',
    })
    await Promise.resolve()

    const pending = f.coordinator.getForProfile(
      'claude-a',
      'pre-launch-duplicate',
    )
    expect(pending).toMatchObject({
      ok: true,
      status: 'settling',
    })
    expect(f.thaw).not.toHaveBeenCalled()
    expect(f.startLogin).not.toHaveBeenCalled()

    await expect(
      f.coordinator.start({
        provider: 'claude',
        profileId: 'claude-a',
        reauth: true,
        idempotencyKey: 'pre-launch-duplicate',
      }),
    ).resolves.toMatchObject({
      loginId: pending!.loginId,
      ok: true,
      status: 'settling',
    })
    expect(f.thaw).not.toHaveBeenCalled()
    expect(f.startLogin).not.toHaveBeenCalled()

    expect(f.coordinator.cancel(pending!.loginId)).toMatchObject({
      ok: true,
      status: 'settling',
    })
    expect(f.thaw).not.toHaveBeenCalled()
    expect(f.startLogin).not.toHaveBeenCalled()

    gate.resolve({
      settled: true,
      outcomeUnknownSessionIds: [],
      outcomeUnknownOperationIds: [],
    })
    await expect(starting).resolves.toMatchObject({
      ok: false,
      status: 'cancelled',
    })
    expect(f.startLogin).not.toHaveBeenCalled()
    expect(f.thaw).toHaveBeenCalledOnce()
  })

  it('fails a bounded settlement without launching, archiving, or leaving the exact receipt frozen', async () => {
    const f = fixture({
      settle: async () => ({
        settled: false,
        outcomeUnknownSessionIds: ['s1'],
        outcomeUnknownOperationIds: ['op1'],
      }),
    })

    const result = await f.coordinator.start({
      provider: 'claude',
      profileId: 'claude-a',
      reauth: true,
      idempotencyKey: 'request-timeout',
    })

    expect(result).toMatchObject({
      ok: false,
      status: 'failed',
      error: expect.stringMatching(/could not settle safely/i),
    })
    expect(f.startLogin).not.toHaveBeenCalled()
    expect(fs.readFileSync(f.credential, 'utf8')).toBe('{"oauth":"prior"}')
    expect(f.thaw).toHaveBeenCalledOnce()
    expect(f.thaw).toHaveBeenCalledWith(
      expect.objectContaining({ freezeId: 'freeze-1' }),
    )
  })

  it('keeps an inactive green observation-only with no registry, freeze, lease, or launcher write', async () => {
    const f = fixture()
    const inactive = new ProfileLoginCoordinator({
      profilesDir: path.join(f.root, 'profiles'),
      registry: new ProfileLoginRegistry(path.join(f.root, 'green-logins.json')),
      profileRuntime: {
        currentGeneration: () => ({
          generationId: 'green',
          publicEpoch: 8,
          active: false,
        }),
        rescan: vi.fn(() => []),
      },
      profileOwnership: {
        acquireRefreshLease: vi.fn(() => lease()),
      },
      sessions: {
        freezeProfileTurnAdmission: f.freeze,
        settleProfileTurns: f.settle,
        thawProfileTurnAdmission: f.thaw,
      },
      startLogin: f.startLogin,
      observeIntervalMs: 5,
    })
    coordinators.push(inactive)

    await expect(
      inactive.start({
        provider: 'claude',
        profileId: 'claude-a',
        reauth: true,
        idempotencyKey: 'inactive-green',
      }),
    ).resolves.toMatchObject({
      ok: false,
      status: 'failed',
      error: expect.stringMatching(/active public hub generation/i),
    })
    inactive.recoverAfterProfileBootstrap()

    expect(fs.existsSync(path.join(f.root, 'green-logins.json'))).toBe(false)
    expect(f.freeze).not.toHaveBeenCalled()
    expect(f.startLogin).not.toHaveBeenCalled()
  })

  it('publishes the stable public record before launcher admission and returns capturing without a URL', async () => {
    const f = fixture()
    f.startLogin.mockImplementation(async () => {
      expect(f.registry.getForProfile('claude-a', 'bounded-post')).toMatchObject({
        status: 'settling',
      })
      return { id: 'launcher-never-url', provider: 'claude', status: 'capturing' }
    })

    const result = await f.coordinator.start({
      provider: 'claude',
      profileId: 'claude-a',
      reauth: true,
      idempotencyKey: 'bounded-post',
    })

    expect(result).toMatchObject({
      ok: true,
      status: 'capturing',
    })
    expect(result.url).toBeUndefined()
  })

  it('recovers the same profile+key record after restart without recreating a freeze or launcher', async () => {
    const attempts = new Map<string, LoginAttempt>()
    const f = fixture({
      startLogin: async () => {
        const attempt: LoginAttempt = {
          id: 'launcher-restart',
          provider: 'claude',
          status: 'capturing',
        }
        attempts.set(attempt.id, attempt)
        return attempt
      },
      getLogin: (id) => attempts.get(id),
      getLoginForProfile: () => attempts.get('launcher-restart'),
    })
    const first = await f.coordinator.start({
      provider: 'claude',
      profileId: 'claude-a',
      reauth: true,
      idempotencyKey: 'lost-response',
    })
    f.coordinator.dispose()

    const freeze = vi.fn()
    const secondStart = vi.fn()
    const successor = new ProfileLoginCoordinator({
      profilesDir: path.join(f.root, 'profiles'),
      registry: new ProfileLoginRegistry(path.join(f.root, 'profile-logins.json')),
      profileRuntime: {
        currentGeneration: () => ({
          generationId: 'successor',
          publicEpoch: 8,
          active: true,
        }),
        rescan: vi.fn(() => []),
      },
      profileOwnership: { acquireRefreshLease: () => lease() },
      sessions: {
        freezeProfileTurnAdmission: freeze,
        settleProfileTurns: vi.fn(),
        thawProfileTurnAdmission: vi.fn(),
      },
      startLogin: secondStart,
      getLogin: (id) => attempts.get(id),
      getLoginForProfile: () => attempts.get('launcher-restart'),
      cancelLogin: () => undefined,
      observeIntervalMs: 5,
    })
    coordinators.push(successor)
    successor.recoverAfterProfileBootstrap()

    expect(
      await successor.start({
        provider: 'claude',
        profileId: 'claude-a',
        reauth: true,
        idempotencyKey: 'lost-response',
      }),
    ).toMatchObject({
      loginId: first.loginId,
      status: 'capturing',
    })
    expect(successor.getForProfile('claude-a', 'lost-response')).toMatchObject({
      loginId: first.loginId,
    })
    expect(freeze).not.toHaveBeenCalled()
    expect(secondStart).not.toHaveBeenCalled()
  })

  it('restores the prior credential once on a spawn failure and thaws only after terminal truth', async () => {
    const f = fixture({
      startLogin: (provider, profileDir, options = {}) =>
        launchLogin(provider, profileDir, {
          ...options,
          spawnProcess: (() => {
            throw new Error('vendor binary missing')
          }) as never,
        }),
    })

    const result = await f.coordinator.start({
      provider: 'claude',
      profileId: 'claude-a',
      reauth: true,
      idempotencyKey: 'spawn-failure',
    })

    expect(result).toMatchObject({
      ok: false,
      status: 'failed',
      error: expect.stringMatching(/vendor binary missing/i),
    })
    expect(fs.readFileSync(f.credential, 'utf8')).toBe('{"oauth":"prior"}')
    expect(
      fs
        .readdirSync(f.profileDir)
        .filter((entry) => entry.includes('.credentials.json.signed-out-')),
    ).toEqual([])
    expect(f.thaw).toHaveBeenCalledOnce()
  })

  it('keeps cancel settling until launcher restoration is terminal, then rescans and thaws once', async () => {
    const attempts = new Map<string, LoginAttempt>()
    const f = fixture({
      startLogin: async () => {
        const attempt: LoginAttempt = {
          id: 'launcher-cancel',
          provider: 'claude',
          status: 'capturing',
        }
        attempts.set(attempt.id, attempt)
        return attempt
      },
      getLogin: (id) => attempts.get(id),
      getLoginForProfile: () => attempts.get('launcher-cancel'),
      cancelLogin: (id) => {
        const attempt = attempts.get(id)
        if (!attempt) return undefined
        const settling: LoginAttempt = { ...attempt, status: 'settling' }
        attempts.set(id, settling)
        return settling
      },
    })
    const started = await f.coordinator.start({
      provider: 'claude',
      profileId: 'claude-a',
      reauth: true,
      idempotencyKey: 'cancel-once',
    })

    expect(f.coordinator.cancel(started.loginId)).toMatchObject({
      ok: true,
      status: 'settling',
    })
    expect(f.thaw).not.toHaveBeenCalled()

    attempts.set('launcher-cancel', {
      id: 'launcher-cancel',
      provider: 'claude',
      status: 'cancelled',
      error: 'Claude sign-in was cancelled.',
    })
    expect(f.coordinator.get(started.loginId)).toMatchObject({
      status: 'cancelled',
    })
    expect(f.rescan).toHaveBeenCalledOnce()
    expect(f.thaw).toHaveBeenCalledOnce()
    f.coordinator.get(started.loginId)
    expect(f.thaw).toHaveBeenCalledOnce()
  })
})

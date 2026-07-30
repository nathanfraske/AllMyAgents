import { EventEmitter } from 'node:events'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { ProfileOwnership, type ProfileRefreshLease } from './profileOwnership.js'
import {
  cancelLogin,
  discoverInterruptedLoginProfiles,
  getLogin,
  getLoginForProfile,
  loginCaptureError,
  parseLoginOutput,
  reconcileInterruptedLogins,
  setLoginAdmission,
  settleLoginsForRestart,
  startLogin,
} from './loginLauncher.js'

function failedChild(output: string): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams
  const stderr = new PassThrough()
  Object.assign(child, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr,
    killed: true,
    kill: () => true,
  })
  queueMicrotask(() => {
    stderr.write(output)
    child.emit('close', 1, null)
  })
  return child
}

function successfulClaudeChild(profileDir: string): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams
  const stdout = new PassThrough()
  Object.assign(child, {
    stdin: new PassThrough(),
    stdout,
    stderr: new PassThrough(),
    killed: false,
    kill: () => {
      queueMicrotask(() => child.emit('close', null, 'SIGTERM'))
      return true
    },
  })
  queueMicrotask(() => {
    stdout.write('https://claude.com/cai/oauth/authorize?client_id=throwaway&state=test\n')
    setTimeout(
      () =>
        fs.writeFileSync(
          path.join(profileDir, '.credentials.json'),
          JSON.stringify({
            claudeAiOauth: {
              accessToken: 'fresh',
              expiresAt: Date.now() + 60_000,
            },
          }),
        ),
      15,
    )
  })
  return child
}

function waitingClaudeChild(): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams
  const stdout = new PassThrough()
  Object.assign(child, {
    stdin: new PassThrough(),
    stdout,
    stderr: new PassThrough(),
    killed: false,
    kill: () => {
      queueMicrotask(() => child.emit('close', null, 'SIGTERM'))
      return true
    },
  })
  queueMicrotask(() => {
    stdout.write('https://claude.com/cai/oauth/authorize?client_id=throwaway&state=test\n')
  })
  return child
}

function refreshLease(
  release = vi.fn(),
  overrides: Partial<ProfileRefreshLease> = {},
): ProfileRefreshLease {
  return {
    ownerId: 'supervisor-1',
    ownerEpoch: 'owner-epoch',
    publicEpoch: 1,
    generationId: 'blue-generation',
    leaseId: 'refresh-lease',
    isCurrent: () => true,
    release,
    ...overrides,
  }
}

function durableState(input: {
  profileDir: string
  profileId?: string
  provider?: 'claude' | 'codex'
  attemptId?: string
  archivePath?: string
  priorSha256?: string
  ownerId?: string
  ownerEpoch?: string
  publicEpoch?: number
  generationId?: string
}): Record<string, unknown> {
  const provider = input.provider ?? 'claude'
  const attemptId = input.attemptId ?? '11111111-1111-4111-8111-111111111111'
  const credentialPath = path.join(
    input.profileDir,
    provider === 'claude' ? '.credentials.json' : 'auth.json',
  )
  return {
    format: 1,
    attemptId,
    provider,
    profileId: input.profileId ?? path.basename(input.profileDir),
    profileDir: path.resolve(input.profileDir),
    credentialPath,
    ...(input.archivePath ? { archivePath: input.archivePath } : {}),
    ...(input.priorSha256 ? { priorSha256: input.priorSha256 } : {}),
    ownerEpoch: input.ownerEpoch ?? 'owner-epoch',
    ownerId: input.ownerId ?? 'supervisor-1',
    publicEpoch: input.publicEpoch ?? 1,
    generationId: input.generationId ?? 'blue-generation',
    leaseId: 'refresh-lease',
    phase: input.archivePath ? 'archived' : 'prepared',
    createdAt: '2026-07-30T00:00:00.000Z',
    updatedAt: '2026-07-30T00:00:00.000Z',
  }
}

describe('vendor login URL capture', () => {
  it('captures Claude OAuth output with terminal formatting', () => {
    const output = [
      '\u001b[1mClaude Code login\u001b[0m',
      'If your browser did not open, use this URL:',
      'https://claude.com/cai/oauth/authorize?code=true&client_id=ama-test&state=abc',
      'Paste the code here if prompted.',
    ].join('\n')

    expect(parseLoginOutput('claude', output)).toEqual({
      url: 'https://claude.com/cai/oauth/authorize?code=true&client_id=ama-test&state=abc',
    })
  })

  it('captures Codex device auth URL and one-time code', () => {
    const output = [
      'Complete sign in using device authentication:',
      '1. Open this link in your browser and sign in',
      'https://auth.openai.com/codex/device',
      '2. Enter this one-time code (expires in 15 minutes)',
      'UOHN-CECVA',
    ].join('\n')

    expect(parseLoginOutput('codex', output)).toEqual({
      url: 'https://auth.openai.com/codex/device',
      code: 'UOHN-CECVA',
    })
  })

  it('prefers Codex OAuth over a local callback URL when normal login output is encountered', () => {
    const output = [
      'Starting local login server on http://localhost:1455.',
      'If your browser did not open, navigate to this URL to authenticate:',
      'https://auth.openai.com/oauth/authorize?client_id=ama-test&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback',
    ].join('\r\n')

    expect(parseLoginOutput('codex', output)).toEqual({
      url: 'https://auth.openai.com/oauth/authorize?client_id=ama-test&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback',
    })
  })

  it('surfaces captured vendor output when no login URL can be parsed', () => {
    const message = loginCaptureError('codex', '\u001b[31mLogin failed before emitting a link.\u001b[0m')

    expect(message).toContain('Codex did not provide a sign-in URL')
    expect(message).toContain('Login failed before emitting a link.')
  })

  it('does not mistake a vendor documentation link for a sign-in URL', () => {
    expect(parseLoginOutput('codex', 'Login failed. See https://openai.com/docs/codex for help.')).toBeNull()
  })

  it('fails the launched attempt instead of silently waiting when vendor output is unparseable', async () => {
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-login-test-'))
    try {
      const result = await startLogin('codex', profileDir, {
        spawnProcess: (() =>
          failedChild('Login failed before emitting a link.')) as unknown as typeof spawn,
        captureTimeoutMs: 100,
      })

      expect(result.status).toBe('capturing')
      await vi.waitFor(() => expect(getLogin(result.id)?.status).toBe('failed'))
      expect(getLogin(result.id)?.error).toContain('Codex did not provide a sign-in URL')
      expect(getLogin(result.id)?.error).toContain('Login failed before emitting a link.')
    } finally {
      fs.rmSync(profileDir, { recursive: true, force: true })
    }
  })

  it('re-authenticates a genuinely invalid credential instead of accepting the stale file', async () => {
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-login-invalid-'))
    try {
      const credential = path.join(profileDir, '.credentials.json')
      fs.writeFileSync(credential, '{"oauth":"deliberately-invalid"}')
      const release = vi.fn()

      const attempt = await startLogin('claude', profileDir, {
        reauth: true,
        acquireLease: () => refreshLease(release),
        spawnProcess: (() => successfulClaudeChild(profileDir)) as unknown as typeof spawn,
        loginTimeoutMs: 2_000,
      })
      expect(attempt.status).toBe('capturing')
      await new Promise((resolve) => setTimeout(resolve, 1_100))
      expect(getLogin(attempt.id)?.status).toBe('complete')
      expect(fs.readFileSync(credential, 'utf8')).toContain('fresh')
      expect(
        fs.readdirSync(profileDir).some((entry) => entry.includes('.credentials.json.signed-out-')),
      ).toBe(true)
      expect(release).toHaveBeenCalledOnce()
    } finally {
      fs.rmSync(profileDir, { recursive: true, force: true })
    }
  })

  it('restores the exact prior credential when the login process cannot spawn', async () => {
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-login-spawn-'))
    try {
      const credential = path.join(profileDir, '.credentials.json')
      fs.writeFileSync(credential, '{"oauth":"prior"}')
      const release = vi.fn()

      const attempt = await startLogin('claude', profileDir, {
        reauth: true,
        acquireLease: () => refreshLease(release),
        spawnProcess: (() => {
          throw new Error('vendor binary missing')
        }) as unknown as typeof spawn,
      })

      expect(attempt).toMatchObject({
        status: 'failed',
        error: expect.stringMatching(/vendor binary missing/i),
      })
      expect(fs.readFileSync(credential, 'utf8')).toBe('{"oauth":"prior"}')
      expect(release).toHaveBeenCalledOnce()
    } finally {
      fs.rmSync(profileDir, { recursive: true, force: true })
    }
  })

  it.each([
    ['capture failure', 'failed'] as const,
    ['cancellation', 'cancelled'] as const,
    ['timeout', 'timed-out'] as const,
  ])('restores the prior credential after %s', async (edge, expectedStatus) => {
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), `ama-login-${expectedStatus}-`))
    try {
      const credential = path.join(profileDir, '.credentials.json')
      fs.writeFileSync(credential, `{"oauth":"prior-${expectedStatus}"}`)
      const release = vi.fn()
      const attempt = await startLogin('claude', profileDir, {
        reauth: true,
        acquireLease: () => refreshLease(release),
        spawnProcess: (() =>
          edge === 'capture failure'
            ? failedChild('no auth URL')
            : waitingClaudeChild()) as unknown as typeof spawn,
        captureTimeoutMs: 20,
        loginTimeoutMs: 20,
      })

      if (edge === 'cancellation') cancelLogin(attempt.id)
      await vi.waitFor(() => expect(getLogin(attempt.id)?.status).toBe(expectedStatus), {
        timeout: 1_000,
        interval: 5,
      })
      expect(getLogin(attempt.id)?.status ?? attempt.status).toBe(expectedStatus)
      expect(fs.readFileSync(credential, 'utf8')).toBe(`{"oauth":"prior-${expectedStatus}"}`)
      expect(release).toHaveBeenCalledOnce()
    } finally {
      fs.rmSync(profileDir, { recursive: true, force: true })
    }
  })

  it('never overwrites a credential that appears before rollback and retains the prior archive', async () => {
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-login-conflict-'))
    try {
      const credential = path.join(profileDir, '.credentials.json')
      fs.writeFileSync(credential, '{"oauth":"prior"}')
      const attempt = await startLogin('claude', profileDir, {
        reauth: true,
        acquireLease: () => refreshLease(),
        spawnProcess: (() => waitingClaudeChild()) as unknown as typeof spawn,
      })
      fs.writeFileSync(credential, '{"oauth":"external-change"}')

      cancelLogin(attempt.id)

      await vi.waitFor(() => {
        expect(getLogin(attempt.id)?.status).toBe('cancelled')
        expect(fs.readFileSync(credential, 'utf8')).toBe('{"oauth":"external-change"}')
      })
      expect(
        fs.readdirSync(profileDir).filter((entry) => entry.includes('.credentials.json.signed-out-')),
      ).toHaveLength(1)
      expect(getLogin(attempt.id)?.error).toMatch(/conflict|retained/i)
    } finally {
      fs.rmSync(profileDir, { recursive: true, force: true })
    }
  })

  it('returns the same active attempt after a lost response without re-archiving or reacquiring', async () => {
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-login-repeat-'))
    try {
      fs.writeFileSync(path.join(profileDir, '.credentials.json'), '{"oauth":"prior"}')
      const acquireLease = vi.fn(() => refreshLease())
      const spawnProcess = vi.fn(() => waitingClaudeChild()) as unknown as typeof spawn

      const first = await startLogin('claude', profileDir, {
        reauth: true,
        acquireLease,
        spawnProcess,
      })
      const repeated = await startLogin('claude', profileDir, {
        reauth: true,
        acquireLease,
        spawnProcess,
      })

      expect(repeated.id).toBe(first.id)
      expect(acquireLease).toHaveBeenCalledOnce()
      expect(spawnProcess).toHaveBeenCalledOnce()
      expect(
        fs.readdirSync(profileDir).filter((entry) => entry.includes('.credentials.json.signed-out-')),
      ).toHaveLength(1)
      cancelLogin(first.id)
    } finally {
      fs.rmSync(profileDir, { recursive: true, force: true })
    }
  })

  it('does not expose cancellation as terminal until child exit and exact rollback finish', async () => {
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-login-settling-'))
    try {
      const credential = path.join(profileDir, '.credentials.json')
      fs.writeFileSync(credential, '{"oauth":"prior"}')
      let closeChild = (): void => {}
      const child = new EventEmitter() as ChildProcessWithoutNullStreams
      const stdout = new PassThrough()
      Object.assign(child, {
        stdin: new PassThrough(),
        stdout,
        stderr: new PassThrough(),
        killed: false,
        kill: () => true,
      })
      closeChild = () => child.emit('close', null, 'SIGTERM')
      queueMicrotask(() => {
        stdout.write('https://claude.com/cai/oauth/authorize?state=test\n')
      })
      const attempt = await startLogin('claude', profileDir, {
        reauth: true,
        acquireLease: () => refreshLease(),
        spawnProcess: (() => child) as unknown as typeof spawn,
      })

      expect(cancelLogin(attempt.id)?.status).toBe('settling')
      expect(fs.existsSync(credential)).toBe(false)
      closeChild()

      await vi.waitFor(() => expect(getLogin(attempt.id)?.status).toBe('cancelled'))
      expect(fs.readFileSync(credential, 'utf8')).toBe('{"oauth":"prior"}')
    } finally {
      fs.rmSync(profileDir, { recursive: true, force: true })
    }
  })

  it('refuses to overwrite a durable attempt left by a crashed process', async () => {
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-login-existing-plan-'))
    try {
      fs.writeFileSync(
        path.join(profileDir, '.allmyagents-login-attempt.json'),
        JSON.stringify(durableState({ profileDir })),
      )
      const spawnProcess = vi.fn()

      const result = await startLogin('claude', profileDir, {
        acquireLease: () => refreshLease(),
        spawnProcess: spawnProcess as unknown as typeof spawn,
      })

      expect(result).toMatchObject({
        id: '11111111-1111-4111-8111-111111111111',
        status: 'settling',
        error: expect.stringMatching(/previous sign-in attempt.*recover/i),
      })
      expect(getLoginForProfile(profileDir)).toMatchObject({
        id: result.id,
        status: 'settling',
      })
      expect(spawnProcess).not.toHaveBeenCalled()
    } finally {
      fs.rmSync(profileDir, { recursive: true, force: true })
    }
  })

  it('rejects a credential result after its public-generation authority is frozen', async () => {
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-login-stale-epoch-'))
    try {
      const credential = path.join(profileDir, '.credentials.json')
      fs.writeFileSync(credential, '{"oauth":"prior"}')
      let current = true
      const attempt = await startLogin('claude', profileDir, {
        reauth: true,
        acquireLease: () => refreshLease(vi.fn(), { isCurrent: () => current }),
        spawnProcess: (() => waitingClaudeChild()) as unknown as typeof spawn,
        loginTimeoutMs: 1_000,
      })

      current = false
      fs.writeFileSync(
        credential,
        JSON.stringify({
          claudeAiOauth: { accessToken: 'stale-result', expiresAt: Date.now() + 60_000 },
        }),
      )

      await vi.waitFor(() => expect(getLogin(attempt.id)?.status).toBe('failed'), {
        timeout: 1_000,
        interval: 5,
      })
      expect(getLogin(attempt.id)?.error).toMatch(/lost authority|not accepted/i)
      expect(
        fs.readdirSync(profileDir).some((entry) => entry.includes('.credentials.json.signed-out-')),
      ).toBe(true)
    } finally {
      fs.rmSync(profileDir, { recursive: true, force: true })
    }
  })

  it('discovers and restores a crash-left archived profile before credential scanning', () => {
    const profilesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-login-reconcile-'))
    try {
      const profileDir = path.join(profilesDir, 'claude-a')
      fs.mkdirSync(profileDir)
      const credential = path.join(profileDir, '.credentials.json')
      const attemptId = '22222222-2222-4222-8222-222222222222'
      const archive = `${credential}.signed-out-${attemptId}`
      fs.writeFileSync(archive, '{"oauth":"prior"}')
      const priorSha256 = crypto.createHash('sha256').update('{"oauth":"prior"}').digest('hex')
      fs.writeFileSync(
        path.join(profileDir, '.allmyagents-login-attempt.json'),
        JSON.stringify(durableState({ profileDir, attemptId, archivePath: archive, priorSha256 })),
      )

      expect(discoverInterruptedLoginProfiles(profilesDir)).toEqual({
        profiles: [
          expect.objectContaining({
            id: 'claude-a',
            provider: 'claude',
            authStatus: 'signed_out',
          }),
        ],
        notices: [],
      })
      expect(
        reconcileInterruptedLogins(
          profilesDir,
          () =>
            refreshLease(vi.fn(), {
              ownerEpoch: 'owner-epoch',
              publicEpoch: 2,
              generationId: 'green-generation',
            }),
        ),
      ).toEqual([
        expect.objectContaining({ profileId: 'claude-a', outcome: 'restored-prior' }),
      ])
      expect(fs.readFileSync(credential, 'utf8')).toBe('{"oauth":"prior"}')
    } finally {
      fs.rmSync(profilesDir, { recursive: true, force: true })
    }
  })

  it('does not invent a profile from malformed or foreign durable metadata', () => {
    const profilesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-login-foreign-plan-'))
    try {
      const profileDir = path.join(profilesDir, 'claude-a')
      fs.mkdirSync(profileDir)
      fs.writeFileSync(
        path.join(profileDir, '.allmyagents-login-attempt.json'),
        JSON.stringify(durableState({ profileDir, profileId: 'codex-foreign' })),
      )

      expect(discoverInterruptedLoginProfiles(profilesDir)).toEqual({
        profiles: [],
        notices: [
          expect.objectContaining({
            profileId: 'claude-a',
            error: expect.stringMatching(/malformed|not bound/i),
          }),
        ],
      })
      expect(
        reconcileInterruptedLogins(profilesDir, () =>
          refreshLease(vi.fn(), { publicEpoch: 2, generationId: 'green-generation' }),
        ),
      ).toEqual([
        expect.objectContaining({
          profileId: 'claude-a',
          outcome: 'conflict',
          error: expect.stringMatching(/could not be verified/i),
        }),
      ])
    } finally {
      fs.rmSync(profilesDir, { recursive: true, force: true })
    }
  })

  it.each(['malformed', 'permission-error', 'path-aba'] as const)(
    'keeps an archived profile visible as an unavailable recovery notice when state is %s',
    (edge) => {
      const profilesDir = fs.mkdtempSync(path.join(os.tmpdir(), `ama-login-state-${edge}-`))
      const profileDir = path.join(profilesDir, 'claude-a')
      fs.mkdirSync(profileDir)
      const credential = path.join(profileDir, '.credentials.json')
      const attemptId = '66666666-6666-4666-8666-666666666666'
      const archive = `${credential}.signed-out-${attemptId}`
      const stateFile = path.join(profileDir, '.allmyagents-login-attempt.json')
      const prior = '{"oauth":"prior"}'
      fs.writeFileSync(archive, prior)
      const priorSha256 = crypto.createHash('sha256').update(prior).digest('hex')
      fs.writeFileSync(
        stateFile,
        edge === 'malformed'
          ? '{"format":'
          : JSON.stringify(durableState({ profileDir, attemptId, archivePath: archive, priorSha256 })),
      )

      const originalOpen = fs.openSync.bind(fs)
      const originalRead = fs.readFileSync.bind(fs)
      if (edge === 'permission-error') {
        vi.spyOn(fs, 'openSync').mockImplementation(((file: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
          if (path.resolve(String(file)) === path.resolve(stateFile) && flags === 'r') {
            throw Object.assign(new Error('simulated access denied'), { code: 'EACCES' })
          }
          return originalOpen(file, flags, mode)
        }) as typeof fs.openSync)
      } else if (edge === 'path-aba') {
        let replaced = false
        vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, options?: unknown) => {
          if (!replaced && typeof file === 'number') {
            replaced = true
            const displaced = `${stateFile}.displaced`
            fs.renameSync(stateFile, displaced)
            fs.writeFileSync(
              stateFile,
              JSON.stringify(durableState({ profileDir, attemptId, archivePath: archive, priorSha256 })),
            )
          }
          return originalRead(file, options as never)
        }) as typeof fs.readFileSync)
      }

      try {
        const discovery = discoverInterruptedLoginProfiles(profilesDir)
        expect(discovery.profiles).toEqual([])
        expect(discovery.notices).toEqual([
          expect.objectContaining({
            profileId: 'claude-a',
            error: expect.stringMatching(
              edge === 'malformed'
                ? /unreadable or malformed/i
                : edge === 'permission-error'
                  ? /access denied/i
                  : /path changed while reading/i,
            ),
          }),
        ])
        expect(fs.existsSync(credential)).toBe(false)
        expect(fs.readFileSync(archive, 'utf8')).toBe(prior)
      } finally {
        vi.restoreAllMocks()
        fs.rmSync(profilesDir, { recursive: true, force: true })
      }
    },
  )

  it('keeps an interrupted plan unresolved unless recovery has the same owner and a newer public epoch', () => {
    const profilesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-login-wrong-handoff-'))
    try {
      const profileDir = path.join(profilesDir, 'claude-a')
      fs.mkdirSync(profileDir)
      fs.writeFileSync(
        path.join(profileDir, '.allmyagents-login-attempt.json'),
        JSON.stringify(durableState({ profileDir })),
      )

      expect(
        reconcileInterruptedLogins(profilesDir, () =>
          refreshLease(vi.fn(), {
            ownerEpoch: 'different-owner-epoch',
            publicEpoch: 2,
            generationId: 'green-generation',
          }),
        ),
      ).toEqual([
        expect.objectContaining({
          profileId: 'claude-a',
          outcome: 'conflict',
          error: expect.stringMatching(/newer public-generation handoff/i),
        }),
      ])
      expect(fs.existsSync(path.join(profileDir, '.allmyagents-login-attempt.json'))).toBe(true)
    } finally {
      fs.rmSync(profilesDir, { recursive: true, force: true })
    }
  })

  it('restores an archived credential after a verified full-supervisor death and takeover', () => {
    const profilesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-login-owner-takeover-'))
    try {
      const profileDir = path.join(profilesDir, 'claude-a')
      fs.mkdirSync(profileDir)
      let predecessorLive = true
      const predecessor = new ProfileOwnership(
        { ownerId: 'old-supervisor', pid: 5101, port: 7819 },
        {
          generationId: 'old-generation',
          publicEpoch: 4,
          isProcessLive: (pid) => pid === 5101 && predecessorLive,
        },
      )
      const oldClaim = predecessor.claim('claude-a', profileDir)
      const credential = path.join(profileDir, '.credentials.json')
      const attemptId = '33333333-3333-4333-8333-333333333333'
      const archive = `${credential}.signed-out-${attemptId}`
      fs.writeFileSync(archive, '{"oauth":"prior"}')
      const priorSha256 = crypto.createHash('sha256').update('{"oauth":"prior"}').digest('hex')
      fs.writeFileSync(
        path.join(profileDir, '.allmyagents-login-attempt.json'),
        JSON.stringify(
          durableState({
            profileDir,
            attemptId,
            archivePath: archive,
            priorSha256,
            ownerId: 'old-supervisor',
            ownerEpoch: oldClaim.owner.epoch,
            publicEpoch: 4,
            generationId: 'old-generation',
          }),
        ),
      )

      predecessorLive = false
      const successor = new ProfileOwnership(
        { ownerId: 'new-supervisor', pid: 5102, port: 7820 },
        {
          generationId: 'new-generation',
          publicEpoch: 1,
          isProcessLive: (pid) => pid === 5102,
        },
      )
      const takeover = successor.claim('claude-a', profileDir)
      expect(takeover.takeover).toMatchObject({
        predecessorOwnerId: 'old-supervisor',
        predecessorOwnerEpoch: oldClaim.owner.epoch,
        successorOwnerId: 'new-supervisor',
        reason: 'dead-predecessor',
      })

      expect(
        reconcileInterruptedLogins(profilesDir, (profileId, dir, operation) =>
          successor.acquireRefreshLease(profileId, dir, operation),
        ),
      ).toEqual([
        expect.objectContaining({ profileId: 'claude-a', outcome: 'restored-prior' }),
      ])
      expect(fs.readFileSync(credential, 'utf8')).toBe('{"oauth":"prior"}')
    } finally {
      fs.rmSync(profilesDir, { recursive: true, force: true })
    }
  })

  it('keeps recovery busy while the predecessor supervisor remains live', () => {
    const profilesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-login-owner-live-'))
    try {
      const profileDir = path.join(profilesDir, 'claude-a')
      fs.mkdirSync(profileDir)
      const predecessor = new ProfileOwnership(
        { ownerId: 'old-supervisor', pid: 5201, port: 7819 },
        { generationId: 'old-generation', isProcessLive: () => true },
      )
      const oldClaim = predecessor.claim('claude-a', profileDir)
      fs.writeFileSync(
        path.join(profileDir, '.allmyagents-login-attempt.json'),
        JSON.stringify(
          durableState({
            profileDir,
            ownerId: 'old-supervisor',
            ownerEpoch: oldClaim.owner.epoch,
          }),
        ),
      )
      const successor = new ProfileOwnership(
        { ownerId: 'new-supervisor', pid: 5202, port: 7820 },
        { generationId: 'new-generation', isProcessLive: () => true },
      )

      expect(
        reconcileInterruptedLogins(profilesDir, (profileId, dir, operation) =>
          successor.acquireRefreshLease(profileId, dir, operation),
        ),
      ).toEqual([
        expect.objectContaining({ profileId: 'claude-a', outcome: 'busy' }),
      ])
      expect(fs.existsSync(path.join(profileDir, '.allmyagents-login-attempt.json'))).toBe(true)
    } finally {
      fs.rmSync(profilesDir, { recursive: true, force: true })
    }
  })

  it.each(['path-aba', 'permission-error'] as const)(
    'fails closed on interrupted archive %s without publishing or deleting unrelated bytes',
    (edge) => {
      const profilesDir = fs.mkdtempSync(path.join(os.tmpdir(), `ama-login-${edge}-`))
      try {
        const profileDir = path.join(profilesDir, 'claude-a')
        fs.mkdirSync(profileDir)
        const credential = path.join(profileDir, '.credentials.json')
        const attemptId = '44444444-4444-4444-8444-444444444444'
        const archive = `${credential}.signed-out-${attemptId}`
        const prior = '{"oauth":"prior"}'
        fs.writeFileSync(archive, prior)
        const priorSha256 = crypto.createHash('sha256').update(prior).digest('hex')
        fs.writeFileSync(
          path.join(profileDir, '.allmyagents-login-attempt.json'),
          JSON.stringify(durableState({ profileDir, attemptId, archivePath: archive, priorSha256 })),
        )
        const displaced = `${archive}.original`

        const result = reconcileInterruptedLogins(
          profilesDir,
          () =>
            refreshLease(vi.fn(), {
              publicEpoch: 2,
              generationId: 'green-generation',
            }),
          {
            failpoint: () => {
              if (edge === 'permission-error') {
                throw Object.assign(new Error('simulated access denied'), { code: 'EACCES' })
              }
              fs.renameSync(archive, displaced)
              fs.writeFileSync(archive, '{"oauth":"replacement"}')
            },
          },
        )

        expect(result).toEqual([
          expect.objectContaining({
            profileId: 'claude-a',
            outcome: 'conflict',
            error: expect.stringMatching(
              edge === 'path-aba' ? /changed during.*publication/i : /access denied/i,
            ),
          }),
        ])
        expect(fs.existsSync(credential)).toBe(false)
        if (edge === 'path-aba') {
          expect(fs.readFileSync(archive, 'utf8')).toBe('{"oauth":"replacement"}')
          expect(fs.readFileSync(displaced, 'utf8')).toBe(prior)
        } else {
          expect(fs.readFileSync(archive, 'utf8')).toBe(prior)
        }
      } finally {
        fs.rmSync(profilesDir, { recursive: true, force: true })
      }
    },
  )

  it('rejects a non-regular interrupted credential archive without following it', () => {
    const profilesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-login-archive-directory-'))
    try {
      const profileDir = path.join(profilesDir, 'claude-a')
      fs.mkdirSync(profileDir)
      const credential = path.join(profileDir, '.credentials.json')
      const attemptId = '55555555-5555-4555-8555-555555555555'
      const archive = `${credential}.signed-out-${attemptId}`
      fs.mkdirSync(archive)
      fs.writeFileSync(
        path.join(profileDir, '.allmyagents-login-attempt.json'),
        JSON.stringify(
          durableState({
            profileDir,
            attemptId,
            archivePath: archive,
            priorSha256: 'a'.repeat(64),
          }),
        ),
      )

      expect(
        reconcileInterruptedLogins(profilesDir, () =>
          refreshLease(vi.fn(), { publicEpoch: 2, generationId: 'green-generation' }),
        ),
      ).toEqual([
        expect.objectContaining({
          outcome: 'conflict',
          error: expect.stringMatching(/not a regular file/i),
        }),
      ])
      expect(fs.existsSync(credential)).toBe(false)
      expect(fs.statSync(archive).isDirectory()).toBe(true)
    } finally {
      fs.rmSync(profilesDir, { recursive: true, force: true })
    }
  })

  it('reports restart settlement timeout as unknown rather than a false terminal', async () => {
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-login-drain-'))
    try {
      const child = new EventEmitter() as ChildProcessWithoutNullStreams
      const stdout = new PassThrough()
      Object.assign(child, {
        stdin: new PassThrough(),
        stdout,
        stderr: new PassThrough(),
        killed: false,
        kill: () => true,
      })
      queueMicrotask(() => stdout.write('https://claude.com/cai/oauth/authorize?state=test\n'))
      const attempt = await startLogin('claude', profileDir, {
        acquireLease: () => refreshLease(),
        spawnProcess: (() => child) as unknown as typeof spawn,
      })

      await expect(settleLoginsForRestart(10)).resolves.toEqual({
        settled: 0,
        outcomeUnknown: 1,
      })
      expect(getLogin(attempt.id)?.status).toBe('settling')
      child.emit('close', null, 'SIGTERM')
      await vi.waitFor(() => expect(getLogin(attempt.id)?.status).toBe('cancelled'))
    } finally {
      setLoginAdmission(true)
      fs.rmSync(profileDir, { recursive: true, force: true })
    }
  })

  it('returns a durable capturing attempt promptly when the vendor never emits a URL', async () => {
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-login-bounded-post-'))
    try {
      const child = new EventEmitter() as ChildProcessWithoutNullStreams
      Object.assign(child, {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        killed: false,
        kill: () => {
          queueMicrotask(() => child.emit('close', null, 'SIGTERM'))
          return true
        },
      })
      let requestTimer: NodeJS.Timeout | undefined
      const attempt = await Promise.race([
        startLogin('claude', profileDir, {
          idempotencyKey: 'request-1',
          acquireLease: () => refreshLease(),
          spawnProcess: (() => child) as unknown as typeof spawn,
          captureTimeoutMs: 60_000,
        }),
        new Promise<'request-timeout'>((resolve) => {
          requestTimer = setTimeout(() => resolve('request-timeout'), 2_000)
          requestTimer.unref()
        }),
      ])
      if (requestTimer) clearTimeout(requestTimer)

      expect(attempt).not.toBe('request-timeout')
      if (attempt === 'request-timeout') throw new Error('startLogin held the request open')
      expect(attempt.status).toBe('capturing')
      expect(getLoginForProfile(profileDir)).toMatchObject({ id: attempt.id, status: 'capturing' })
      expect(
        await startLogin('claude', profileDir, {
          idempotencyKey: 'request-1',
          acquireLease: () => refreshLease(),
          spawnProcess: vi.fn() as unknown as typeof spawn,
        }),
      ).toMatchObject({ id: attempt.id, status: 'capturing' })
      cancelLogin(attempt.id)
      await vi.waitFor(() => expect(getLogin(attempt.id)?.status).toBe('cancelled'))
    } finally {
      fs.rmSync(profileDir, { recursive: true, force: true })
    }
  })

  it.runIf(process.platform === 'win32')(
    'uses one fixed-size flushed Windows metadata barrier across repeated rollback publications',
    async () => {
      const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-login-win-barrier-'))
      try {
        const credential = path.join(profileDir, '.credentials.json')
        for (let index = 0; index < 3; index++) {
          fs.writeFileSync(credential, `{"oauth":"prior-${index}"}`)
          const attempt = await startLogin('claude', profileDir, {
            reauth: true,
            acquireLease: () => refreshLease(),
            spawnProcess: (() => {
              throw new Error('simulated spawn failure after archive')
            }) as unknown as typeof spawn,
          })
          expect(attempt.status).toBe('failed')
          expect(fs.readFileSync(credential, 'utf8')).toBe(`{"oauth":"prior-${index}"}`)
        }

        const barriers = fs
          .readdirSync(profileDir)
          .filter((entry) => entry === '.ama-directory-barrier')
        expect(barriers).toEqual(['.ama-directory-barrier'])
        const barrier = path.join(profileDir, barriers[0] as string)
        expect(fs.readFileSync(barrier, 'utf8')).toBe('ama-dir-sync-v1\n')
        expect(fs.statSync(barrier).size).toBe(16)
      } finally {
        fs.rmSync(profileDir, { recursive: true, force: true })
      }
    },
  )
})

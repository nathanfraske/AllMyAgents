import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Provider } from './types.js'

const CRED_FILE: Record<Provider, string> = {
  claude: '.credentials.json',
  codex: 'auth.json',
}

const ENV_VAR: Record<Provider, string> = {
  claude: 'CLAUDE_CONFIG_DIR',
  codex: 'CODEX_HOME',
}

const PROVIDER_LABEL: Record<Provider, string> = {
  claude: 'Claude',
  codex: 'Codex',
}

const ACTIVE = new Set<LoginStatus>(['capturing', 'waiting'])
const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g
const URL = /https?:\/\/[^\s<>"'`\\]+/gi
const MAX_OUTPUT = 16_000
const DEFAULT_CAPTURE_TIMEOUT_MS = 30_000
const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60_000

export type LoginStatus = 'capturing' | 'waiting' | 'complete' | 'failed' | 'cancelled' | 'timed-out'

export interface LoginAttempt {
  id: string
  provider: Provider
  status: LoginStatus
  url?: string
  code?: string
  error?: string
}

interface LoginAttemptInternal extends LoginAttempt {
  profileDir: string
  child: ChildProcessWithoutNullStreams
  output: string
  settledCapture: boolean
  captureTimer?: NodeJS.Timeout
  loginTimer?: NodeJS.Timeout
  credentialPoll?: NodeJS.Timeout
}

interface StartLoginOptions {
  captureTimeoutMs?: number
  loginTimeoutMs?: number
  spawnProcess?: typeof spawn
}

const attempts = new Map<string, LoginAttemptInternal>()

function binDir(): string {
  return path.resolve(import.meta.dirname, '..', 'node_modules', '.bin')
}

function repoRoot(): string {
  return path.resolve(import.meta.dirname, '..', '..', '..')
}

function cleanOutput(value: string): string {
  return value
    .replace(ANSI, '')
    .replace(/\r/g, '')
    .replace(/[^\x09\x0a\x20-\x7e\u00a0-\uffff]/g, '')
}

function conciseOutput(value: string): string {
  const clean = cleanOutput(value).trim()
  if (!clean) return '(the command produced no readable output)'
  return clean.length > 2_400 ? `…${clean.slice(-2_400)}` : clean
}

function trimUrl(raw: string): string {
  return raw.replace(/[\]),.;:!?]+$/g, '')
}

function candidateScore(provider: Provider, url: globalThis.URL, context: string): number {
  const host = url.hostname.toLowerCase()
  const text = `${url.pathname} ${context}`.toLowerCase()
  let score = 0
  if (url.protocol === 'https:') score += 20
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') score -= 1_000
  if (
    provider === 'claude' &&
    (host.endsWith('claude.ai') || host.endsWith('claude.com') || host.endsWith('anthropic.com'))
  ) score += 100
  if (provider === 'codex' && (host.endsWith('openai.com') || host.endsWith('chatgpt.com'))) score += 100
  if (/^\/(?:docs?|help|support)(?:\/|$)/.test(url.pathname.toLowerCase())) score -= 100
  if (/\b(oauth|authorize|authenticate|login|sign-in|signin|device)\b/.test(text)) score += 40
  if (/\b(browser|navigate|open|visit|continue)\b/.test(context.toLowerCase())) score += 15
  return score
}

/**
 * Extract the vendor authorization URL from mixed stdout/stderr.
 *
 * Both CLIs may also print documentation links and Codex prints its localhost callback listener.
 * Score every URL instead of taking the first one, preferring vendor auth hosts and auth-shaped
 * paths while explicitly rejecting localhost.
 */
export function parseLoginOutput(provider: Provider, output: string): { url: string; code?: string } | null {
  const clean = cleanOutput(output)
  const candidates: Array<{ url: string; score: number }> = []
  for (const match of clean.matchAll(URL)) {
    const raw = trimUrl(match[0])
    try {
      const parsed = new globalThis.URL(raw)
      if (parsed.protocol !== 'https:') continue
      const start = Math.max(0, (match.index ?? 0) - 120)
      const context = clean.slice(start, (match.index ?? 0) + raw.length + 80)
      candidates.push({ url: parsed.toString(), score: candidateScore(provider, parsed, context) })
    } catch {
      // A partial URL can occur while a stream chunk is still arriving. The next chunk reparses the
      // whole buffer, so there is nothing to do here.
    }
  }
  candidates.sort((a, b) => b.score - a.score)
  const best = candidates[0]
  if (!best || best.score < 75) return null
  const code = /\b([A-Z0-9]{4,8}(?:-[A-Z0-9]{4,8}){1,3})\b/.exec(clean)?.[1]
  return code ? { url: best.url, code } : { url: best.url }
}

export function loginCaptureError(provider: Provider, output: string): string {
  return `${PROVIDER_LABEL[provider]} did not provide a sign-in URL. Command output:\n${conciseOutput(output)}`
}

export function credentialsPath(provider: Provider, profileDir: string): string {
  return path.join(profileDir, CRED_FILE[provider])
}

export function credentialsExist(provider: Provider, profileDir: string): boolean {
  try {
    return fs.existsSync(credentialsPath(provider, profileDir))
  } catch {
    return false
  }
}

function loginCommand(provider: Provider): { command: string; args: string[] } {
  if (process.platform === 'win32') {
    if (provider === 'claude') {
      // Pinned Claude 2.1.218 has no --no-browser equivalent to Codex --device-auth and always asks
      // the OS to open its OAuth URL, even with piped stdio/CI/SSH markers. Keep it terminal-free and
      // still capture/return the URL for remote or failed-opener fallback. The web app documents this
      // provider difference and avoids opening a duplicate tab in the local desktop shell.
      return {
        command: path.resolve(binDir(), '..', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
        args: ['auth', 'login'],
      }
    }
    return {
      command: process.execPath,
      args: [
        path.resolve(binDir(), '..', '@openai', 'codex', 'bin', 'codex.js'),
        'login',
        '--device-auth',
      ],
    }
  }
  return {
    command: path.join(binDir(), provider),
    args: provider === 'claude' ? ['auth', 'login'] : ['login', '--device-auth'],
  }
}

function publicAttempt(attempt: LoginAttemptInternal): LoginAttempt {
  const { id, provider, status, url, code, error } = attempt
  return {
    id,
    provider,
    status,
    ...(url ? { url } : {}),
    ...(code ? { code } : {}),
    ...(error ? { error } : {}),
  }
}

function clearAttemptTimers(attempt: LoginAttemptInternal): void {
  if (attempt.captureTimer) clearTimeout(attempt.captureTimer)
  if (attempt.loginTimer) clearTimeout(attempt.loginTimer)
  if (attempt.credentialPoll) clearInterval(attempt.credentialPoll)
}

function terminate(attempt: LoginAttemptInternal): void {
  if (!attempt.child.killed) {
    try {
      if (process.platform === 'win32' && attempt.child.pid) {
        // A Windows login process can own native descendants (the Codex Node wrapper does). child.kill()
        // terminates only the direct process and can leave the auth child polling forever. taskkill is
        // hidden, scoped to the exact owned PID, and cancels that process tree.
        const killer = spawn(
          'taskkill',
          ['/PID', String(attempt.child.pid), '/T', '/F'],
          { windowsHide: true, stdio: 'ignore' }
        )
        killer.unref()
      } else {
        attempt.child.kill()
      }
    } catch {
      // The child may have crossed its exit boundary between the killed check and kill().
    }
  }
}

function finish(attempt: LoginAttemptInternal, status: LoginStatus, error?: string): void {
  if (!ACTIVE.has(attempt.status)) return
  attempt.status = status
  attempt.error = error
  clearAttemptTimers(attempt)
  terminate(attempt)
  const cleanup = setTimeout(() => attempts.delete(attempt.id), 10 * 60_000)
  cleanup.unref()
}

function watchForCredentials(attempt: LoginAttemptInternal, loginTimeoutMs: number): void {
  const check = (): void => {
    if (!ACTIVE.has(attempt.status)) return
    if (credentialsExist(attempt.provider, attempt.profileDir)) finish(attempt, 'complete')
  }
  attempt.credentialPoll = setInterval(check, 1_000)
  attempt.credentialPoll.unref()
  attempt.loginTimer = setTimeout(() => {
    finish(
      attempt,
      'timed-out',
      `${PROVIDER_LABEL[attempt.provider]} sign-in timed out. Open the sign-in URL again or cancel and retry.`
    )
  }, loginTimeoutMs)
  attempt.loginTimer.unref()
  check()
}

/**
 * Launch one vendor login without a terminal on every platform and resolve as soon as its OAuth URL
 * is available. The child remains owned by this module while the browser flow completes.
 */
export function startLogin(
  provider: Provider,
  profileDir: string,
  opts: StartLoginOptions = {}
): Promise<LoginAttempt> {
  fs.mkdirSync(profileDir, { recursive: true })
  const existing = [...attempts.values()].find(
    (attempt) => attempt.profileDir === profileDir && ACTIVE.has(attempt.status)
  )
  if (existing) return Promise.resolve(publicAttempt(existing))

  const { command, args } = loginCommand(provider)
  const spawnProcess = opts.spawnProcess ?? spawn
  const child = spawnProcess(command, args, {
    shell: false,
    detached: false,
    windowsHide: true,
    cwd: repoRoot(),
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PATH: `${binDir()}${path.delimiter}${process.env.PATH ?? ''}`,
      [ENV_VAR[provider]]: profileDir,
    },
  }) as ChildProcessWithoutNullStreams

  return new Promise((resolve) => {
    const id = crypto.randomUUID()
    const captureTimeoutMs = opts.captureTimeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS
    const loginTimeoutMs = opts.loginTimeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS
    const attempt: LoginAttemptInternal = {
      id,
      provider,
      profileDir,
      child,
      output: '',
      status: 'capturing',
      settledCapture: false,
    }
    attempts.set(id, attempt)

    const settleCapture = (): void => {
      if (attempt.settledCapture) return
      const parsed = parseLoginOutput(provider, attempt.output)
      if (!parsed) return
      // Codex device auth emits the URL and one-time code in separate writes. Returning after the URL
      // alone opens a page the operator cannot finish, so wait until both pieces are captured.
      if (provider === 'codex' && parsed.url.includes('/codex/device') && !parsed.code) return
      attempt.settledCapture = true
      if (attempt.captureTimer) clearTimeout(attempt.captureTimer)
      attempt.status = 'waiting'
      attempt.url = parsed.url
      attempt.code = parsed.code
      watchForCredentials(attempt, loginTimeoutMs)
      resolve(publicAttempt(attempt))
    }

    const append = (chunk: Buffer | string): void => {
      attempt.output = `${attempt.output}${String(chunk)}`
      if (attempt.output.length > MAX_OUTPUT) attempt.output = attempt.output.slice(-MAX_OUTPUT)
      settleCapture()
    }
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    // Keep stdin open. Neither dedicated login command needs a TTY, but closing stdin immediately can
    // make a CLI mistake a non-interactive launch for an intentional cancellation.

    attempt.captureTimer = setTimeout(() => {
      if (attempt.settledCapture) return
      attempt.settledCapture = true
      const error = loginCaptureError(provider, attempt.output)
      console.error(`[login] URL capture failed for ${provider}:\n${conciseOutput(attempt.output)}`)
      finish(attempt, 'failed', error)
      resolve(publicAttempt(attempt))
    }, captureTimeoutMs)
    attempt.captureTimer.unref()

    child.once('error', (error) => {
      append(error.message)
      if (!attempt.settledCapture) {
        attempt.settledCapture = true
        const message = loginCaptureError(provider, attempt.output)
        finish(attempt, 'failed', message)
        resolve(publicAttempt(attempt))
      } else if (!credentialsExist(provider, profileDir)) {
        finish(attempt, 'failed', `${PROVIDER_LABEL[provider]} login process failed: ${error.message}`)
      }
    })
    child.once('close', (code, signal) => {
      if (credentialsExist(provider, profileDir)) {
        finish(attempt, 'complete')
        return
      }
      const reason = signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`
      if (!attempt.settledCapture) {
        attempt.settledCapture = true
        const message = `${loginCaptureError(provider, attempt.output)}\nThe command ended with ${reason}.`
        finish(attempt, 'failed', message)
        resolve(publicAttempt(attempt))
      } else if (ACTIVE.has(attempt.status)) {
        finish(
          attempt,
          'failed',
          `${PROVIDER_LABEL[provider]} sign-in ended before credentials were saved (${reason}).`
        )
      }
    })
  })
}

export function getLogin(id: string): LoginAttempt | undefined {
  const attempt = attempts.get(id)
  return attempt ? publicAttempt(attempt) : undefined
}

export function cancelLogin(id: string): LoginAttempt | undefined {
  const attempt = attempts.get(id)
  if (!attempt) return undefined
  finish(attempt, 'cancelled', `${PROVIDER_LABEL[attempt.provider]} sign-in was cancelled.`)
  return publicAttempt(attempt)
}

export function awaitLogin(
  provider: Provider,
  profileDir: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS
  const intervalMs = opts.intervalMs ?? 2_000
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve) => {
    const tick = (): void => {
      if (credentialsExist(provider, profileDir)) {
        resolve(true)
        return
      }
      if (Date.now() >= deadline) {
        resolve(false)
        return
      }
      setTimeout(tick, intervalMs)
    }
    setTimeout(tick, intervalMs)
  })
}

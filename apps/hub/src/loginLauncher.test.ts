import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { archiveCredentialForReauth, getLogin, loginCaptureError, parseLoginOutput, startLogin } from './loginLauncher.js'

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
    kill: () => true,
  })
  queueMicrotask(() => {
    stdout.write('https://claude.com/cai/oauth/authorize?client_id=throwaway&state=test\n')
    setTimeout(() => fs.writeFileSync(path.join(profileDir, '.credentials.json'), '{"oauth":"fresh"}'), 15)
  })
  return child
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

      expect(result.status).toBe('failed')
      expect(result.error).toContain('Codex did not provide a sign-in URL')
      expect(result.error).toContain('Login failed before emitting a link.')
    } finally {
      fs.rmSync(profileDir, { recursive: true, force: true })
    }
  })

  it('re-authenticates a genuinely invalid credential instead of accepting the stale file', async () => {
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-login-invalid-'))
    try {
      const credential = path.join(profileDir, '.credentials.json')
      fs.writeFileSync(credential, '{"oauth":"deliberately-invalid"}')
      const archived = archiveCredentialForReauth('claude', profileDir)
      expect(archived && fs.existsSync(archived)).toBe(true)
      expect(fs.existsSync(credential)).toBe(false)

      const attempt = await startLogin('claude', profileDir, {
        spawnProcess: (() => successfulClaudeChild(profileDir)) as unknown as typeof spawn,
        loginTimeoutMs: 2_000,
      })
      expect(attempt.status).toBe('waiting')
      await new Promise((resolve) => setTimeout(resolve, 1_100))
      expect(getLogin(attempt.id)?.status).toBe('complete')
      expect(fs.readFileSync(credential, 'utf8')).toContain('fresh')
    } finally {
      fs.rmSync(profileDir, { recursive: true, force: true })
    }
  })
})

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Provider } from './types.js'

// The credential file each vendor writes into its config dir once OAuth completes.
// These are the same markers scanProfiles() uses to register a profile.
const CRED_FILE: Record<Provider, string> = {
  claude: '.credentials.json',
  codex: 'auth.json',
}

// The env var each vendor CLI reads to locate its config dir (== the profile dir).
const ENV_VAR: Record<Provider, string> = {
  claude: 'CLAUDE_CONFIG_DIR',
  codex: 'CODEX_HOME',
}

// Absolute path to the bundled CLI shims (claude.CMD / codex.CMD). The hub is normally
// launched via pnpm/tsx, so this dir is already on PATH — but a freshly spawned console
// window is more reliable if we prepend it explicitly rather than trusting inheritance.
function binDir(): string {
  return path.resolve(import.meta.dirname, '..', 'node_modules', '.bin')
}

// repoRoot — used as the working directory for the opened console window.
function repoRoot(): string {
  return path.resolve(import.meta.dirname, '..', '..', '..')
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

// Generates the batch script the visible console window runs. Mirrors native.ts's
// "generated script + window" pattern. Written as CRLF, ASCII-only, to avoid codepage
// surprises. We `call` the CLI so control returns for the trailing pause (a bare .cmd
// call inside a batch would otherwise transfer control and never return).
function buildBatch(provider: Provider, profileDir: string): string {
  const loginCmd = provider === 'claude' ? 'claude' : 'codex login'
  const guide =
    provider === 'claude'
      ? [
          'echo  A Claude Code session will open below.',
          'echo  Type   /login   and complete the browser sign-in,',
          'echo  then type   /exit   once the account is connected.',
        ]
      : [
          'echo  Your web browser will open for Codex sign-in.',
          'echo  Complete it there; this window finishes on its own.',
        ]
  return (
    [
      '@echo off',
      `title AiAgentApp login - ${provider}`,
      `set "PATH=${binDir()};%PATH%"`,
      `set "${ENV_VAR[provider]}=${profileDir}"`,
      'echo ============================================================',
      `echo  Adding a ${provider} account`,
      `echo  Profile dir: ${profileDir}`,
      'echo ============================================================',
      ...guide,
      'echo.',
      `call ${loginCmd}`,
      'echo.',
      'echo  ------------------------------------------------------------',
      'echo  Sign-in step finished. You can close this window.',
      'echo  (The app detects the new account automatically.)',
      'pause',
      '',
    ].join('\r\n')
  )
}

// macOS counterpart to buildBatch: an executable `.command` script, which Terminal.app runs in a new
// window when `open`ed. Same shape as the batch — put the vendor `.bin` dir on PATH, point the
// config-dir env var at profileDir, then run the CLI. Single-quoting is avoided in favour of double
// quotes so the interpolated absolute paths survive spaces; profileDir is server-validated to
// ^[a-zA-Z0-9_-]+$ under profilesDir, so it carries no quote characters.
function buildShellScript(provider: Provider, profileDir: string): string {
  const loginCmd = provider === 'claude' ? 'claude' : 'codex login'
  const guide =
    provider === 'claude'
      ? [
          'echo "  A Claude Code session will open below."',
          'echo "  Type   /login   and complete the browser sign-in,"',
          'echo "  then type   /exit   once the account is connected."',
        ]
      : [
          'echo "  Your web browser will open for Codex sign-in."',
          'echo "  Complete it there; this window finishes on its own."',
        ]
  return [
    '#!/bin/sh',
    `cd "${repoRoot()}" || exit 1`,
    `export PATH="${binDir()}:$PATH"`,
    `export ${ENV_VAR[provider]}="${profileDir}"`,
    'echo "============================================================"',
    `echo "  Adding a ${provider} account"`,
    `echo "  Profile dir: ${profileDir}"`,
    'echo "============================================================"',
    ...guide,
    'echo',
    loginCmd,
    'echo',
    'echo "  ------------------------------------------------------------"',
    'echo "  Sign-in step finished. You can close this window."',
    'echo "  (The app detects the new account automatically.)"',
    '',
  ].join('\n')
}

// Opens a NEW VISIBLE terminal window that runs the vendor login with the right config-dir env var
// pointed at profileDir, so the browser OAuth flow can open for the user. The hub runs headless, so
// popping a real console needs a platform-specific trick:
//   - Windows: cmd's `start` builtin (CREATE_NEW_CONSOLE) on a generated `.cmd`.
//   - macOS:   an executable `.command` script handed to `open`, which Terminal.app claims.
// Fire-and-forget — awaitLogin() observes the result by polling for the credentials file.
//
// Returns TRUE if a terminal was launched, FALSE on a platform with no reliable way to do so
// (Linux/other, where the desktop varies too much to guess), so the caller can hand the operator the
// manual command instead. Callers must check the return value.
export function startLogin(provider: Provider, profileDir: string): boolean {
  fs.mkdirSync(profileDir, { recursive: true })

  if (process.platform === 'win32') {
    const scriptPath = path.join(os.tmpdir(), `aiagentapp-login-${provider}-${Date.now()}.cmd`)
    fs.writeFileSync(scriptPath, buildBatch(provider, profileDir), 'utf8')

    // start "<title>" /d "<cwd>" "<script>"  — the first quoted token is the window title,
    // so an explicit title is required before the script path (which is also quoted).
    const cmdLine = `start "AiAgentApp login - ${provider}" /d "${repoRoot()}" "${scriptPath}"`
    const child = spawn(cmdLine, {
      shell: true,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    })
    child.on('error', () => {
      /* ignore — awaitLogin()'s timeout surfaces a failed launch to the caller */
    })
    child.unref()
    return true
  }

  if (process.platform === 'darwin') {
    const scriptPath = path.join(os.tmpdir(), `aiagentapp-login-${provider}-${Date.now()}.command`)
    fs.writeFileSync(scriptPath, buildShellScript(provider, profileDir), 'utf8')
    fs.chmodSync(scriptPath, 0o755) // Terminal only runs a `.command` that is executable
    const child = spawn('open', [scriptPath], { detached: true, stdio: 'ignore' })
    child.on('error', () => {
      /* ignore — awaitLogin()'s timeout surfaces a failed launch to the caller */
    })
    child.unref()
    return true
  }

  // Linux/other: a headless daemon cannot reliably pop a visible terminal (no single console app is
  // guaranteed). The server layer returns the manual `pnpm login:` instruction instead.
  return false
}

// Polls for the credentials file to appear, resolving true once the vendor has written it
// (login succeeded) or false on timeout. Default: every 2s for up to 5 minutes.
export function awaitLogin(
  provider: Provider,
  profileDir: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000
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
    // First check after one interval — gives the console + browser time to spin up.
    setTimeout(tick, intervalMs)
  })
}

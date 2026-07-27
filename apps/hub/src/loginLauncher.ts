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
// launched via pnpm/tsx, so this dir is already on PATH — but login is also used by the
// installed desktop app, where resolving our pinned CLIs must not depend on global PATH.
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

// macOS fallback: an executable `.command` script, which Terminal.app runs in a new window when
// `open`ed. Put the vendor `.bin` dir on PATH, point the config-dir env var at profileDir, then run the
// dedicated login command. Single-quoting is avoided in favour of double quotes so the interpolated
// absolute paths survive spaces; profileDir is server-validated to ^[a-zA-Z0-9_-]+$ under profilesDir,
// so it carries no quote characters.
function buildShellScript(provider: Provider, profileDir: string): string {
  const loginCmd = provider === 'claude' ? 'claude auth login' : 'codex login'
  const guide = [
    'echo "  Your web browser will open for sign-in."',
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

// Starts the vendor login with the right config-dir env var pointed at profileDir, so browser OAuth
// writes credentials into the managed account rather than the user's global CLI config.
//
// Windows is deliberately terminal-free. Both pinned vendors expose dedicated login commands, and
// CREATE_NO_WINDOW (`windowsHide`) keeps the unavoidable .cmd host invisible while the vendor opens
// the browser. Claude used to launch its entire interactive TUI here, forcing a brand-new user to type
// `/login`, copy/finish a URL, then `/exit` in a surprise console — the worst possible first-run seam.
//
// macOS retains its visible Terminal fallback for now; unlike Windows there is no bundled, uniform
// browser-launch host we can prove across supported versions. It now uses Claude's dedicated auth
// command, so no slash commands are required there either.
// Fire-and-forget — awaitLogin() observes the result by polling for the credentials file.
//
// Returns TRUE if a sign-in process was launched, FALSE on a platform with no reliable way to surface
// one (Linux/other, where the desktop varies too much to guess), so the caller can hand the operator
// the manual command instead. Callers must check the return value.
export function startLogin(provider: Provider, profileDir: string): boolean {
  fs.mkdirSync(profileDir, { recursive: true })

  if (process.platform === 'win32') {
    const shim = path.join(binDir(), `${provider}.cmd`)
    const args = provider === 'claude' ? ['auth', 'login'] : ['login']
    const child = spawn(shim, args, {
      shell: true,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      cwd: repoRoot(),
      env: {
        ...process.env,
        PATH: `${binDir()}${path.delimiter}${process.env.PATH ?? ''}`,
        [ENV_VAR[provider]]: profileDir,
      },
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

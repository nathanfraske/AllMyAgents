#!/usr/bin/env node
// -------------------------------------------------------------------------------------------
// desktop-smoke.mjs — a dependency-light smoke test for the packaged CEC AiMesh desktop app.
//
// WHAT IT CHECKS
//   1. The release binary exists at the expected path (you must build it first).
//   2. Launching it does NOT instantly panic-exit — a prior regression was an immediate crash
//      on startup, so we launch the exe and confirm it stays alive for ~10s.
//   3. The Node hub becomes reachable on 127.0.0.1:7777 (the desktop shell spawns it via
//      `pnpm hub:dev`; see apps/desktop/src-tauri/src/lib.rs).
//   It prints "SMOKE PASS" / "SMOKE FAIL" and, on failure, the captured stderr. Exit code is
//   0 on pass, 1 on fail — suitable for CI once a headless display is available.
//
// HOW TO RUN (opens a real GUI window — run it on a machine with a desktop session):
//   1. Build the desktop app first (Rust + bundling; takes a while):
//        pnpm desktop:build
//   2. Make sure nothing else is already bound to 127.0.0.1:7777 that you care about — this
//      script (and the app) will use whatever hub is listening there; the app won't spawn a
//      second hub if one is already up.
//   3. From the repo root:
//        node scripts/desktop-smoke.mjs
//   The script launches the app, waits, checks the hub, then tears the app (and the hub tree
//   it spawned) back down so it doesn't leave a window or node processes running.
//
// NOTE: this is a *smoke* test, not full end-to-end coverage. A fuller E2E harness that drives
// the actual UI (clicking, asserting rendered DOM, exercising the drag/split flow in the real
// webview) would use `tauri-driver` + WebdriverIO with the `@wdio/tauri-service` — that spins
// up a WebDriver session against the Tauri webview. That is deliberately left as a TODO here:
// it needs `tauri-driver` installed and a WebDriver-capable environment, which is heavier than
// this built-ins-only check. See https://v2.tauri.app/develop/tests/webdriver/ .
//
// TODO(e2e): add scripts/desktop-e2e/ using tauri-driver + WebdriverIO to assert the window
//            renders the sidebar and that drag-to-split produces a 2-pane layout.
// -------------------------------------------------------------------------------------------

import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import net from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')

const HUB_HOST = '127.0.0.1'
const HUB_PORT = 7777

// Where `tauri build` leaves something launchable. The candidates differ by OS, so we take the first
// that exists rather than hardcoding one:
//   Windows — target/release/<crate>.exe (crate name from Cargo.toml, NOT the productName).
//   macOS   — prefer the .app bundle's inner binary (named after `productName`), because that is what
//             a user actually runs and it is the only form where Tauri resolves `resource_dir()` to
//             Contents/Resources — i.e. where the bundled hub payload lives. The bare
//             target/release/<crate> binary is the fallback for an unbundled `cargo build --release`.
//   Linux   — the bare binary (no bundle indirection).
const TARGET_RELEASE = join(REPO_ROOT, 'apps', 'desktop', 'src-tauri', 'target', 'release')
const CRATE_BIN = 'allmyagents-desktop' // [package].name in apps/desktop/src-tauri/Cargo.toml
const PRODUCT = 'AllMyAgents' // productName in tauri.conf.json
const EXE_CANDIDATES =
  process.platform === 'win32'
    ? [join(TARGET_RELEASE, `${CRATE_BIN}.exe`), join(TARGET_RELEASE, `${PRODUCT}.exe`)]
    : process.platform === 'darwin'
      ? [
          join(TARGET_RELEASE, 'bundle', 'macos', `${PRODUCT}.app`, 'Contents', 'MacOS', PRODUCT),
          join(TARGET_RELEASE, CRATE_BIN),
        ]
      : [join(TARGET_RELEASE, CRATE_BIN)]
const EXE_PATH = EXE_CANDIDATES.find((p) => existsSync(p)) ?? EXE_CANDIDATES[0]

const STAY_ALIVE_MS = 10_000 // how long the process must survive to count as "not a crash"
const ALIVE_POLL_MS = 500
const HUB_TIMEOUT_MS = 25_000 // hub boot (pnpm + node) can be slow on a cold start
const HUB_POLL_MS = 500

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Try a single TCP connect; resolves true if something accepts the connection.
function tryConnect(host, port, timeout) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port })
    let settled = false
    const finish = (ok) => {
      if (settled) return
      settled = true
      sock.destroy()
      resolve(ok)
    }
    sock.setTimeout(timeout)
    sock.once('connect', () => finish(true))
    sock.once('timeout', () => finish(false))
    sock.once('error', () => finish(false))
  })
}

async function waitForHub() {
  const deadline = Date.now() + HUB_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (await tryConnect(HUB_HOST, HUB_PORT, 1000)) return true
    await sleep(HUB_POLL_MS)
  }
  return false
}

// Best-effort teardown of the app and, on Windows, the whole process tree (the app spawns the
// hub through cmd/pnpm, so killing only the top process would orphan node — mirror the app's
// own taskkill /T teardown in lib.rs).
function teardown(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {
      /* ignore */
    }
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      try {
        child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
    }
  }
}

function fail(reason, stderr) {
  console.error(`\nSMOKE FAIL: ${reason}`)
  if (stderr && stderr.trim()) {
    console.error('\n--- captured stderr (tail) ---')
    console.error(stderr.slice(-4000))
    console.error('--- end stderr ---')
  }
  process.exitCode = 1
}

async function main() {
  console.log(`[smoke] repo root: ${REPO_ROOT}`)
  console.log(`[smoke] exe:       ${EXE_PATH}`)

  // 1) binary present?
  if (!existsSync(EXE_PATH)) {
    fail(
      `release binary not found. Build it first: pnpm desktop:build\n` +
        `  looked for:\n${EXE_CANDIDATES.map((p) => `    • ${p}`).join('\n')}`
    )
    return
  }
  console.log('[smoke] release binary found.')

  // 2) launch detached, capturing stderr for diagnostics on failure.
  let stderr = ''
  let spawnError = null
  const child = spawn(EXE_PATH, [], {
    cwd: REPO_ROOT,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stderr?.on('data', (d) => {
    stderr += d.toString()
  })
  child.stdout?.on('data', () => {
    /* drain so the pipe never fills */
  })
  child.once('error', (err) => {
    spawnError = err
  })

  console.log(`[smoke] launched (pid ${child.pid}); watching for ~${STAY_ALIVE_MS / 1000}s...`)

  try {
    // 3) survive the "did it instantly crash?" window.
    for (let waited = 0; waited < STAY_ALIVE_MS; waited += ALIVE_POLL_MS) {
      if (spawnError) {
        fail(`failed to launch the binary: ${spawnError.message}`, stderr)
        return
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        fail(
          `process exited early after ${waited}ms (exitCode=${child.exitCode}, signal=${child.signalCode}) — looks like a startup crash/panic`,
          stderr
        )
        return
      }
      await sleep(ALIVE_POLL_MS)
    }
    console.log('[smoke] process still alive after the watch window (no instant crash).')

    // 4) hub reachable?
    console.log(`[smoke] probing hub on ${HUB_HOST}:${HUB_PORT} (up to ${HUB_TIMEOUT_MS / 1000}s)...`)
    const hubUp = await waitForHub()
    if (!hubUp) {
      fail(`hub never became reachable on ${HUB_HOST}:${HUB_PORT}`, stderr)
      return
    }
    console.log('[smoke] hub is reachable.')

    console.log('\nSMOKE PASS: binary launches, stays alive, and the hub is reachable.')
    process.exitCode = 0
  } finally {
    console.log('[smoke] tearing the app (and its hub) down...')
    teardown(child)
  }
}

main().catch((err) => {
  fail(`unexpected error: ${err?.stack ?? err}`)
})

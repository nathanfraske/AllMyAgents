// updater.svelte.ts — the app-update state shared by the launch banner
// (UpdateBanner.svelte) and Settings → Updates (SettingsModal.svelte).
//
// Access strategy mirrors window.ts: we reach the desktop shell through the
// GLOBAL BRIDGE (`window.__TAURI__`, enabled by `app.withGlobalTauri: true`)
// rather than importing `@tauri-apps/api` or `@tauri-apps/plugin-updater` —
// apps/web depends on neither, and this keeps it that way.
//
// The two commands are OUR OWN Rust commands (apps/desktop/src-tauri/src/lib.rs),
// not the updater plugin's, which is what lets the whole flow stay
// notify-then-consent:
//
//   updater_check   → read-only. Downloads and installs nothing.
//   updater_install → download + SIGNATURE VERIFY + install + relaunch. Only ever
//                     reached from an explicit "Update now" click.
//
// In a plain browser (the mesh view) there is no desktop shell to update, so
// every entry point no-ops and the UI hides itself.

import { inTauri } from './window'
import { settings } from './settings.svelte'

export interface UpdateInfo {
  available: boolean
  currentVersion: string
  version: string
  notes: string | null
  date: string | null
}

interface TauriBridge {
  core?: { invoke?: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> }
}

function invoke<T>(cmd: string): Promise<T> | null {
  const bridge = (globalThis as { __TAURI__?: TauriBridge }).__TAURI__
  const fn = bridge?.core?.invoke
  if (!fn) return null
  return fn<T>(cmd)
}

/** True only in the desktop shell — the mesh/browser view can't update itself. */
export const updatesSupported = inTauri

// localStorage key holding the version the operator explicitly dismissed, so the
// launch banner doesn't nag every start for an update they already said "later"
// to. Checking again (or a NEWER version appearing) still shows it.
const DISMISS_KEY = 'allmyagents.updateDismissed'

/**
 * How often a running app re-checks for a release. Six hours is deliberately unhurried: releases are not
 * frequent, the check is a network round trip the operator did not ask for, and a banner that appears
 * within a few hours of a release is soon enough for an alpha. Short enough that an app left open all
 * week still finds out; long enough that nobody notices it happening.
 */
const RECHECK_MS = 6 * 60 * 60 * 1000

class UpdaterStore {
  /** Latest check result, or null if we've never successfully checked. */
  info = $state<UpdateInfo | null>(null)
  /** A check or an install is in flight. */
  busy = $state(false)
  /** Human-readable failure from the last attempt (offline, no release yet, no signing key). */
  error = $state<string | null>(null)
  /** True once a check has completed at least once this session. */
  checked = $state(false)
  /** Handle for the repeat check, so it can be stopped and cannot be started twice. */
  private timer: ReturnType<typeof setInterval> | null = null
  /** The operator clicked "Later" on this session's banner. */
  dismissed = $state(false)

  /** Show the banner: desktop, an update is available, not dismissed here or previously. */
  get bannerVisible(): boolean {
    if (!updatesSupported || !this.info?.available || this.dismissed) return false
    try {
      return localStorage.getItem(DISMISS_KEY) !== this.info.version
    } catch {
      return true
    }
  }

  /**
   * Ask whether a newer signed build exists. `silent` is the check-on-launch
   * path: it stays quiet about failures (being offline at startup is not an
   * error worth a dialog), where the Settings button surfaces them.
   */
  async check(silent = false): Promise<void> {
    if (!updatesSupported || this.busy) return
    this.busy = true
    if (!silent) this.error = null
    try {
      const p = invoke<UpdateInfo>('updater_check')
      if (!p) return
      this.info = await p
      this.checked = true
      if (!silent) this.error = null
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.checked = true
      if (!silent) this.error = msg
      else console.warn('[updater] launch check failed:', msg)
    } finally {
      this.busy = false
    }
  }

  /**
   * Check on launch AND keep checking, honoring the operator's auto-check setting (default on).
   *
   * WHY THE REPEAT IS NOT OPTIONAL FOR THIS APP. A launch-only check assumes the app is restarted often
   * enough to notice a release. AllMyAgents is the opposite of that by design: it supervises long-running
   * agents, survives its own hub restarts, and is meant to be left open for days. The operator's own
   * install proved the consequence — it had been running 9.4 hours, 0.1.6 shipped during that window, and
   * the app never learned it existed. From the inside that is indistinguishable from a broken updater.
   *
   * Nothing is downloaded or installed here; `check` is read-only and the operator still consents to the
   * install. A dismissed version stays dismissed (bannerVisible compares against DISMISS_KEY), so the
   * repeat surfaces a NEWER release rather than nagging about the one they already declined.
   */
  async checkOnLaunch(): Promise<void> {
    if (!settings.autoCheckUpdates) return
    await this.check(true)
    this.startPeriodicChecks()
  }

  /** Re-check on a slow cadence for as long as the app stays open. Idempotent: safe to call twice. */
  startPeriodicChecks(): void {
    if (!updatesSupported || this.timer !== null) return
    this.timer = setInterval(() => {
      // Re-read the setting each time rather than capturing it: turning auto-check off in Settings should
      // stop the polling that is already running, not just prevent the next app launch from starting it.
      if (!settings.autoCheckUpdates) return
      void this.check(true)
    }, RECHECK_MS)
  }

  stopPeriodicChecks(): void {
    if (this.timer === null) return
    clearInterval(this.timer)
    this.timer = null
  }

  /**
   * CONSENT PATH. Download, verify the signature, install, relaunch. On success
   * this never returns — the shell restarts the app.
   */
  async install(): Promise<void> {
    if (!updatesSupported || this.busy) return
    this.busy = true
    this.error = null
    try {
      const p = invoke<void>('updater_install')
      if (!p) return
      await p
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e)
    } finally {
      this.busy = false
    }
  }

  /** "Later" — hide the banner for this version until a newer one shows up. */
  dismiss(): void {
    this.dismissed = true
    try {
      if (this.info?.version) localStorage.setItem(DISMISS_KEY, this.info.version)
    } catch {
      /* ignore */
    }
  }
}

export const updater = new UpdaterStore()

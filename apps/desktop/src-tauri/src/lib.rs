//! AllMyAgents desktop shell.
//!
//! Wraps the Svelte web UI in a native window and owns the Node hub as a managed
//! child process. The child (and its whole process tree) is torn down on exit.
//!
//! * **Development** (`tauri dev`, debug build): spawns `pnpm hub:dev` from the
//!   repo root — unchanged from the original shell.
//! * **Release** (bundled installer): the installer ships only our compiled hub
//!   and a Node runtime (see `scripts/bundle-hub.mjs`) — NO node_modules and NO
//!   vendor CLIs. On first launch we copy the hub into a writable data dir and
//!   run `npm install` there once, which fetches the runtime deps
//!   (`better-sqlite3`, `@anthropic-ai/claude-code`, `@openai/codex`,
//!   `@anthropic-ai/claude-agent-sdk`, `ws`) from the npm registry onto the
//!   user's machine. A small "installing dependencies" window is shown while
//!   that runs. Later launches detect the deps and skip straight to spawn.
//!   Because the vendor binaries are pulled from npm at runtime (not shipped),
//!   the installer redistributes nothing beyond Node (MIT) and our own code.
//!
//! Two writable roots, and the split is deliberate:
//!
//! * `hub_home()` — `<app_local_data_dir>/hub`: the app's own CODE (staged
//!   `dist/` + the fetched `node_modules`). Regenerable, machine-specific, never
//!   roams, safe to delete.
//! * `app_data_root()` — `%APPDATA%\AllMyAgents`: the OPERATOR'S data —
//!   `data/` (journal, config, worktrees, device token) and `profiles/` (the
//!   managed vendor logins). Passed to the hub as `HUB_DATA_DIR` /
//!   `HUB_PROFILES_DIR` so an installed build never writes into the repo or the
//!   read-only install dir.
//!
//! Both are RELEASE-only. `tauri dev` still spawns `pnpm hubctl:dev` with neither
//! env var set, so a developer checkout keeps using the repo's `data/` +
//! `profiles/` byte-identically to before.

mod browser;

use std::ffi::OsString;
use std::fs;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// Where the desktop shell's diagnostics land, once `init_log` has run.
static LOG_FILE: OnceLock<PathBuf> = OnceLock::new();

/// `<app_local_data_dir>/logs/desktop.log` — beside the hub home, on the local (never-roaming) disk.
pub fn log_path(app: &AppHandle) -> Option<PathBuf> {
    Some(
        app.path()
            .app_local_data_dir()
            .ok()?
            .join("logs")
            .join("desktop.log"),
    )
}

/// Start writing diagnostics to a FILE as well as stderr.
///
/// Everything this shell knows about a failed startup went to `eprintln!`, and a GUI-launched app has no
/// stderr anywhere a person can read — no console on Windows, nothing in Finder. So when two testers'
/// hubs failed to start, the app had already explained why, ten times over, into a void. They could only
/// report "it doesn't work", and there was no way to ask it anything.
///
/// Best-effort throughout: logging must never be the reason startup fails. If the file cannot be opened
/// the shell carries on with stderr alone.
fn init_log(app: &AppHandle) {
    let Some(path) = log_path(app) else { return };
    let _ = fs::create_dir_all(path.parent().unwrap_or(&path));
    // Truncate rather than append past a sane size: this is a startup diagnostic, not an audit trail,
    // and an unbounded log on a machine nobody is watching is its own small bug.
    if fs::metadata(&path)
        .map(|m| m.len() > 2_000_000)
        .unwrap_or(false)
    {
        let _ = fs::remove_file(&path);
    }
    let _ = LOG_FILE.set(path);
    logln(&format!(
        "=== AllMyAgents {} starting — {} ===",
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS
    ));
}

/// Write one diagnostic line to stderr AND (once initialised) the log file.
fn logln(msg: &str) {
    eprintln!("{msg}");
    if let Some(path) = LOG_FILE.get() {
        if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(f, "{msg}");
        }
    }
}

/// WebView2 can lose or wedge only its renderer while the native window and hub remain healthy. Without
/// this callback the UI is completely silent: JavaScript timers, Cancel/Escape handlers, repaint, and
/// even diagnostics all stop together. Record the native failure and reload the main document for the
/// renderer failure classes that WebView2 says are recoverable from the host side.
#[cfg(windows)]
fn install_main_webview_failure_handler(window: &WebviewWindow) -> Result<(), String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2, COREWEBVIEW2_PROCESS_FAILED_KIND,
        COREWEBVIEW2_PROCESS_FAILED_KIND_FRAME_RENDER_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE,
    };
    use webview2_com::ProcessFailedEventHandler;

    window
        .with_webview(move |platform| {
            let outcome = (|| -> windows::core::Result<()> {
                let controller = platform.controller();
                let webview: ICoreWebView2 = unsafe { controller.CoreWebView2()? };
                let mut token = 0_i64;
                unsafe {
                    webview.add_ProcessFailed(
                        &ProcessFailedEventHandler::create(Box::new(move |sender, args| {
                            let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
                            if let Some(args) = args {
                                args.ProcessFailedKind(&mut kind)?;
                            }
                            logln(&format!(
                                "[desktop] main WebView2 process failed (kind={}); renderer recovery requested",
                                kind.0
                            ));
                            if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED
                                || kind
                                    == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE
                                || kind
                                    == COREWEBVIEW2_PROCESS_FAILED_KIND_FRAME_RENDER_PROCESS_EXITED
                            {
                                if let Some(sender) = sender {
                                    sender.Reload()?;
                                }
                            }
                            Ok(())
                        })),
                        &mut token,
                    )?;
                }
                Ok(())
            })();
            if let Err(error) = outcome {
                logln(&format!(
                    "[desktop] could not register the main WebView2 process-failure callback: {error}"
                ));
            }
        })
        .map_err(|error| error.to_string())
}

#[cfg(not(windows))]
fn install_main_webview_failure_handler(_window: &WebviewWindow) -> Result<(), String> {
    Ok(())
}

/// Route the managed hub tree into the same durable startup log as the desktop shell.
///
/// A GUI-launched process has no useful inherited console on Windows or macOS. `hubctl`
/// also passes these handles to its blue/green hub children, so binding both streams here
/// preserves the actual module-link, preflight, and bind failure instead of reducing every
/// child-side startup problem to the desktop's generic readiness timeout.
fn capture_hub_output(cmd: &mut Command) {
    let Some(path) = LOG_FILE.get() else { return };
    let Ok(stdout) = fs::OpenOptions::new().create(true).append(true).open(path) else {
        return;
    };
    let Ok(stderr) = fs::OpenOptions::new().create(true).append(true).open(path) else {
        return;
    };
    cmd.stdout(Stdio::from(stdout)).stderr(Stdio::from(stderr));
}

/// Where the hub listens. Release builds are fixed to the product port. A debug-only override lets the
/// real desktop shell be exercised against an isolated sandbox without ever touching the operator's hub.
fn hub_addr() -> String {
    if cfg!(debug_assertions) {
        if let Ok(value) = std::env::var("AMA_HUB_ADDR") {
            return value;
        }
    }
    "127.0.0.1:7777".to_string()
}

/// Handle to the Node hub. Stored in Tauri's managed state so the run-loop's
/// exit handler can reach it and shut it down. `None` means we never spawned one
/// (already running, spawn failed, or first-run setup is still in progress).
struct HubProcess(Mutex<Option<Child>>);

/// What is (or isn't) on the hub port.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum HubProbe {
    /// OUR hub answered `/api/health` with the shape our hub returns. Don't spawn a second one.
    Ours,
    /// Nothing is listening — safe to spawn.
    Vacant,
    /// Something answered a TCP connect but is NOT our hub: a foreign service, a hung previous hub,
    /// or an orphaned process still holding the port. We cannot bind 7777 over it, and it is not the
    /// hub, so it must never be mistaken for one — see `probe_hub` and `release_boot`.
    Foreign,
}

/// Probe 127.0.0.1:7777 and decide whether OUR hub is there.
///
/// A bare TCP connect is not proof of a hub. The old check treated any successful connect as "the hub
/// is up" and skipped spawning — so a foreign service on the port, a hung previous hub, or an orphaned
/// process still accepting connections all made the app silently wire itself to a stranger with no hub
/// of its own and no sign to the user. So we speak HTTP: GET `/api/health` and require the JSON our hub
/// returns (apps/hub/src/server.ts — a `boot` state plus a `schemaVersion`). Anything else — connection
/// refused, no/garbled response, non-2xx, unparseable body, or the wrong shape — is NOT our hub.
///
/// A booting green answers 200 with `boot:"booting"`; that is still our hub, so it counts as `Ours`.
fn probe_hub() -> HubProbe {
    let Ok(addr) = hub_addr().parse::<SocketAddr>() else {
        return HubProbe::Vacant;
    };
    let mut stream = match TcpStream::connect_timeout(&addr, Duration::from_millis(500)) {
        Ok(s) => s,
        Err(_) => return HubProbe::Vacant, // connection refused / nothing listening
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(1500)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(1500)));
    // Minimal HTTP/1.0 request. `Host` MUST be loopback or the hub's DNS-rebinding guard 403s us
    // (server.ts hostAllowed); `Connection: close` makes the server end the body with EOF so a single
    // read-to-end gets the whole response.
    let req = "GET /api/health HTTP/1.0\r\nHost: 127.0.0.1\r\nAccept: application/json\r\nConnection: close\r\n\r\n";
    if stream.write_all(req.as_bytes()).is_err() {
        return HubProbe::Foreign; // connected but won't take the request — not a healthy hub
    }
    let mut buf = Vec::new();
    if stream.read_to_end(&mut buf).is_err() && buf.is_empty() {
        return HubProbe::Foreign; // connected then said nothing (or timed out with no bytes)
    }
    let text = String::from_utf8_lossy(&buf);
    let body = if let Some(i) = text.find("\r\n\r\n") {
        &text[i + 4..]
    } else if let Some(i) = text.find("\n\n") {
        &text[i + 2..]
    } else {
        return HubProbe::Foreign; // no header/body boundary — not an HTTP response we understand
    };
    if !text.lines().next().unwrap_or("").contains(" 200") {
        return HubProbe::Foreign;
    }
    match serde_json::from_str::<serde_json::Value>(body.trim()) {
        Ok(v) if v.get("schemaVersion").is_some() && v.get("boot").is_some() => HubProbe::Ours,
        _ => HubProbe::Foreign,
    }
}

/// Readiness predicate for the post-spawn wait: true only once OUR hub is answering health.
fn hub_health_ok() -> bool {
    matches!(probe_hub(), HubProbe::Ours)
}

/// Put a spawned child in its OWN process group on POSIX (macOS/Linux) so the exit handler can tear
/// the WHOLE tree down with a single process-group signal — see `kill_hub`. Windows has `taskkill /T`
/// to walk the PID tree; POSIX has no equivalent, so the group has to be set up at spawn time.
///
/// No-op on Windows, where `CREATE_NEW_PROCESS_GROUP` would also detach the console and is not needed.
#[cfg(unix)]
fn set_own_group(cmd: &mut Command) {
    use std::os::unix::process::CommandExt;
    cmd.process_group(0);
}
#[cfg(not(unix))]
fn set_own_group(_cmd: &mut Command) {}

/// Windows: start the child WITHOUT allocating a console window.
///
/// The desktop shell is a GUI app with no console of its own, so every console child it launches gets a
/// fresh black window — the hub, and then the agent worker and vendor CLIs beneath it. They flash up and
/// sit there for the whole session, in front of the app, looking like something is wrong. There is no
/// setting to hide them after the fact; it has to be requested at spawn time.
///
/// CREATE_NO_WINDOW (0x0800_0000) suppresses the console without detaching the process, so the PID-tree
/// teardown in `kill_hub` still works exactly as before. It is deliberately NOT CREATE_NEW_PROCESS_GROUP,
/// which would also break that teardown.
#[cfg(windows)]
fn hide_console(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
}
#[cfg(not(windows))]
fn hide_console(_cmd: &mut Command) {}

// ---------------------------------------------------------------------------
// Dev path — spawn `pnpm hub:dev` from the source tree. UNCHANGED.
// ---------------------------------------------------------------------------

/// Spawn `pnpm hub:dev` from the repo root. DEV ONLY: the repo root is located at
/// compile time via `CARGO_MANIFEST_DIR` (`apps/desktop/src-tauri`) walked up
/// three levels — correct for `tauri dev` on a developer's machine, invalid for a
/// shipped bundle (which uses the release path below instead).
/// Value for `HUB_WORKER` on the hub we spawn.
///
/// Worker mode (docs/agent-worker-impl.md) ships **ON** per docs/alpha-release-plan.md: hubctl then spawns
/// the agent worker as a SIBLING that outlives the hub, so a live agent turn — and its sub-agents — survive
/// a hub restart (blue-green update or crash) instead of dying with the process. That is what makes the app
/// safely repairable while in use. Proven end-to-end by `pnpm accept:restart`.
///
/// An explicit operator setting always wins, so `HUB_WORKER=0` still runs the legacy in-process path.
/// NOTE: worker mode is entered when hubctl STARTS — a running hub cannot grow a worker, so the first
/// launch after this change is a normal (cold) start; every restart after it is survivable.
fn hub_worker_flag() -> String {
    std::env::var("HUB_WORKER").unwrap_or_else(|_| "1".to_string())
}

fn spawn_hub_dev(browser_secret: &str, browser_address: &str) -> Option<Child> {
    let hub_addr = hub_addr();
    match probe_hub() {
        HubProbe::Ours => {
            logln(&format!(
                "[desktop] our hub already answering on {hub_addr} — not spawning a second one"
            ));
            return None;
        }
        HubProbe::Foreign => {
            // Something holds the port but it is not our hub. Spawning would only fail to bind, so
            // don't — say why in the log (a dev has a terminal to read it) and let them free the port.
            logln(&format!(
                "[desktop] {hub_addr} is occupied by something that is not our hub — not spawning. Stop the other process (or `pnpm hubctl:dev` already running) and retry."
            ));
            return None;
        }
        HubProbe::Vacant => {}
    }

    // apps/desktop/src-tauri  ->  ../  ../  ../  =>  repo root
    let repo_root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..");

    // `pnpm` on Windows is a `.cmd` shim, so it must be launched through cmd.exe;
    // invoking it directly with std::process fails. On Unix we exec pnpm directly.
    let mut cmd = if cfg!(windows) {
        let mut c = Command::new("cmd");
        c.args(["/C", "pnpm", "hubctl:dev"]);
        c
    } else {
        let mut c = Command::new("pnpm");
        c.args(["hubctl:dev"]);
        c
    };
    cmd.current_dir(&repo_root);
    cmd.env("HUB_WORKER", hub_worker_flag()); // live turns survive a hub restart (see hub_worker_flag)
    if let Some((_, port)) = hub_addr.rsplit_once(':') {
        cmd.env("HUB_FIXED_PORT", port);
    }
    if let Ok(data_dir) = std::env::var("AMA_HUB_DATA_DIR") {
        cmd.env("HUB_DATA_DIR", data_dir);
    }
    cmd.env("AMA_DESKTOP_BROWSER_SECRET", browser_secret);
    cmd.env("AMA_DESKTOP_BROWSER_ADDR", browser_address);
    set_own_group(&mut cmd); // POSIX: own process group so kill_hub can group-signal the whole tree
    hide_console(&mut cmd); // Windows: no stray black console window in front of the app

    match cmd.spawn() {
        Ok(child) => {
            logln(&format!(
                "[desktop] spawned hub via `pnpm hubctl:dev` (pid {}) in {}",
                child.id(),
                repo_root.display()
            ));
            Some(child)
        }
        Err(e) => {
            logln(&format!(
                "[desktop] could not spawn hub ({e}); continuing. Run `pnpm hubctl:dev` yourself if the UI can't reach {hub_addr}."
            ));
            None
        }
    }
}

// ---------------------------------------------------------------------------
// Release path — materialize + first-run install + spawn the bundled hub.
// ---------------------------------------------------------------------------

fn node_exe_name() -> &'static str {
    if cfg!(windows) {
        "node.exe"
    } else {
        "node"
    }
}

/// Build a PATH value with `dirs` prepended to the inherited PATH. Cross-platform
/// (uses the OS path separator via `join_paths`).
fn prepend_path(dirs: &[PathBuf]) -> OsString {
    let mut paths: Vec<PathBuf> = dirs.iter().map(|p| plain(p)).collect();
    if let Some(existing) = std::env::var_os("PATH") {
        paths.extend(std::env::split_paths(&existing));
    }
    std::env::join_paths(paths).unwrap_or_default()
}

/// Strip Windows' verbatim `\\?\` prefix before a path is handed to a NON-RUST child process.
///
/// THIS IS WHY THE HUB NEVER STARTED ON WINDOWS. Tauri's `resource_dir()` / `app_local_data_dir()` go
/// through Rust's `canonicalize`, which returns verbatim paths — `\\?\C:\Program Files\AllMyAgents\…`.
/// Rust handles those fine, so everything on our side looked correct, and macOS has no such prefix so
/// every macOS test passed. Node does NOT handle them: given a `\\?\`-prefixed script path it misparses
/// the root and dies with
///
/// ```text
/// Error: EISDIR: illegal operation on a directory, lstat 'C:'
///     at resolveMainPath
/// ```
///
/// which is what a real tester's install produced. It hit BOTH child spawns — the first-run
/// `npm-cli.js` and the `hubctl.js` that is the hub itself — so on Windows the app could never get a hub
/// no matter how healthy everything else was.
///
/// The failure was invisible for two compounding reasons: nothing writes a log file, so the message went
/// to a stderr no GUI user has; and the npm branch reported ANY non-zero exit as "an internet connection
/// is required", so the one clue that did surface blamed the user's network for a path bug.
///
/// `\\?\UNC\server\share` maps back to `\\server\share`; a plain `\\?\C:\…` loses the prefix. Anything
/// without the prefix is returned unchanged, so this is a no-op on macOS and Linux.
fn plain(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        return PathBuf::from(rest.to_string());
    }
    p.to_path_buf()
}

/// Recursively copy `src` into `dst` (creating `dst`). Plain files + dirs only —
/// our payload has no symlinks.
fn copy_dir(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let to = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &to)?;
        } else {
            fs::copy(entry.path(), &to)?;
        }
    }
    Ok(())
}

/// The read-only hub payload shipped inside the app bundle
/// (`<resource_dir>/hub-runtime/apps/hub`, containing `dist/` + `package.json`).
fn payload_hub_dir(app: &AppHandle) -> Option<PathBuf> {
    Some(
        app.path()
            .resource_dir()
            .ok()?
            .join("hub-runtime")
            .join("apps")
            .join("hub"),
    )
}

/// The bundled Node directory (`<resource_dir>/hub-runtime/node`, holds node(.exe)
/// and `node_modules/npm`).
fn bundled_node_dir(app: &AppHandle) -> Option<PathBuf> {
    Some(
        app.path()
            .resource_dir()
            .ok()?
            .join("hub-runtime")
            .join("node"),
    )
}

/// Writable "hub home" that holds the app's own CODE: the staged `apps/hub/dist`
/// plus the `apps/hub/node_modules` the first-run `npm install` creates
/// (`<app_local_data_dir>/hub`). Machine-specific and fully regenerable, which is
/// why it lives in LOCAL app data (never roams) and why the operator's data does
/// NOT live here — see `app_data_root`.
///
/// The hub derives its `repoRoot` as three levels up from its own `dist/` dir, so
/// the entry must live at `<home>/apps/hub/dist/index.js`.
fn hub_home(app: &AppHandle) -> Option<PathBuf> {
    Some(app.path().app_local_data_dir().ok()?.join("hub"))
}

/// The per-user APP-DATA root for an installed build — `%APPDATA%\AllMyAgents` on
/// Windows, `~/Library/Application Support/AllMyAgents` on macOS,
/// `~/.local/share/AllMyAgents` on Linux (docs/alpha-release-plan.md).
///
/// This is where the OPERATOR'S data lives: the journal + config + worktrees
/// (`data/`) and the managed vendor profiles with their credentials
/// (`profiles/`). Deliberately product-named rather than identifier-named so it is
/// findable by a human doing a backup or a credential scrub, and deliberately
/// separate from `hub_home` so wiping/reinstalling the regenerable hub code can
/// never take the operator's chats and logins with it.
///
/// RELEASE ONLY. The dev path (`spawn_hub_dev`) sets neither env var, so a
/// developer checkout keeps using the repo's `data/` + `profiles/` exactly as
/// before — see `materialize_app_data`.
fn app_data_root(app: &AppHandle) -> Option<PathBuf> {
    // `data_dir()` is the OS per-user data root (%APPDATA% on Windows). Fall back
    // to the identifier-scoped app dir if the OS root can't be resolved.
    let base = app
        .path()
        .data_dir()
        .ok()
        .map(|d| d.join("AllMyAgents"))
        .or_else(|| app.path().app_data_dir().ok())?;
    Some(base)
}

/// Return the local hub's device capability to this app's own webview.
///
/// This IPC command replaces the old unauthenticated `/api/mesh` bootstrap. The webview cannot read
/// arbitrary files, while the native shell already owns the exact data root it gives the hub. A short
/// wait covers first launch, where the webview can mount just before the hub creates its token.
#[cfg(desktop)]
#[tauri::command]
fn hub_device_token(app: AppHandle) -> Result<String, String> {
    let token_path = if cfg!(debug_assertions) && std::env::var_os("AMA_HUB_DATA_DIR").is_some() {
        PathBuf::from(std::env::var_os("AMA_HUB_DATA_DIR").expect("checked above"))
            .join("device-token.txt")
    } else if cfg!(debug_assertions) {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("..")
            .join("data")
            .join("device-token.txt")
    } else {
        app_data_root(&app)
            .ok_or_else(|| "could not resolve the AllMyAgents data directory".to_string())?
            .join("data")
            .join("device-token.txt")
    };

    for _ in 0..100 {
        if let Ok(token) = fs::read_to_string(&token_path) {
            let token = token.trim().to_string();
            if token.len() >= 32 {
                return Ok(token);
            }
        }
        thread::sleep(Duration::from_millis(50));
    }
    Err(format!(
        "hub device token was not ready at {}",
        token_path.display()
    ))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct OverseerDiagnostics {
    status: Option<serde_json::Value>,
    status_path: String,
    log_tail: String,
}

/// Read the supervisor's bounded, journal-independent Overseer breadcrumb. This stays available to the
/// bundled webview even when no hub is listening and SQLite/account caches were never opened.
#[cfg(desktop)]
#[tauri::command]
fn overseer_diagnostics(app: AppHandle) -> Result<OverseerDiagnostics, String> {
    let data_dir = if cfg!(debug_assertions) && std::env::var_os("AMA_HUB_DATA_DIR").is_some() {
        PathBuf::from(std::env::var_os("AMA_HUB_DATA_DIR").expect("checked above"))
    } else if cfg!(debug_assertions) {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("..")
            .join("data")
    } else {
        app_data_root(&app)
            .ok_or_else(|| "could not resolve the AllMyAgents data directory".to_string())?
            .join("data")
    };
    let status_path = data_dir.join("overseer-supervisor.json");
    let status = fs::read_to_string(&status_path)
        .ok()
        .filter(|text| text.len() <= 64 * 1024)
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok());
    let log_tail = log_path(&app)
        .and_then(|path| fs::read(path).ok())
        .map(|bytes| {
            let start = bytes.len().saturating_sub(16 * 1024);
            String::from_utf8_lossy(&bytes[start..]).to_string()
        })
        .unwrap_or_default();
    Ok(OverseerDiagnostics {
        status,
        status_path: status_path.display().to_string(),
        log_tail,
    })
}

/// Resolve an operator-clicked transcript path without letting the webview pass a relative target,
/// a nonexistent path, or an unbounded argument into an OS process.
#[cfg(desktop)]
fn canonical_reveal_path(raw: &str) -> Result<PathBuf, String> {
    let value = raw.trim();
    if value.is_empty() || value.len() > 4_096 || value.contains('\0') {
        return Err("invalid local path".to_string());
    }
    let path = PathBuf::from(value);
    if !path.is_absolute() {
        return Err("only absolute local paths can be revealed".to_string());
    }
    fs::canonicalize(&path)
        .map_err(|error| format!("the local path does not exist or cannot be resolved: {error}"))
}

#[cfg(all(desktop, windows))]
fn shell_reveal_path(path: &Path) -> Result<(), String> {
    // canonicalize() returns extended-length paths on Windows. Explorer's CLI is more reliable with
    // the ordinary drive/UNC spelling, so remove only that syntactic prefix before passing one argv.
    let value = path.to_string_lossy();
    let explorer_path = if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = value.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        path.to_path_buf()
    };
    let mut command = Command::new("explorer.exe");
    if path.is_file() {
        command.arg("/select,");
    }
    command.arg(explorer_path);
    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("could not open the Windows file manager: {error}"))
}

#[cfg(all(desktop, target_os = "macos"))]
fn shell_reveal_path(path: &Path) -> Result<(), String> {
    let mut command = Command::new("/usr/bin/open");
    if path.is_file() {
        command.arg("-R");
    }
    command
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("could not open Finder: {error}"))
}

#[cfg(all(desktop, unix, not(target_os = "macos")))]
fn shell_reveal_path(path: &Path) -> Result<(), String> {
    let target = if path.is_file() {
        path.parent()
            .ok_or_else(|| "the file has no containing directory".to_string())?
    } else {
        path
    };
    Command::new("xdg-open")
        .arg(target)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("could not open the file manager: {error}"))
}

/// Reveal a file or directory in the operator's native file manager. This deliberately never opens
/// the target itself, never invokes a shell, and is reachable only through an explicit transcript click.
#[cfg(desktop)]
#[tauri::command]
fn reveal_local_path(path: String) -> Result<(), String> {
    shell_reveal_path(&canonical_reveal_path(&path)?)
}

/// First-run materialization of the app-data layout: create
/// `<app_data_root>/data` and `<app_data_root>/profiles` and hand back the pair to
/// pass to the hub as `HUB_DATA_DIR` / `HUB_PROFILES_DIR` (apps/hub/src/index.ts).
///
/// Both are created EMPTY. The bundle ships no profile and therefore no
/// credential (scripts/bundle-hub.mjs enforces that); the operator's first login
/// in the app creates `profiles/<id>` here, on their own machine.
///
/// Passing the vars explicitly — instead of relying on the hub's "three levels up
/// from dist/" derivation — is the whole point: it pins the installed app's data
/// to a per-user location that is never the repo and never the (read-only,
/// Program Files) install dir, whatever the process cwd happens to be.
fn materialize_app_data(app: &AppHandle) -> std::io::Result<(PathBuf, PathBuf)> {
    let root = app_data_root(app).ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "could not resolve the per-user app-data directory",
        )
    })?;
    let data = root.join("data");
    let profiles = root.join("profiles");
    fs::create_dir_all(&data)?;
    fs::create_dir_all(&profiles)?;
    Ok((data, profiles))
}

/// The install marker: present + matching the shipped manifest ⇒ deps are ready.
fn deps_marker(dest_hub: &Path) -> PathBuf {
    dest_hub.join("node_modules").join(".ama-deps-ok")
}

fn deps_marker_want(app: &AppHandle, manifest: &str) -> String {
    format!(
        "allmyagents-desktop={}\nmanifest-bytes={}\n{}",
        app.package_info().version,
        manifest.len(),
        manifest
    )
}

const MAX_REPAIR_ATTEMPTS: u8 = 2;

#[derive(Debug, Default, Eq, PartialEq)]
struct RepairState {
    fingerprint: String,
    attempts: u8,
}

impl RepairState {
    fn record_attempt(&mut self, fingerprint: &str) {
        if self.fingerprint != fingerprint {
            self.fingerprint = fingerprint.to_string();
            self.attempts = 0;
        }
        self.attempts = self.attempts.saturating_add(1);
    }
}

#[derive(Debug, Eq, PartialEq)]
enum RepairDecision {
    Allowed,
    Blocked,
}

fn repair_decision(state: &RepairState, fingerprint: &str) -> RepairDecision {
    if state.fingerprint == fingerprint && state.attempts >= MAX_REPAIR_ATTEMPTS {
        RepairDecision::Blocked
    } else {
        RepairDecision::Allowed
    }
}

fn repair_fingerprint(want: &str) -> String {
    format!("{:x}", Sha256::digest(want.as_bytes()))
}

fn repair_state_path(dest_hub: &Path) -> PathBuf {
    dest_hub.join(".ama-dependency-repair")
}

fn read_repair_state(dest_hub: &Path) -> RepairState {
    let Ok(text) = fs::read_to_string(repair_state_path(dest_hub)) else {
        return RepairState::default();
    };
    let mut lines = text.lines();
    let fingerprint = lines.next().unwrap_or_default().to_string();
    let attempts = lines
        .next()
        .and_then(|v| v.parse::<u8>().ok())
        .unwrap_or_default();
    RepairState {
        fingerprint,
        attempts,
    }
}

fn write_repair_state(dest_hub: &Path, state: &RepairState) -> std::io::Result<()> {
    let path = repair_state_path(dest_hub);
    let mut file = fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(path)?;
    write!(file, "{}\n{}\n", state.fingerprint, state.attempts)?;
    file.sync_all()
}

fn clear_repair_state(dest_hub: &Path) {
    if let Err(error) = fs::remove_file(repair_state_path(dest_hub)) {
        if error.kind() != std::io::ErrorKind::NotFound {
            logln(&format!(
                "[desktop] could not clear dependency repair state: {error}"
            ));
        }
    }
}

fn redact_url_credentials(line: &str) -> String {
    let mut redacted = line.to_string();
    let mut search_from = 0;
    while let Some(scheme_offset) = redacted[search_from..].find("://") {
        let authority_start = search_from + scheme_offset + 3;
        let authority_end = redacted[authority_start..]
            .find(['/', '\\', '?', '#', ' ', '\t'])
            .map(|offset| authority_start + offset)
            .unwrap_or(redacted.len());
        let Some(at_offset) = redacted[authority_start..authority_end].find('@') else {
            search_from = authority_end;
            continue;
        };
        let at = authority_start + at_offset;
        redacted.replace_range(authority_start..at, "[redacted]");
        search_from = authority_start + "[redacted]@".len();
    }
    redacted
}

fn sanitize_npm_diagnostic(diagnostic: &str) -> String {
    diagnostic
        .lines()
        .map(|line| {
            let lower = line.to_ascii_lowercase();
            if lower.contains("_authtoken") || lower.contains("_auth=") {
                "[redacted npm credential line]".to_string()
            } else {
                redact_url_credentials(line)
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn npm_diagnostic(output: &Output) -> String {
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let combined = sanitize_npm_diagnostic(&format!("{}\n{}", stdout.trim(), stderr.trim()));
    combined
        .chars()
        .rev()
        .take(8_000)
        .collect::<String>()
        .chars()
        .rev()
        .collect()
}

fn npm_reported_network_failure(diagnostic: &str) -> bool {
    let diagnostic = diagnostic.to_ascii_lowercase();
    [
        "code enetwork",
        "code eai_again",
        "code enotfound",
        "code etimedout",
        "code enetunreach",
        "code esockettimedout",
        "code econnreset",
        "code econnrefused",
        "code econnaborted",
        "network request to",
        "network timeout at",
    ]
    .iter()
    .any(|needle| diagnostic.contains(needle))
}

fn npm_install_failure_message(code: i32, diagnostic: &str, log: &Path) -> String {
    if npm_reported_network_failure(diagnostic) {
        format!(
            "AllMyAgents could not download its hub dependencies because npm reported a network failure (exit {code}). Check your internet connection, firewall, or npm registry access, then reopen the app. Full details are in {}.",
            log.display()
        )
    } else {
        format!(
            "AllMyAgents could not install its hub dependencies (npm exit {code}). This was not identified as a network failure. See the actual npm error in {}.",
            log.display()
        )
    }
}

fn repair_blocked_message(hub_home: &Path, log: &Path) -> String {
    format!(
        "Automatic dependency repair failed twice and is now paused, so AllMyAgents will not reinstall on every launch. See the failure details in {}. To retry deliberately, close AllMyAgents and rename or remove the regenerable hub directory at {}, then reopen the app. Your chats, projects, worktrees, and profiles are stored separately and are not removed.",
        log.display(),
        hub_home.display()
    )
}

/// Cheap pre-check (run on the main thread) so we only pop the setup window when a
/// first-run (or post-update) `npm install` is actually needed.
fn release_needs_install(app: &AppHandle) -> bool {
    let want = payload_hub_dir(app)
        .map(|p| fs::read_to_string(p.join("package.json")).unwrap_or_default())
        .unwrap_or_default();
    if want.is_empty() {
        return true;
    }
    let have = hub_home(app)
        .map(|h| fs::read_to_string(deps_marker(&h.join("apps").join("hub"))).unwrap_or_default())
        .unwrap_or_default();
    deps_marker_want(app, &want) != have
}

fn run_npm_install(
    node_cmd: &Path,
    npm_cli: &Path,
    node_dir: &Path,
    dest_hub: &Path,
) -> std::io::Result<Output> {
    Command::new(node_cmd)
        .arg(plain(npm_cli))
        .args([
            "install",
            "--omit=dev",
            "--no-audit",
            "--no-fund",
            "--loglevel=error",
        ])
        .current_dir(plain(dest_hub))
        .env("PATH", prepend_path(&[node_dir.to_path_buf()]))
        .output()
}

/// Load the hub's own production entry with the bundled Node. Verification mode stops before touching
/// operator data or opening a port, but only after the real ESM graph links and better-sqlite3 executes
/// an in-memory query.
fn verify_hub_dependencies(
    node_cmd: &Path,
    node_dir: &Path,
    dest_hub: &Path,
) -> Result<(), String> {
    let entry = dest_hub.join("dist").join("index.js");
    let output = Command::new(node_cmd)
        .arg(plain(&entry))
        .current_dir(plain(dest_hub))
        .env("PATH", prepend_path(&[node_dir.to_path_buf()]))
        .env("AMA_VERIFY_HUB_DEPS", "1")
        .output()
        .map_err(|e| format!("could not run dependency verification: {e}"))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let tail = stderr
        .chars()
        .rev()
        .take(2000)
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>();
    Err(format!(
        "dependency verification exited {}: {}",
        output.status,
        tail.trim()
    ))
}

/// Minimal base64 (no dependency) for embedding the splash HTML in a data: URL.
fn base64(input: &[u8]) -> String {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(T[(n >> 18 & 63) as usize] as char);
        out.push(T[(n >> 12 & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            T[(n >> 6 & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            T[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}

/// Shared splash/error styling. The spinner is hidden in the error state, so the same page serves both
/// the "installing…" splash and a fatal "no hub" message.
const SPLASH_CSS: &str = r#"html,body{margin:0;height:100%;font-family:'Segoe UI',system-ui,sans-serif;background:#1b1d22;color:#e7e9ee;display:flex;align-items:center;justify-content:center}
.box{text-align:center;padding:28px 36px;max-width:420px}
.spin{width:34px;height:34px;border:3px solid #3a3f4b;border-top-color:#6ea8fe;border-radius:50%;margin:0 auto 18px;animation:r .9s linear infinite}
@keyframes r{to{transform:rotate(360deg)}}
h1{font-size:15px;font-weight:600;margin:0 0 8px}
p{font-size:12.5px;color:#a7adba;margin:0;line-height:1.55}
body[data-state=error] .spin{display:none}
body[data-state=error] h1{color:#ff8a8a}"#;

/// Minimal HTML escaping for text baked straight into the splash page (a message can carry a path or a
/// child's exit string — neither is trusted to be markup-safe).
fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// Build the splash/error page with its message baked in. Baking (rather than eval'ing after load) is
/// what lets `make_error_window` show text on a window the instant it is created, with no DOM-ready race.
fn splash_page(error: bool, heading: &str, sub: &str) -> String {
    format!(
        r#"<!doctype html><html><head><meta charset="utf-8"><style>{css}</style></head><body{state}>
<div class="box"><div class="spin" id="spin"></div>
<h1 id="msg">{heading}</h1>
<p id="sub">{sub}</p></div></body></html>"#,
        css = SPLASH_CSS,
        state = if error { r#" data-state="error""# } else { "" },
        heading = html_escape(heading),
        sub = html_escape(sub),
    )
}

/// Best-effort setup window shown while the first-run install runs.
fn make_splash(app: &AppHandle) -> Option<WebviewWindow> {
    let html = splash_page(
        false,
        "First-run setup — installing dependencies…",
        "This happens once and needs an internet connection. It may take a minute.",
    );
    let url = format!("data:text/html;base64,{}", base64(html.as_bytes()));
    WebviewWindowBuilder::new(app, "setup", WebviewUrl::External(url.parse().ok()?))
        .title("AllMyAgents — first-run setup")
        .inner_size(480.0, 260.0)
        .center()
        .resizable(false)
        .always_on_top(true)
        .build()
        .ok()
}

/// Standalone error window for the no-splash case. A normal launch (deps already installed) shows no
/// setup window, so a hub that fails to come up then would have nowhere to report it — the same silent
/// "no hub, no explanation" state that hid the Windows path bug from two testers. The message is baked
/// into the page rather than eval'd so it is visible the moment the window opens.
fn make_error_window(app: &AppHandle, msg: &str) -> Option<WebviewWindow> {
    let html = splash_page(true, msg, "Close this window, then reopen AllMyAgents.");
    let url = format!("data:text/html;base64,{}", base64(html.as_bytes()));
    WebviewWindowBuilder::new(app, "hub-error", WebviewUrl::External(url.parse().ok()?))
        .title("AllMyAgents — hub could not start")
        .inner_size(480.0, 260.0)
        .center()
        .resizable(false)
        .always_on_top(true)
        .build()
        .ok()
}

/// Flip the splash into an error state (keeps the window open + closeable so the
/// user can read the message), and log it.
fn splash_error(splash: &Option<WebviewWindow>, msg: &str) {
    logln(&format!("[desktop] setup error: {msg}"));
    if let Some(w) = splash {
        let js = format!(
            "document.body.setAttribute('data-state','error');\
             var m=document.getElementById('msg');if(m)m.textContent={msg:?};\
             var s=document.getElementById('sub');if(s)s.textContent='Note the message above, fix the reported problem, then reopen AllMyAgents.';"
        );
        let _ = w.eval(&js);
    }
}

/// Surface a fatal "no hub" boot failure so it can NEVER fail silently — the invisible failure is
/// precisely what made the earlier hub-startup bugs unreportable. Flip the setup window to its error
/// state if one is up (first run), otherwise open a standalone error window (a normal launch has none).
/// Always logs via `splash_error`/`logln`.
fn boot_error(app: &AppHandle, splash: &Option<WebviewWindow>, msg: &str) {
    if splash.is_some() {
        splash_error(splash, msg);
    } else {
        logln(&format!("[desktop] boot error: {msg}"));
        let _ = make_error_window(app, msg);
    }
}

/// The release boot sequence, run on a background thread so the UI stays
/// responsive while `npm install` runs.
fn release_boot(
    app: AppHandle,
    splash: Option<WebviewWindow>,
    browser_secret: String,
    browser_address: String,
) {
    let hub_addr = hub_addr();
    // Reachability guard — prove what is on the port before deciding, and never spawn a second hub.
    match probe_hub() {
        HubProbe::Ours => {
            logln(&format!(
                "[desktop] our hub already answering on {hub_addr} — not spawning"
            ));
            if let Some(w) = &splash {
                let _ = w.close();
            }
            return;
        }
        HubProbe::Foreign => {
            // The port is taken by something that is not our hub (a leftover/hung hub, an orphaned
            // process still accepting, or an unrelated service). We cannot bind 7777 over it, so
            // spawning would only fail to bind — and silently carrying on would wire the app to a
            // stranger that answers on the hub's port. Neither is honest. Tell the user and stop.
            boot_error(
                &app,
                &splash,
                &format!(
                    "Another program is using {hub_addr}, which AllMyAgents needs for its hub. Close whatever is using it (or restart your computer), then reopen AllMyAgents. Details are in the log: {}",
                    log_path(&app).map(|p| p.display().to_string()).unwrap_or_else(|| "(no log)".into())
                ),
            );
            return;
        }
        HubProbe::Vacant => {}
    }

    // Resolve the shipped payload + bundled Node, and the writable hub home.
    let (payload_hub, node_dir, home) = match (
        payload_hub_dir(&app),
        bundled_node_dir(&app),
        hub_home(&app),
    ) {
        (Some(a), Some(b), Some(c)) => (a, b, c),
        _ => {
            boot_error(
                &app,
                &splash,
                "Could not resolve the app's resource or data directory.",
            );
            return;
        }
    };
    // Prefer the bundled Node; fall back to a system `node` on PATH if missing.
    let node = node_dir.join(node_exe_name());
    let node_cmd = if node.exists() {
        node
    } else {
        PathBuf::from(node_exe_name())
    };
    let npm_cli = node_dir
        .join("node_modules")
        .join("npm")
        .join("bin")
        .join("npm-cli.js");

    let dest_hub = home.join("apps").join("hub");
    if let Err(e) = fs::create_dir_all(&dest_hub) {
        boot_error(
            &app,
            &splash,
            &format!("Could not create the data directory: {e}"),
        );
        return;
    }

    // Copy our code out of (read-only) resources into the writable data dir so the
    // hub — and the node_modules the install creates next to it — live together.
    let _ = fs::remove_dir_all(dest_hub.join("dist"));
    if let Err(e) = copy_dir(&payload_hub.join("dist"), &dest_hub.join("dist")) {
        boot_error(&app, &splash, &format!("Could not stage the hub: {e}"));
        return;
    }
    if let Err(e) = fs::copy(
        payload_hub.join("package.json"),
        dest_hub.join("package.json"),
    ) {
        boot_error(
            &app,
            &splash,
            &format!("Could not stage the hub manifest: {e}"),
        );
        return;
    }
    // THE LOCKFILE HAS TO TRAVEL WITH THE MANIFEST, or pinning the manifest is cosmetic.
    //
    // The first-run install below runs plain `npm install` in this staged directory, and npm only honours
    // a lockfile that is sitting next to the package.json it is installing. Pin the direct dependencies
    // without shipping the lock and the TRANSITIVE graph is still resolved fresh on each user's machine at
    // whatever moment they happen to install — which is the bug being fixed, just one level down and
    // harder to see.
    //
    // Best-effort by design: a payload with no lockfile still installs (unpinned, as before) rather than
    // refusing to start. bundle-hub.mjs asserts the lockfile made the payload, so a build that forgets it
    // fails there — where a developer is watching — instead of here, on a user's first launch.
    let lock = payload_hub.join("package-lock.json");
    if lock.exists() {
        if let Err(e) = fs::copy(&lock, dest_hub.join("package-lock.json")) {
            logln(&format!(
                "[desktop] could not stage the lockfile ({e}); install will resolve unpinned"
            ));
        }
    } else {
        logln("[desktop] no lockfile in the payload — dependency versions will resolve unpinned");
    }

    // A marker is version-aware and means "this app verified this tree", not "npm exited zero".
    // Even a matching marker gets a live check so later corruption cannot persist indefinitely.
    let manifest = fs::read_to_string(dest_hub.join("package.json")).unwrap_or_default();
    let want = deps_marker_want(&app, &manifest);
    let marker = deps_marker(&dest_hub);
    let have = fs::read_to_string(&marker).unwrap_or_default();
    if manifest.is_empty() {
        boot_error(
            &app,
            &splash,
            "The shipped hub manifest is missing or empty.",
        );
        return;
    }

    let log = log_path(&app).unwrap_or_else(|| PathBuf::from("(no log path available)"));
    let fingerprint = repair_fingerprint(&want);
    let mut repair_state = read_repair_state(&dest_hub);
    let mut install_needed = have != want;
    let mut repair_mode = false;
    if !install_needed {
        match verify_hub_dependencies(&node_cmd, &node_dir, &dest_hub) {
            Ok(()) => {
                logln("[desktop] persisted hub dependencies verified");
                clear_repair_state(&dest_hub);
            }
            Err(e) => {
                if repair_decision(&repair_state, &fingerprint) == RepairDecision::Blocked {
                    boot_error(&app, &splash, &repair_blocked_message(&home, &log));
                    return;
                }
                repair_state.record_attempt(&fingerprint);
                if let Err(state_error) = write_repair_state(&dest_hub, &repair_state) {
                    boot_error(
                        &app,
                        &splash,
                        &format!(
                            "AllMyAgents found broken hub dependencies but could not safely record the repair limit ({state_error}). No repair was attempted. See {}.",
                            log.display()
                        ),
                    );
                    return;
                }
                logln(&format!(
                    "[desktop] persisted dependencies are broken; repair attempt {}/{}: {e}",
                    repair_state.attempts, MAX_REPAIR_ATTEMPTS
                ));
                install_needed = true;
                repair_mode = true;
                let _ = fs::remove_file(&marker);
                if let Err(remove_error) = fs::remove_dir_all(dest_hub.join("node_modules")) {
                    if remove_error.kind() != std::io::ErrorKind::NotFound {
                        boot_error(
                            &app,
                            &splash,
                            &format!(
                                "Could not clear broken hub dependencies: {remove_error}. See {}.",
                                log.display()
                            ),
                        );
                        return;
                    }
                }
            }
        }
    } else if repair_state.fingerprint == fingerprint && repair_state.attempts > 0 {
        // A prior repair died after its marker was removed. It is still a repair on the next launch;
        // treating it as a fresh install here is the loop that used to reinstall forever.
        if repair_decision(&repair_state, &fingerprint) == RepairDecision::Blocked {
            boot_error(&app, &splash, &repair_blocked_message(&home, &log));
            return;
        }
        repair_state.record_attempt(&fingerprint);
        if let Err(state_error) = write_repair_state(&dest_hub, &repair_state) {
            boot_error(
                &app,
                &splash,
                &format!(
                    "AllMyAgents could not safely record the repair limit ({state_error}). No repair was attempted. See {}.",
                    log.display()
                ),
            );
            return;
        }
        repair_mode = true;
        let _ = fs::remove_file(&marker);
        if let Err(remove_error) = fs::remove_dir_all(dest_hub.join("node_modules")) {
            if remove_error.kind() != std::io::ErrorKind::NotFound {
                boot_error(
                    &app,
                    &splash,
                    &format!(
                        "Could not clear broken hub dependencies: {remove_error}. See {}.",
                        log.display()
                    ),
                );
                return;
            }
        }
    }
    if install_needed {
        loop {
            if repair_mode {
                logln(&format!(
                    "[desktop] installing clean hub dependencies (repair attempt {}/{MAX_REPAIR_ATTEMPTS}) via bundled npm",
                    repair_state.attempts
                ));
            } else {
                logln("[desktop] installing hub dependencies via bundled npm");
            }

            let output = match run_npm_install(&node_cmd, &npm_cli, &node_dir, &dest_hub) {
                Ok(output) => output,
                Err(e) => {
                    boot_error(
                        &app,
                        &splash,
                        &format!("Could not run the bundled npm: {e}. See {}.", log.display()),
                    );
                    return;
                }
            };
            if !output.status.success() {
                let diagnostic = npm_diagnostic(&output);
                logln(&format!(
                    "[desktop] npm install failed ({}):\n{}",
                    output.status, diagnostic
                ));
                let message = if repair_mode
                    && repair_decision(&repair_state, &fingerprint) == RepairDecision::Blocked
                {
                    repair_blocked_message(&home, &log)
                } else {
                    npm_install_failure_message(
                        output.status.code().unwrap_or(-1),
                        &diagnostic,
                        &log,
                    )
                };
                boot_error(&app, &splash, &message);
                return;
            }

            match verify_hub_dependencies(&node_cmd, &node_dir, &dest_hub) {
                Ok(()) => break,
                Err(verify_error) => {
                    logln(&format!(
                        "[desktop] installed tree failed verification: {verify_error}"
                    ));
                    if repair_decision(&repair_state, &fingerprint) == RepairDecision::Blocked {
                        boot_error(&app, &splash, &repair_blocked_message(&home, &log));
                        return;
                    }

                    repair_state.record_attempt(&fingerprint);
                    if let Err(state_error) = write_repair_state(&dest_hub, &repair_state) {
                        boot_error(
                            &app,
                            &splash,
                            &format!(
                                "The installed dependencies failed verification, but AllMyAgents could not safely record the repair limit ({state_error}). No repair was attempted. See {}.",
                                log.display()
                            ),
                        );
                        return;
                    }
                    repair_mode = true;
                    logln(&format!(
                        "[desktop] clean reinstall scheduled (repair attempt {}/{MAX_REPAIR_ATTEMPTS})",
                        repair_state.attempts
                    ));
                    let _ = fs::remove_file(&marker);
                    if let Err(remove_error) = fs::remove_dir_all(dest_hub.join("node_modules")) {
                        if remove_error.kind() != std::io::ErrorKind::NotFound {
                            boot_error(
                                &app,
                                &splash,
                                &format!(
                                    "Could not clear the failed dependency tree: {remove_error}. See {}.",
                                    log.display()
                                ),
                            );
                            return;
                        }
                    }
                }
            }
        }

        clear_repair_state(&dest_hub);
        if let Err(e) = fs::write(&marker, &want) {
            boot_error(
                &app,
                &splash,
                &format!(
                    "Dependencies verified, but readiness could not be recorded: {e}. See {}.",
                    log.display()
                ),
            );
            return;
        }
        logln("[desktop] hub dependencies installed and verified");
    }

    // First-run app-data materialization: journal/config/worktrees + managed
    // profiles go to the per-user app-data root, NEVER the repo or the install dir.
    let (hub_data_dir, hub_profiles_dir) = match materialize_app_data(&app) {
        Ok(pair) => pair,
        Err(e) => {
            boot_error(
                &app,
                &splash,
                &format!("Could not create the app-data directory: {e}"),
            );
            return;
        }
    };
    logln(&format!(
        "[desktop] app data: HUB_DATA_DIR={} HUB_PROFILES_DIR={}",
        hub_data_dir.display(),
        hub_profiles_dir.display()
    ));
    let testbed_bundle_dir = app
        .path()
        .resource_dir()
        .ok()
        .map(|root| root.join("testbed-runtime"));

    // Spawn the hub with the bundled Node. PATH carries the hub's own .bin (so the
    // codex adapter's `codex app-server` shell lookup resolves) and the bundled
    // Node dir (so the codex .bin shim's `node` fallback resolves).
    let bin_dir = dest_hub.join("node_modules").join(".bin");
    let entry = dest_hub.join("dist").join("hubctl.js");
    let mut cmd = Command::new(&node_cmd);
    // `plain()` on every path that crosses into Node: a verbatim \\?\ prefix makes node misparse the
    // script path and die before it runs a line of our code. See plain().
    cmd.arg(plain(&entry))
        .current_dir(plain(&home))
        .env("PATH", prepend_path(&[bin_dir, node_dir]))
        .env("HUB_WORKER", hub_worker_flag()) // live turns survive a hub restart (see hub_worker_flag)
        // hubctl forwards its whole env to every hub it supervises (blue AND green),
        // so setting these here pins the data + profile roots across restarts too.
        .env("HUB_DATA_DIR", &hub_data_dir)
        .env("HUB_PROFILES_DIR", &hub_profiles_dir)
        .env("AMA_DESKTOP_BROWSER_SECRET", &browser_secret)
        .env("AMA_DESKTOP_BROWSER_ADDR", &browser_address);
    if let Some(bundle_dir) = testbed_bundle_dir.filter(|candidate| candidate.is_dir()) {
        cmd.env("ALLMYAGENTS_TESTBED_BUNDLE_DIR", plain(&bundle_dir));
    }
    set_own_group(&mut cmd); // POSIX: own process group so kill_hub can group-signal the whole tree
    hide_console(&mut cmd); // Windows: no stray black console window in front of the app
    capture_hub_output(&mut cmd);
    match cmd.spawn() {
        Ok(child) => {
            logln(&format!(
                "[desktop] spawned bundled hub (pid {}) — {}",
                child.id(),
                entry.display()
            ));
            if let Some(state) = app.try_state::<HubProcess>() {
                if let Ok(mut g) = state.0.lock() {
                    *g = Some(child);
                }
            }
        }
        Err(e) => {
            boot_error(&app, &splash, &format!("Could not start the hub: {e}"));
            return;
        }
    }

    // Spawning is not the same as running. A hub that starts and then dies during module linking (a bad
    // native addon, a missing dep) — or one whose port got taken between the guard above and here, so it
    // exits on EADDRINUSE — would otherwise leave the app looking fine with no hub behind it. So don't
    // assert success, VERIFY it: poll /api/health until OUR hub answers, the child exits, or we time out,
    // and route every not-ready outcome through the visible error path with the log location. This runs
    // on the release_boot worker thread, so the wait blocks nothing on the UI thread.
    let deadline = Instant::now() + Duration::from_secs(60);
    let mut ready = false;
    let mut exited: Option<String> = None;
    while Instant::now() < deadline {
        if hub_health_ok() {
            ready = true;
            break;
        }
        // Fail fast if the child is already gone rather than waiting out the whole timeout.
        if let Some(state) = app.try_state::<HubProcess>() {
            if let Ok(mut g) = state.0.lock() {
                if let Some(child) = g.as_mut() {
                    if let Ok(Some(status)) = child.try_wait() {
                        exited = Some(status.to_string());
                        break;
                    }
                }
            }
        }
        thread::sleep(Duration::from_millis(300));
    }
    if ready {
        if let Some(w) = &splash {
            let _ = w.close();
        }
        return;
    }
    let log_hint = log_path(&app)
        .map(|p| p.display().to_string())
        .unwrap_or_else(|| "(no log)".into());
    let detail = match exited {
        Some(status) => format!("The hub started but exited before it was ready ({status})."),
        None => "The hub started but did not become ready in time.".to_string(),
    };
    boot_error(
        &app,
        &splash,
        &format!("{detail} Its log may say why: {log_hint}"),
    );
}

// ---------------------------------------------------------------------------
// Auto-updater — notify-then-consent, NEVER a silent install.
//
// Design (docs/alpha-release-plan.md "Auto-updater"): the Tauri v2 updater pulls
// `latest.json` straight off the GitHub release page and verifies a minisign
// signature before it will install anything (it is a code-exec path). The whole
// interaction is driven from Rust and exposed to the web UI as two ordinary
// commands, so apps/web needs NO new npm dependency — it reaches them through the
// same `window.__TAURI__` global bridge it already uses for the window controls
// (apps/web/src/lib/updater.svelte.ts).
//
// The updater IS configured: `tauri.conf.json` carries a real
// `plugins.updater.pubkey` and `bundle.createUpdaterArtifacts` is true. (This
// comment used to say the opposite — placeholder pubkey, artifacts off — and was
// simply left behind when the key landed, which is worse than no comment, because
// it is the note a reader would trust.)
//
// Consequence worth knowing: with `createUpdaterArtifacts` true, `tauri build`
// FAILS without TAURI_SIGNING_PRIVATE_KEY. A keyless checkout needs
//     --config '{"bundle":{"createUpdaterArtifacts":false}}'
// No key, public or private, is committed to this repo. If the updater is ever
// unconfigured again, `updater_check` reports that state as a plain error string
// which the UI shows verbatim rather than failing silently.
// ---------------------------------------------------------------------------

/// What the UI needs to decide whether to prompt. `available: false` means "you
/// are up to date"; the other fields are then just the running version.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateInfo {
    available: bool,
    current_version: String,
    version: String,
    notes: Option<String>,
    date: Option<String>,
}

/// Ask the release endpoint whether a newer signed build exists. Read-only: it
/// downloads and installs NOTHING. Errors (offline, endpoint 404 because no
/// release exists yet, missing/placeholder pubkey) come back as a string the UI
/// renders as-is instead of a silent failure.
#[cfg(desktop)]
#[tauri::command]
async fn updater_check(app: AppHandle) -> Result<UpdateInfo, String> {
    use tauri_plugin_updater::UpdaterExt;
    let current = app.package_info().version.to_string();
    let updater = app.updater().map_err(|e| {
        format!("Updater is not configured yet ({e}). An updater signing key has to be generated and its public key pasted into tauri.conf.json before updates can be checked — see docs/alpha-cut-checklist.md.")
    })?;
    match updater.check().await {
        Ok(Some(update)) => Ok(UpdateInfo {
            available: true,
            current_version: current,
            version: update.version.clone(),
            notes: update.body.clone(),
            date: update.date.map(|d| d.to_string()),
        }),
        Ok(None) => Ok(UpdateInfo {
            available: false,
            current_version: current.clone(),
            version: current,
            notes: None,
            date: None,
        }),
        Err(e) => Err(format!("Could not check for updates: {e}")),
    }
}

/// Download + verify + install the available update, then relaunch. Only ever
/// called from an explicit "Update now" click — there is no code path that
/// reaches this without the operator consenting. The signature check happens
/// inside `download`; a bad signature fails before the running hub is touched.
///
/// Windows is intentionally split into download → quiesce → install. The
/// updater plugin's NSIS path calls `std::process::exit(0)` immediately after it
/// starts the installer, bypassing Tauri's Exit event. Relying on that event to
/// kill the hub therefore leaves the installed `hub-runtime/node/node.exe`
/// mapped while NSIS tries to replace it.
#[cfg(desktop)]
#[tauri::command]
async fn updater_install(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app
        .updater()
        .map_err(|e| format!("Updater is not configured yet ({e})."))?;
    let update = updater
        .check()
        .await
        .map_err(|e| format!("Could not check for updates: {e}"))?
        .ok_or_else(|| "No update is available.".to_string())?;
    let bytes = update
        .download(|_chunk, _total| {}, || {})
        .await
        .map_err(|e| format!("Could not download or verify the update: {e}"))?;
    quiesce_for_update(&app)?;
    update
        .install(bytes)
        .map_err(|e| format!("Could not start the verified update: {e}"))?;
    // The hub child is torn down by the Exit handler in `run()` before the process
    // goes away on platforms whose updater returns. Windows exits from inside
    // `install`, after `quiesce_for_update` has already released the runtime.
    app.restart()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct UpdateReleaseFailure {
    port_occupied: bool,
    runtime_locked: bool,
}

/// Poll a pair of independent updater preconditions. Keeping the loop injectable
/// makes the dangerous condition testable: a released file does not excuse a
/// live hub port, and a vacant port does not excuse a mapped executable.
fn wait_for_update_release_with<P, R, S>(
    attempts: usize,
    mut port_is_vacant: P,
    mut runtime_is_writable: R,
    mut pause: S,
) -> Result<(), UpdateReleaseFailure>
where
    P: FnMut() -> bool,
    R: FnMut() -> bool,
    S: FnMut(),
{
    let attempts = attempts.max(1);
    let mut last = UpdateReleaseFailure {
        port_occupied: true,
        runtime_locked: true,
    };
    for attempt in 0..attempts {
        last = UpdateReleaseFailure {
            port_occupied: !port_is_vacant(),
            runtime_locked: !runtime_is_writable(),
        };
        if !last.port_occupied && !last.runtime_locked {
            return Ok(());
        }
        if attempt + 1 < attempts {
            pause();
        }
    }
    Err(last)
}

fn hub_port_is_vacant() -> bool {
    let Ok(addr) = hub_addr().parse::<SocketAddr>() else {
        return false;
    };
    TcpStream::connect_timeout(&addr, Duration::from_millis(150)).is_err()
}

/// Prove the installed runtime can be replaced without changing a byte. Windows
/// executable mappings reject this exclusive ReadWrite open with a sharing
/// violation; FileShare::None mirrors the release gate and NSIS's replacement
/// precondition.
fn runtime_is_exclusively_writable(path: &Path) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        fs::OpenOptions::new()
            .read(true)
            .write(true)
            .share_mode(0)
            .open(path)
            .is_ok()
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        true
    }
}

#[cfg(windows)]
fn normalized_windows_path(path: &Path) -> String {
    plain(path)
        .to_string_lossy()
        .replace('/', "\\")
        .trim_start_matches(r"\\?\")
        .to_lowercase()
}

#[cfg(windows)]
fn process_image_path(pid: u32) -> Option<PathBuf> {
    use std::os::windows::ffi::OsStringExt;
    use windows::core::PWSTR;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };

    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?;
    let mut buffer = vec![0u16; 32_768];
    let mut length = buffer.len() as u32;
    let result = unsafe {
        QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_WIN32,
            PWSTR(buffer.as_mut_ptr()),
            &mut length,
        )
    };
    let _ = unsafe { CloseHandle(process) };
    result
        .is_ok()
        .then(|| PathBuf::from(OsString::from_wide(&buffer[..length as usize])))
}

/// Return only processes executing the exact bundled runtime. Matching the full
/// image path is the safety boundary: an operator's unrelated system Node must
/// never be included.
#[cfg(windows)]
fn runtime_processes(path: &Path) -> Vec<u32> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    let target = normalized_windows_path(path);
    let Ok(snapshot) = (unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }) else {
        return Vec::new();
    };
    let mut entry = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    let mut matches = Vec::new();
    let mut more = unsafe { Process32FirstW(snapshot, &mut entry) }.is_ok();
    while more {
        let pid = entry.th32ProcessID;
        if process_image_path(pid).is_some_and(|image| normalized_windows_path(&image) == target) {
            matches.push(pid);
        }
        more = unsafe { Process32NextW(snapshot, &mut entry) }.is_ok();
    }
    let _ = unsafe { CloseHandle(snapshot) };
    matches
}

#[cfg(not(windows))]
fn runtime_processes(_path: &Path) -> Vec<u32> {
    Vec::new()
}

/// Restart Manager can identify a file holder even when querying its executable
/// path is denied. This is diagnostic only: shutdown remains restricted to
/// exact-path bundled Node processes.
#[cfg(windows)]
fn runtime_lock_holders(path: &Path) -> Vec<String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Foundation::{ERROR_MORE_DATA, ERROR_SUCCESS};
    use windows::Win32::System::RestartManager::{
        RmEndSession, RmGetList, RmRegisterResources, RmStartSession, CCH_RM_SESSION_KEY,
        RM_PROCESS_INFO,
    };

    let mut session = 0u32;
    let mut key = vec![0u16; CCH_RM_SESSION_KEY as usize + 1];
    if unsafe { RmStartSession(&mut session, None, PWSTR(key.as_mut_ptr())) } != ERROR_SUCCESS {
        return Vec::new();
    }
    let wide_path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let files = [PCWSTR(wide_path.as_ptr())];
    if unsafe { RmRegisterResources(session, Some(&files), None, None) } != ERROR_SUCCESS {
        let _ = unsafe { RmEndSession(session) };
        return Vec::new();
    }

    let mut needed = 0u32;
    let mut count = 0u32;
    let mut reasons = 0u32;
    let first = unsafe { RmGetList(session, &mut needed, &mut count, None, &mut reasons) };
    let mut holders = Vec::new();
    if first == ERROR_MORE_DATA && needed > 0 {
        let mut info = vec![RM_PROCESS_INFO::default(); needed as usize];
        count = needed;
        if unsafe {
            RmGetList(
                session,
                &mut needed,
                &mut count,
                Some(info.as_mut_ptr()),
                &mut reasons,
            )
        } == ERROR_SUCCESS
        {
            holders.extend(info.into_iter().take(count as usize).map(|process| {
                let end = process
                    .strAppName
                    .iter()
                    .position(|c| *c == 0)
                    .unwrap_or(process.strAppName.len());
                let name = String::from_utf16_lossy(&process.strAppName[..end]);
                if name.is_empty() {
                    format!("PID {}", process.Process.dwProcessId)
                } else {
                    format!("{name} (PID {})", process.Process.dwProcessId)
                }
            }));
        }
    }
    let _ = unsafe { RmEndSession(session) };
    holders
}

#[cfg(not(windows))]
fn runtime_lock_holders(_path: &Path) -> Vec<String> {
    Vec::new()
}

#[cfg(windows)]
fn terminate_runtime_processes(path: &Path) {
    let target = normalized_windows_path(path);
    for pid in runtime_processes(path) {
        // A PID can be recycled after the snapshot. Re-check the image at the
        // last possible moment so a newly-created unrelated process can never
        // be swept merely because it inherited a stale number.
        if !process_image_path(pid).is_some_and(|image| normalized_windows_path(&image) == target) {
            continue;
        }
        logln(&format!(
            "[desktop] updater stopping orphaned bundled-runtime process {pid} ({})",
            path.display()
        ));
        let mut command = Command::new("taskkill");
        command.args(["/PID", &pid.to_string(), "/T", "/F"]);
        hide_console(&mut command);
        match command.output() {
            Ok(output) if output.status.success() => {}
            Ok(output) => logln(&format!(
                "[desktop] updater could not stop bundled-runtime PID {pid}: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            )),
            Err(error) => logln(&format!(
                "[desktop] updater could not invoke taskkill for bundled-runtime PID {pid}: {error}"
            )),
        }
    }
}

#[cfg(not(windows))]
fn terminate_runtime_processes(_path: &Path) {}

/// Stop everything that can keep the installed runtime mapped, then prove both
/// the network endpoint and file handle are released. Failure returns to the UI
/// before the verified installer is started, leaving the current install intact.
fn quiesce_for_update(app: &AppHandle) -> Result<(), String> {
    let runtime = bundled_node_dir(app)
        .map(|dir| dir.join(node_exe_name()))
        .ok_or_else(|| {
            "Update was not started because the bundled runtime path could not be resolved."
                .to_string()
        })?;
    if !runtime.exists() {
        return Err(format!(
            "Update was not started because the bundled runtime is missing: {}",
            runtime.display()
        ));
    }

    let owned = app
        .try_state::<HubProcess>()
        .and_then(|state| state.0.lock().ok()?.take());
    if let Some(mut child) = owned {
        logln("[desktop] updater quiescing the shell-owned hub tree");
        kill_hub(&mut child);
    }
    terminate_runtime_processes(&runtime);

    let release = wait_for_update_release_with(
        80,
        hub_port_is_vacant,
        || runtime_is_exclusively_writable(&runtime),
        || thread::sleep(Duration::from_millis(125)),
    );
    if let Err(failure) = release {
        let port = if failure.port_occupied {
            match probe_hub() {
                HubProbe::Ours => {
                    format!("the AllMyAgents hub is still answering on {}", hub_addr())
                }
                HubProbe::Foreign => format!("another process is still using {}", hub_addr()),
                HubProbe::Vacant => format!("{} did not release consistently", hub_addr()),
            }
        } else {
            format!("{} is vacant", hub_addr())
        };
        let exact_pids = runtime_processes(&runtime);
        let holders = runtime_lock_holders(&runtime);
        let file = if failure.runtime_locked {
            if !holders.is_empty() {
                format!("{} is held by {}", runtime.display(), holders.join(", "))
            } else if !exact_pids.is_empty() {
                format!(
                    "{} is still held by PID(s) {}",
                    runtime.display(),
                    exact_pids
                        .iter()
                        .map(u32::to_string)
                        .collect::<Vec<_>>()
                        .join(", ")
                )
            } else {
                format!(
                    "Windows still denies exclusive write access to {}, but did not identify the holder",
                    runtime.display()
                )
            }
        } else {
            format!("{} is writable", runtime.display())
        };
        let message = format!(
            "Update was not started because the running hub could not be stopped safely: {port}; {file}. The current installation is unchanged. Close the named process or restart Windows, then retry."
        );
        logln(&format!("[desktop] updater quiesce failed: {message}"));
        return Err(message);
    }

    logln(&format!(
        "[desktop] updater quiesce complete: {} vacant and {} exclusively writable",
        hub_addr(),
        runtime.display()
    ));
    Ok(())
}

/// Remove a macOS install without involving the hub. A detached helper waits for this process to exit
/// before deleting the running bundle; operator data is preserved unless the UI passes the explicit
/// opt-in. The regenerable identifier-scoped hub home is always removed.
#[cfg(desktop)]
#[tauri::command]
fn uninstall_macos(app: AppHandle, remove_user_data: bool) -> Result<(), String> {
    // No `return` here: with the macOS arm below cfg'd out, this block IS the tail expression on every
    // other platform, and an explicit return trips clippy::needless_return — which is a hard error under
    // the `-D warnings` gate that CI runs on Windows.
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, remove_user_data);
        Err("In-app uninstall is currently available on macOS only.".to_string())
    }
    #[cfg(target_os = "macos")]
    {
        let exe = std::env::current_exe()
            .map_err(|e| format!("could not locate the running app: {e}"))?;
        let bundle = exe
            .parent()
            .and_then(Path::parent)
            .and_then(Path::parent)
            .ok_or_else(|| "could not resolve the application bundle".to_string())?
            .to_path_buf();
        if bundle.extension().and_then(|s| s.to_str()) != Some("app") {
            return Err(format!(
                "refusing to remove unexpected bundle path {}",
                bundle.display()
            ));
        }
        let hub_root = app
            .path()
            .app_local_data_dir()
            .map_err(|e| format!("could not resolve the regenerable hub directory: {e}"))?;
        let user_root = app_data_root(&app)
            .ok_or_else(|| "could not resolve the AllMyAgents user-data directory".to_string())?;
        let pid = std::process::id().to_string();
        let script = r#"
pid="$1"; bundle="$2"; hub="$3"; user_data="$4"; purge="$5"
while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
rm -rf -- "$bundle" "$hub"
for launcher in /usr/local/bin/allmyagents "$HOME/.local/bin/allmyagents" /opt/homebrew/bin/allmyagents; do
  if [ -f "$launcher" ] && grep -qF "generated by the AllMyAgents installer" "$launcher" 2>/dev/null; then
    rm -f -- "$launcher"
  fi
done
if [ "$purge" = 1 ]; then rm -rf -- "$user_data"; fi
"#;
        let mut helper = Command::new("/bin/sh");
        helper
            .arg("-c")
            .arg(script)
            .arg("allmyagents-uninstall")
            .arg(&pid)
            .arg(&bundle)
            .arg(&hub_root)
            .arg(&user_root)
            .arg(if remove_user_data { "1" } else { "0" })
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        set_own_group(&mut helper);
        helper
            .spawn()
            .map_err(|e| format!("could not start the uninstall helper: {e}"))?;
        logln(&format!(
            "[desktop] uninstall scheduled; operator data {}",
            if remove_user_data {
                "will be deleted"
            } else {
                "will be kept"
            }
        ));
        app.exit(0);
        Ok(())
    }
}

/// Best-effort teardown of the hub child and its whole process tree. The child is spawned in its own
/// process group (`set_own_group`), which is what makes the POSIX branch below able to reach the
/// descendants at all.
fn kill_hub(child: &mut Child) {
    let pid = child.id();
    // Windows: the child spawned a tree of its own (pnpm→node→hubctl→hub→codex app-server); killing
    // just the parent orphans all of it, because Windows has no kill-on-parent-death. `taskkill /T /F`
    // walks the PID tree and terminates the lot.
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .output();
    }
    // POSIX (macOS/Linux) has no kill-on-parent-death either, and no `taskkill /T`. Signal the child's
    // process GROUP instead — `kill(-pgid, …)`, the group id being the pid of the leader we spawned.
    //
    // SIGTERM FIRST, deliberately: hubctl installs a SIGTERM handler whose teardown group-kills each
    // hub and the agent worker (which run in their OWN groups — see spawnHub/killTree in hubctl.ts, so
    // they are NOT in this group and a single signal here would miss them). Give it a moment to do
    // that, then SIGKILL this group as the backstop for a hubctl that hung or ignored the term.
    #[cfg(unix)]
    {
        let pgid = pid as i32;
        unsafe {
            libc::kill(-pgid, libc::SIGTERM);
        }
        thread::sleep(Duration::from_millis(1500));
        unsafe {
            libc::kill(-pgid, libc::SIGKILL);
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    logln(&format!("[desktop] hub (pid {pid}) torn down"));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        // Native OS file/folder dialogs and opening external links in the browser.
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init());

    // Auto-updater — desktop only. Registering the plugin does not contact the
    // network; nothing is checked until the UI calls `updater_check`.
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            updater_check,
            updater_install,
            uninstall_macos,
            hub_device_token,
            overseer_diagnostics,
            reveal_local_path
        ]);

    builder
        .setup(|app| {
            // FIRST thing, before anything can fail: without this every startup diagnostic goes to a
            // stderr that a GUI-launched app does not have, which is how two testers' hubs failed with
            // no recoverable explanation.
            init_log(&app.handle().clone());
            if let Some(main_window) = app.get_webview_window("main") {
                if let Err(error) = install_main_webview_failure_handler(&main_window) {
                    logln(&format!(
                        "[desktop] could not install the main renderer-failure handler: {error}"
                    ));
                }
            } else {
                logln(
                    "[desktop] main window was unavailable while installing renderer diagnostics",
                );
            }
            app.manage(HubProcess(Mutex::new(None)));
            let browser_bridge = match browser::start(app.handle().clone()) {
                Ok(bridge) => bridge,
                Err(error) => {
                    logln(&format!(
                        "[browser] unavailable; the desktop app will continue without it: {error}"
                    ));
                    browser::BrowserBridge {
                        address: String::new(),
                        secret: String::new(),
                    }
                }
            };

            if cfg!(debug_assertions) {
                // Dev: spawn `pnpm hub:dev` synchronously, as before.
                let child = spawn_hub_dev(&browser_bridge.secret, &browser_bridge.address);
                if let Some(state) = app.try_state::<HubProcess>() {
                    if let Ok(mut g) = state.0.lock() {
                        *g = child;
                    }
                }
            } else {
                // Release: materialize + (first-run) install + spawn on a worker
                // thread so setup() returns and the UI renders immediately. Show
                // the setup window only when an install is actually pending.
                let handle = app.handle().clone();
                let splash = if release_needs_install(&handle) {
                    make_splash(&handle)
                } else {
                    None
                };
                thread::spawn(move || {
                    release_boot(
                        handle,
                        splash,
                        browser_bridge.secret,
                        browser_bridge.address,
                    )
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the AllMyAgents desktop application")
        .run(|app_handle, event| {
            // Tear the hub down when the app exits so we don't leak node processes.
            if let RunEvent::Exit = event {
                if let Some(state) = app_handle.try_state::<HubProcess>() {
                    if let Ok(mut guard) = state.0.lock() {
                        if let Some(mut child) = guard.take() {
                            kill_hub(&mut child);
                        }
                    }
                }
            }
        });
}

#[cfg(test)]
mod dependency_repair_tests {
    use super::*;

    #[test]
    fn two_failed_repairs_block_another_install_and_name_recovery_paths() {
        let mut state = RepairState::default();
        state.record_attempt("manifest-a");
        state.record_attempt("manifest-a");

        assert_eq!(
            repair_decision(&state, "manifest-a"),
            RepairDecision::Blocked
        );

        let message = repair_blocked_message(
            Path::new(r"C:\Users\tester\AppData\Local\direct.cec.allmyagents\hub"),
            Path::new(r"C:\Users\tester\AppData\Local\direct.cec.allmyagents\logs\desktop.log"),
        );
        assert!(message.contains("failed twice"));
        assert!(message.contains("desktop.log"));
        assert!(message.contains(r"direct.cec.allmyagents\hub"));
    }

    #[test]
    fn npm_errors_only_blame_the_network_when_the_diagnostic_supports_it() {
        let log =
            Path::new(r"C:\Users\tester\AppData\Local\direct.cec.allmyagents\logs\desktop.log");
        let offline = npm_install_failure_message(
            1,
            "npm error code ENETWORK\nnpm error network request failed",
            log,
        );
        assert!(offline.to_ascii_lowercase().contains("internet"));
        assert!(offline.contains("desktop.log"));

        let path_bug = npm_install_failure_message(
            1,
            "Error: EISDIR: illegal operation on a directory, lstat 'C:'",
            log,
        );
        assert!(!path_bug.to_ascii_lowercase().contains("internet"));
        assert!(path_bug.contains("not identified as a network failure"));
        assert!(path_bug.contains("desktop.log"));
    }

    #[test]
    fn npm_diagnostics_written_to_desktop_log_redact_credentials() {
        let diagnostic = sanitize_npm_diagnostic(
            "npm error fetch https://build-user:secret@registry.example.test/pkg\n//registry.example.test/:_authToken=also-secret",
        );
        assert!(diagnostic.contains("https://[redacted]@registry.example.test/pkg"));
        assert!(diagnostic.contains("[redacted npm credential line]"));
        assert!(!diagnostic.contains("secret"));
        assert!(!diagnostic.contains("build-user"));
    }

    #[test]
    fn repair_guard_is_scoped_to_the_broken_payload() {
        let mut state = RepairState::default();
        state.record_attempt("manifest-a");
        state.record_attempt("manifest-a");
        assert_eq!(
            repair_decision(&state, "manifest-a"),
            RepairDecision::Blocked
        );
        assert_eq!(
            repair_decision(&state, "manifest-b"),
            RepairDecision::Allowed
        );
    }

    #[test]
    fn repair_attempts_survive_a_process_restart() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock is after epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "allmyagents-repair-state-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&root).expect("create isolated repair-state fixture");

        let mut state = RepairState::default();
        state.record_attempt("manifest-a");
        write_repair_state(&root, &state).expect("persist repair state");

        assert_eq!(read_repair_state(&root), state);
        fs::remove_dir_all(&root).expect("remove isolated repair-state fixture");
    }
}

#[cfg(all(test, desktop))]
mod local_file_reveal_tests {
    use super::*;

    #[test]
    fn reveal_target_must_be_absolute_and_exist() {
        assert!(canonical_reveal_path("relative/file.txt").is_err());
        assert!(canonical_reveal_path("").is_err());
        assert!(canonical_reveal_path("/tmp/a\0b").is_err());

        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock is after epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "allmyagents-reveal-test-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&root).expect("create isolated reveal fixture");
        let resolved = canonical_reveal_path(root.to_str().expect("UTF-8 fixture path"))
            .expect("resolve existing absolute directory");
        assert!(resolved.is_absolute());
        assert!(resolved.is_dir());
        fs::remove_dir_all(&root).expect("remove isolated reveal fixture");
    }
}

#[cfg(test)]
mod updater_quiesce_tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn updater_waits_until_both_the_hub_port_and_runtime_are_released() {
        let attempts = Cell::new(0usize);
        let result = wait_for_update_release_with(
            4,
            || {
                let attempt = attempts.get();
                attempt >= 2
            },
            || {
                let attempt = attempts.get();
                attempts.set(attempt + 1);
                attempt >= 3
            },
            || {},
        );

        assert_eq!(result, Ok(()));
        assert_eq!(attempts.get(), 4);
    }

    #[test]
    fn updater_refuses_to_install_while_the_hub_is_still_listening() {
        let result = wait_for_update_release_with(1, || false, || true, || {});

        assert_eq!(
            result,
            Err(UpdateReleaseFailure {
                port_occupied: true,
                runtime_locked: false,
            })
        );
    }

    #[test]
    fn updater_refuses_to_install_while_the_runtime_is_still_locked() {
        let result = wait_for_update_release_with(1, || true, || false, || {});

        assert_eq!(
            result,
            Err(UpdateReleaseFailure {
                port_occupied: false,
                runtime_locked: true,
            })
        );
    }
}

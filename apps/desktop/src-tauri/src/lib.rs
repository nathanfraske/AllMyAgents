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

use std::ffi::OsString;
use std::fs;
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::io::Write;
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// Where the desktop shell's diagnostics land, once `init_log` has run.
static LOG_FILE: OnceLock<PathBuf> = OnceLock::new();

/// `<app_local_data_dir>/logs/desktop.log` — beside the hub home, on the local (never-roaming) disk.
pub fn log_path(app: &AppHandle) -> Option<PathBuf> {
    Some(app.path().app_local_data_dir().ok()?.join("logs").join("desktop.log"))
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
    if fs::metadata(&path).map(|m| m.len() > 2_000_000).unwrap_or(false) {
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

/// Where the hub listens. Kept in one place so the reachability probe and the
/// spawn paths agree.
const HUB_ADDR: &str = "127.0.0.1:7777";

/// Handle to the Node hub. Stored in Tauri's managed state so the run-loop's
/// exit handler can reach it and shut it down. `None` means we never spawned one
/// (already running, spawn failed, or first-run setup is still in progress).
struct HubProcess(Mutex<Option<Child>>);

/// Is the hub already listening? If so we don't spawn a second one — the user may
/// be running `pnpm hub:dev` in their own terminal, or a prior instance is alive.
fn hub_already_running() -> bool {
    match HUB_ADDR.parse::<SocketAddr>() {
        Ok(addr) => TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok(),
        Err(_) => false,
    }
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

fn spawn_hub_dev() -> Option<Child> {
    if hub_already_running() {
        logln("[desktop] hub already reachable on {HUB_ADDR} — not spawning a second one");
        return None;
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
                "[desktop] could not spawn hub ({e}); continuing. Run `pnpm hubctl:dev` yourself if the UI can't reach 127.0.0.1:7777."
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
///     Error: EISDIR: illegal operation on a directory, lstat 'C:'
///         at resolveMainPath
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
    Some(app.path().resource_dir().ok()?.join("hub-runtime").join("apps").join("hub"))
}

/// The bundled Node directory (`<resource_dir>/hub-runtime/node`, holds node(.exe)
/// and `node_modules/npm`).
fn bundled_node_dir(app: &AppHandle) -> Option<PathBuf> {
    Some(app.path().resource_dir().ok()?.join("hub-runtime").join("node"))
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
        std::io::Error::new(std::io::ErrorKind::NotFound, "could not resolve the per-user app-data directory")
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
    want != have
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
        out.push(if chunk.len() > 1 { T[(n >> 6 & 63) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[(n & 63) as usize] as char } else { '=' });
    }
    out
}

const SPLASH_HTML: &str = r#"<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;font-family:'Segoe UI',system-ui,sans-serif;background:#1b1d22;color:#e7e9ee;display:flex;align-items:center;justify-content:center}
.box{text-align:center;padding:28px 36px;max-width:420px}
.spin{width:34px;height:34px;border:3px solid #3a3f4b;border-top-color:#6ea8fe;border-radius:50%;margin:0 auto 18px;animation:r .9s linear infinite}
@keyframes r{to{transform:rotate(360deg)}}
h1{font-size:15px;font-weight:600;margin:0 0 8px}
p{font-size:12.5px;color:#a7adba;margin:0;line-height:1.55}
body[data-state=error] .spin{display:none}
body[data-state=error] h1{color:#ff8a8a}
</style></head><body>
<div class="box">
<div class="spin" id="spin"></div>
<h1 id="msg">First-run setup — installing dependencies…</h1>
<p id="sub">This happens once and needs an internet connection. It may take a minute.</p>
</div></body></html>"#;

/// Best-effort setup window shown while the first-run install runs.
fn make_splash(app: &AppHandle) -> Option<WebviewWindow> {
    let url = format!("data:text/html;base64,{}", base64(SPLASH_HTML.as_bytes()));
    WebviewWindowBuilder::new(app, "setup", WebviewUrl::External(url.parse().ok()?))
        .title("AllMyAgents — first-run setup")
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
    logln("[desktop] setup error: {msg}");
    if let Some(w) = splash {
        let js = format!(
            "document.body.setAttribute('data-state','error');\
             var m=document.getElementById('msg');if(m)m.textContent={msg:?};\
             var s=document.getElementById('sub');if(s)s.textContent='Close this window, then reopen AllMyAgents once you are online.';"
        );
        let _ = w.eval(&js);
    }
}

/// The release boot sequence, run on a background thread so the UI stays
/// responsive while `npm install` runs.
fn release_boot(app: AppHandle, splash: Option<WebviewWindow>) {
    // Reachability guard — never spawn a second hub.
    if hub_already_running() {
        logln("[desktop] hub already reachable on {HUB_ADDR} — not spawning");
        if let Some(w) = &splash {
            let _ = w.close();
        }
        return;
    }

    // Resolve the shipped payload + bundled Node, and the writable hub home.
    let (payload_hub, node_dir, home) = match (payload_hub_dir(&app), bundled_node_dir(&app), hub_home(&app)) {
        (Some(a), Some(b), Some(c)) => (a, b, c),
        _ => {
            splash_error(&splash, "Could not resolve the app's resource or data directory.");
            return;
        }
    };
    // Prefer the bundled Node; fall back to a system `node` on PATH if missing.
    let node = node_dir.join(node_exe_name());
    let node_cmd = if node.exists() { node } else { PathBuf::from(node_exe_name()) };
    let npm_cli = node_dir.join("node_modules").join("npm").join("bin").join("npm-cli.js");

    let dest_hub = home.join("apps").join("hub");
    if let Err(e) = fs::create_dir_all(&dest_hub) {
        splash_error(&splash, &format!("Could not create the data directory: {e}"));
        return;
    }

    // Copy our code out of (read-only) resources into the writable data dir so the
    // hub — and the node_modules the install creates next to it — live together.
    let _ = fs::remove_dir_all(dest_hub.join("dist"));
    if let Err(e) = copy_dir(&payload_hub.join("dist"), &dest_hub.join("dist")) {
        splash_error(&splash, &format!("Could not stage the hub: {e}"));
        return;
    }
    if let Err(e) = fs::copy(payload_hub.join("package.json"), dest_hub.join("package.json")) {
        splash_error(&splash, &format!("Could not stage the hub manifest: {e}"));
        return;
    }

    // Deps ready when the marker matches the shipped manifest (handles first run
    // and dependency changes shipped by an app update).
    let want = fs::read_to_string(dest_hub.join("package.json")).unwrap_or_default();
    let marker = deps_marker(&dest_hub);
    let have = fs::read_to_string(&marker).unwrap_or_default();
    if want.is_empty() || want != have {
        logln("[desktop] first-run: installing hub dependencies via npm…");
        // plain(): a verbatim \\?\ path here is what made every Windows install fail — node cannot
        // resolve a `\\?\`-prefixed main module and exits before npm starts. See plain().
        let status = Command::new(&node_cmd)
            .arg(plain(&npm_cli))
            .args(["install", "--omit=dev", "--no-audit", "--no-fund", "--loglevel=error"])
            .current_dir(plain(&dest_hub))
            // Node on PATH so npm's lifecycle scripts (e.g. better-sqlite3's
            // prebuild-install) that shell out to `node` resolve it.
            .env("PATH", prepend_path(std::slice::from_ref(&node_dir)))
            .status();
        match status {
            Ok(s) if s.success() => {
                let _ = fs::write(&marker, &want);
                logln("[desktop] hub dependencies installed");
            }
            Ok(s) => {
                // Do NOT claim this is a network problem. It said "an internet connection is required"
                // for ANY non-zero exit, so a path bug that made node die before npm even started was
                // reported to two testers as their wifi being at fault — which is precisely why the
                // failure went undiagnosed. State what actually happened and where to look.
                splash_error(
                    &splash,
                    &format!(
                        "Could not install the hub's dependencies (npm exited {}). This is usually a missing internet connection on first run, but the details are in the log: {}",
                        s.code().unwrap_or(-1),
                        log_path(&app).map(|p| p.display().to_string()).unwrap_or_else(|| "(no log)".into())
                    ),
                );
                return;
            }
            Err(e) => {
                splash_error(
                    &splash,
                    &format!("Could not run the bundled npm ({e}). An internet connection is required the first time."),
                );
                return;
            }
        }
    }

    // First-run app-data materialization: journal/config/worktrees + managed
    // profiles go to the per-user app-data root, NEVER the repo or the install dir.
    let (hub_data_dir, hub_profiles_dir) = match materialize_app_data(&app) {
        Ok(pair) => pair,
        Err(e) => {
            splash_error(&splash, &format!("Could not create the app-data directory: {e}"));
            return;
        }
    };
    logln(&format!(
        "[desktop] app data: HUB_DATA_DIR={} HUB_PROFILES_DIR={}",
        hub_data_dir.display(),
        hub_profiles_dir.display()
    ));

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
        .env("HUB_PROFILES_DIR", &hub_profiles_dir);
    set_own_group(&mut cmd); // POSIX: own process group so kill_hub can group-signal the whole tree
    hide_console(&mut cmd); // Windows: no stray black console window in front of the app
    match cmd.spawn() {
        Ok(child) => {
            logln(&format!("[desktop] spawned bundled hub (pid {}) — {}", child.id(), entry.display()));
            if let Some(state) = app.try_state::<HubProcess>() {
                if let Ok(mut g) = state.0.lock() {
                    *g = Some(child);
                }
            }
        }
        Err(e) => {
            splash_error(&splash, &format!("Could not start the hub: {e}"));
            return;
        }
    }

    // Wait until the hub is listening, then dismiss the splash. Bounded so a slow
    // or failed start can't leave the window up forever.
    let deadline = Instant::now() + Duration::from_secs(60);
    while Instant::now() < deadline {
        if hub_already_running() {
            break;
        }
        thread::sleep(Duration::from_millis(300));
    }
    if let Some(w) = &splash {
        let _ = w.close();
    }
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
/// inside `download_and_install`; a bad signature fails here rather than
/// installing.
#[cfg(desktop)]
#[tauri::command]
async fn updater_install(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app.updater().map_err(|e| format!("Updater is not configured yet ({e})."))?;
    let update = updater
        .check()
        .await
        .map_err(|e| format!("Could not check for updates: {e}"))?
        .ok_or_else(|| "No update is available.".to_string())?;
    update
        .download_and_install(|_chunk, _total| {}, || {})
        .await
        .map_err(|e| format!("Update failed: {e}"))?;
    // The hub child is torn down by the Exit handler in `run()` before the process
    // goes away, so the new build starts from a clean slate.
    app.restart();
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
    logln("[desktop] hub (pid {pid}) torn down");
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
        .invoke_handler(tauri::generate_handler![updater_check, updater_install]);

    builder
        .setup(|app| {
            // FIRST thing, before anything can fail: without this every startup diagnostic goes to a
            // stderr that a GUI-launched app does not have, which is how two testers' hubs failed with
            // no recoverable explanation.
            init_log(&app.handle().clone());
            app.manage(HubProcess(Mutex::new(None)));

            if cfg!(debug_assertions) {
                // Dev: spawn `pnpm hub:dev` synchronously, as before.
                let child = spawn_hub_dev();
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
                thread::spawn(move || release_boot(handle, splash));
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

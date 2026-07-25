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

use std::ffi::OsString;
use std::fs;
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

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
        eprintln!("[desktop] hub already reachable on {HUB_ADDR} — not spawning a second one");
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

    match cmd.spawn() {
        Ok(child) => {
            eprintln!(
                "[desktop] spawned hub via `pnpm hubctl:dev` (pid {}) in {}",
                child.id(),
                repo_root.display()
            );
            Some(child)
        }
        Err(e) => {
            eprintln!(
                "[desktop] could not spawn hub ({e}); continuing. Run `pnpm hubctl:dev` yourself if the UI can't reach 127.0.0.1:7777."
            );
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
    let mut paths: Vec<PathBuf> = dirs.to_vec();
    if let Some(existing) = std::env::var_os("PATH") {
        paths.extend(std::env::split_paths(&existing));
    }
    std::env::join_paths(paths).unwrap_or_default()
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

/// Writable "hub home" that becomes the hub's runtime `repoRoot`
/// (`<app_local_data_dir>/hub`). The hub creates `data/` + `profiles/` under it,
/// and the first-run `npm install` writes `apps/hub/node_modules` under it. The
/// hub derives `repoRoot` as three levels up from its own `dist/` dir, so the
/// entry must live at `<home>/apps/hub/dist/index.js`.
fn hub_home(app: &AppHandle) -> Option<PathBuf> {
    Some(app.path().app_local_data_dir().ok()?.join("hub"))
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
    let mut out = String::with_capacity((input.len() + 2) / 3 * 4);
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
    eprintln!("[desktop] setup error: {msg}");
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
        eprintln!("[desktop] hub already reachable on {HUB_ADDR} — not spawning");
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
        eprintln!("[desktop] first-run: installing hub dependencies via npm…");
        let status = Command::new(&node_cmd)
            .arg(&npm_cli)
            .args(["install", "--omit=dev", "--no-audit", "--no-fund", "--loglevel=error"])
            .current_dir(&dest_hub)
            // Node on PATH so npm's lifecycle scripts (e.g. better-sqlite3's
            // prebuild-install) that shell out to `node` resolve it.
            .env("PATH", prepend_path(&[node_dir.clone()]))
            .status();
        match status {
            Ok(s) if s.success() => {
                let _ = fs::write(&marker, &want);
                eprintln!("[desktop] hub dependencies installed");
            }
            Ok(s) => {
                splash_error(
                    &splash,
                    &format!(
                        "Could not download dependencies (npm exit {}). An internet connection is required the first time you run AllMyAgents.",
                        s.code().unwrap_or(-1)
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

    // Spawn the hub with the bundled Node. PATH carries the hub's own .bin (so the
    // codex adapter's `codex app-server` shell lookup resolves) and the bundled
    // Node dir (so the codex .bin shim's `node` fallback resolves).
    let bin_dir = dest_hub.join("node_modules").join(".bin");
    let entry = dest_hub.join("dist").join("hubctl.js");
    let spawn = Command::new(&node_cmd)
        .arg(&entry)
        .current_dir(&home)
        .env("PATH", prepend_path(&[bin_dir, node_dir]))
        .env("HUB_WORKER", hub_worker_flag()) // live turns survive a hub restart (see hub_worker_flag)
        .spawn();
    match spawn {
        Ok(child) => {
            eprintln!("[desktop] spawned bundled hub (pid {}) — {}", child.id(), entry.display());
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

/// Best-effort teardown of the hub child and its whole process tree.
fn kill_hub(child: &mut Child) {
    let pid = child.id();
    // On Windows the child may itself have spawned a tree (pnpm/node, or the
    // bundled node → codex app-server); killing just the parent orphans them, so
    // taskkill the whole tree first.
    if cfg!(windows) {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .output();
    }
    let _ = child.kill();
    let _ = child.wait();
    eprintln!("[desktop] hub (pid {pid}) torn down");
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Native OS file/folder dialogs and opening external links in the browser.
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
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

//! CEC AiMesh desktop shell.
//!
//! Wraps the existing Svelte web UI in a native window and, in development,
//! spawns the Node hub (`pnpm hub:dev`) as a managed child process so the app
//! is self-contained. The child is torn down when the app exits.

use std::net::{SocketAddr, TcpStream};
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{Manager, RunEvent};

/// Where the hub listens. Kept in one place so the reachability probe and the
/// (future) health checks agree.
const HUB_ADDR: &str = "127.0.0.1:7777";

/// Handle to the Node hub we spawn in dev. Stored in Tauri's managed state so
/// the run-loop's exit handler can reach it and shut it down. `None` means we
/// never spawned one (already running, or the spawn failed).
struct HubProcess(Mutex<Option<Child>>);

/// Is the hub already listening? If so we don't spawn a second one — the user
/// may be running `pnpm hub:dev` in their own terminal.
fn hub_already_running() -> bool {
    match HUB_ADDR.parse::<SocketAddr>() {
        Ok(addr) => TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok(),
        Err(_) => false,
    }
}

/// Spawn `pnpm hub:dev` from the repo root.
///
/// DEV ONLY. We locate the repo root at compile time via `CARGO_MANIFEST_DIR`
/// (which points at `apps/desktop/src-tauri`) and walk up three levels. That is
/// exactly right for `tauri dev` on a developer's machine.
///
/// TODO(prod): a shipped bundle does not live inside the source tree, so this
/// path is invalid in release. When we package for distribution, ship a compiled
/// hub as a Tauri sidecar (`bundle.externalBin`) and launch that here instead,
/// gated on `cfg!(debug_assertions)` vs release.
fn spawn_hub() -> Option<Child> {
    if hub_already_running() {
        eprintln!("[desktop] hub already reachable on {HUB_ADDR} — not spawning a second one");
        return None;
    }

    // apps/desktop/src-tauri  ->  ../  ../  ../  =>  repo root
    let repo_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..");

    // `pnpm` on Windows is a `.cmd` shim, so it must be launched through cmd.exe;
    // invoking it directly with std::process fails. On Unix we exec pnpm directly.
    let mut cmd = if cfg!(windows) {
        let mut c = Command::new("cmd");
        c.args(["/C", "pnpm", "hub:dev"]);
        c
    } else {
        let mut c = Command::new("pnpm");
        c.args(["hub:dev"]);
        c
    };
    cmd.current_dir(&repo_root);

    match cmd.spawn() {
        Ok(child) => {
            eprintln!(
                "[desktop] spawned hub via `pnpm hub:dev` (pid {}) in {}",
                child.id(),
                repo_root.display()
            );
            Some(child)
        }
        Err(e) => {
            // Never crash the app over this — the user can run the hub separately.
            eprintln!(
                "[desktop] could not spawn hub ({e}); continuing. Run `pnpm hub:dev` yourself if the UI can't reach 127.0.0.1:7777."
            );
            None
        }
    }
}

/// Best-effort teardown of the hub child and its whole process tree.
fn kill_hub(child: &mut Child) {
    let pid = child.id();
    // On Windows we launched pnpm through `cmd`, and killing the cmd wrapper
    // leaves node/pnpm orphaned — so kill the entire tree with taskkill first.
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
        // Native OS file/folder dialogs (replaces the old PowerShell picker) and
        // opening external links in the user's default browser.
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // Spawn the hub and stash the handle so we can kill it on exit.
            let child = spawn_hub();
            app.manage(HubProcess(Mutex::new(child)));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the CEC AiMesh desktop application")
        .run(|app_handle, event| {
            // Tear the hub down when the app is exiting so we don't leak node
            // processes across dev restarts.
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

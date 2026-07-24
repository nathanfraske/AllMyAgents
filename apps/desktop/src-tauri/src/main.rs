// Prevents an extra console window from appearing on Windows in release builds.
// (Left visible in debug so the hub/child-process logs are easy to see.)
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    cec_aimesh_desktop_lib::run()
}

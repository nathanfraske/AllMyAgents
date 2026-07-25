import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Modern Windows folder picker (IFileOpenDialog with FOS_PICKFOLDERS) — the real explorer
// browser with navigation, not the legacy tree. Windows PowerShell 5.1 renders the classic
// FolderBrowserDialog, so we drop to the COM common-item dialog via a generated script.
const PS_SCRIPT = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class ModernFolderPicker {
  [ComImport, ClassInterface(ClassInterfaceType.None), Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
  private class FileOpenDialog { }
  [ComImport, Guid("d57c7288-d4ad-4768-be02-9d969532d960"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IFileOpenDialog {
    [PreserveSig] int Show(IntPtr parent);
    void SetFileTypes(); void SetFileTypeIndex(); void GetFileTypeIndex();
    void Advise(); void Unadvise();
    void SetOptions(uint fos); void GetOptions(out uint fos);
    void SetDefaultFolder(IntPtr psi); void SetFolder(IntPtr psi);
    void GetFolder(out IntPtr ppsi); void GetCurrentSelection(out IntPtr ppsi);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string n); void GetFileName(out IntPtr n);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string t);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string t);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string t);
    void GetResult(out IShellItem ppsi);
    void AddPlace(IntPtr psi, int a); void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string e);
    void Close(int hr); void SetClientGuid(ref Guid g); void ClearClientData(); void SetFilter(IntPtr f);
  }
  [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IShellItem {
    void BindToHandler(); void GetParent();
    void GetDisplayName(uint sigdn, [MarshalAs(UnmanagedType.LPWStr)] out string ppsz);
    void GetAttributes(); void Compare();
  }
  public static string Pick() {
    var dlg = (IFileOpenDialog)(new FileOpenDialog());
    dlg.SetOptions(0x20 | 0x40); // FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM
    dlg.SetTitle("Select a project folder");
    int hr = dlg.Show(IntPtr.Zero);
    if (hr != 0) return "";
    IShellItem item; dlg.GetResult(out item);
    string p; item.GetDisplayName(0x80058000, out p); // SIGDN_FILESYSPATH
    return p;
  }
}
"@
[Console]::Out.Write([ModernFolderPicker]::Pick())
`

/**
 * Open the OS-native folder picker and resolve the chosen ABSOLUTE path, or `''` if the user
 * cancelled / no picker is available. Backs `POST /api/pick-folder`, so it must behave the same on
 * every platform the app ships on:
 *
 *   - **Windows** — the modern `IFileOpenDialog` via the generated PowerShell script above.
 *   - **macOS**   — AppleScript `choose folder` through `osascript`: the real Finder picker, present
 *                   on every macOS install, no extra dependency. `POSIX path of` converts the
 *                   AppleScript alias to a slash path; it comes back WITH a trailing slash, which we
 *                   strip so callers get the same shape Windows returns. Cancelling raises AppleScript
 *                   error -128, i.e. a non-zero exit → `''`.
 *   - **Linux**   — zenity (GTK) first, then kdialog (KDE); `''` if neither is installed.
 *
 * The hub is headless, so every one of these shells out to a helper that owns its own window.
 */
export function pickFolder(): Promise<string> {
  if (process.platform === 'win32') return pickFolderWindows()
  if (process.platform === 'darwin') {
    return tryPicker('osascript', [
      '-e',
      'POSIX path of (choose folder with prompt "Select a project folder")',
    ]).then((v) => stripTrailingSlash(v ?? ''))
  }
  // Linux/other: try the two ubiquitous desktop dialogs in turn. `null` (command not installed) is
  // the ONLY signal that falls through — a real cancel resolves '' and must not pop a second dialog.
  return tryPicker('zenity', ['--file-selection', '--directory', '--title=Select a project folder']).then((v) =>
    v !== null ? v : tryPicker('kdialog', ['--getexistingdirectory', os.homedir()]).then((k) => k ?? '')
  )
}

// Drops one trailing slash (macOS `POSIX path of` always appends one to a folder), keeping a bare
// "/" intact. NOTE: no example path in this comment on purpose — the bundler's credential firewall
// content-scans shipped code for absolute per-user home paths and would reject the payload.
function stripTrailingSlash(p: string): string {
  return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p
}

function pickFolderWindows(): Promise<string> {
  const scriptPath = path.join(os.tmpdir(), 'aiagentapp-folderpick.ps1')
  try {
    fs.writeFileSync(scriptPath, PS_SCRIPT, 'utf8')
  } catch {
    return Promise.resolve('')
  }
  return tryPicker('powershell', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', scriptPath]).then(
    (v) => v ?? ''
  )
}

/**
 * Spawn a picker command and resolve its selection:
 *   - trimmed stdout on a clean (exit 0) selection,
 *   - `''` on a non-zero exit (the user cancelled) or on the 3-minute timeout,
 *   - `null` when the command itself could not be spawned (ENOENT — not installed), which is the one
 *     signal the Linux path uses to fall through to the next picker.
 */
function tryPicker(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    let out = ''
    let settled = false
    const done = (v: string | null): void => {
      if (settled) return
      settled = true
      resolve(v)
    }
    const child = spawn(cmd, args, { windowsHide: true })
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      done('')
    }, 180_000)
    child.stdout.on('data', (d: Buffer) => (out += d.toString()))
    child.on('error', () => {
      clearTimeout(timer)
      done(null)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      done(code === 0 ? out.trim() : '')
    })
  })
}

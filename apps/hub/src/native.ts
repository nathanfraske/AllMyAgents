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

export function pickFolder(): Promise<string> {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve('')
      return
    }
    const scriptPath = path.join(os.tmpdir(), 'aiagentapp-folderpick.ps1')
    try {
      fs.writeFileSync(scriptPath, PS_SCRIPT, 'utf8')
    } catch {
      resolve('')
      return
    }
    const child = spawn(
      'powershell',
      ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      { windowsHide: true }
    )
    let out = ''
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      resolve(out.trim())
    }, 180_000)
    child.stdout.on('data', (d: Buffer) => (out += d.toString()))
    child.on('error', () => {
      clearTimeout(timer)
      resolve('')
    })
    child.on('exit', () => {
      clearTimeout(timer)
      resolve(out.trim())
    })
  })
}

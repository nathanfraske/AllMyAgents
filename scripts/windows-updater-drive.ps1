# Drive the REAL "Update now" button in the installed Windows app through the OS accessibility tree.
#
# This is deliberately UI Automation, not a private native test hook: the release durability workflow
# must prove the same web button -> Tauri IPC -> signature verification -> MSI -> relaunch path the
# operator used when Windows refused to replace a still-running hub-runtime\node\node.exe.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$deadline = [DateTime]::UtcNow.AddMinutes(3)
$lastButtons = @()
while ([DateTime]::UtcNow -lt $deadline) {
  $buttons = [Windows.Automation.AutomationElement]::RootElement.FindAll(
    [Windows.Automation.TreeScope]::Descendants,
    [Windows.Automation.PropertyCondition]::new(
      [Windows.Automation.AutomationElement]::ControlTypeProperty,
      [Windows.Automation.ControlType]::Button
    )
  )
  $lastButtons = @(
    $buttons |
      ForEach-Object { $_.Current.Name } |
      Where-Object { $_ } |
      Sort-Object -Unique
  )
  $updateButton = $buttons |
    Where-Object {
      $_.Current.IsEnabled -and
      $_.Current.Name -in @('Update now', 'Update anyway')
    } |
    Select-Object -First 1

  if ($updateButton) {
    $pattern = $updateButton.GetCurrentPattern(
      [Windows.Automation.InvokePattern]::Pattern
    )
    if (-not $pattern) {
      throw "the visible '$($updateButton.Current.Name)' button has no InvokePattern"
    }
    Write-Host "invoking installed UI button: $($updateButton.Current.Name)"
    ([Windows.Automation.InvokePattern]$pattern).Invoke()
    exit 0
  }
  Start-Sleep -Milliseconds 500
}

throw "installed app never exposed an enabled Update button; visible buttons: $($lastButtons -join ', ')"

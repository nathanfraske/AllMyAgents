<#
    Tests for the parts of install-windows.ps1 that are easy to get wrong and expensive to get wrong:
    the user-PATH string handling and the generated `allmyagents` shim.

      pwsh -File scripts\install-windows.tests.ps1
      powershell -File scripts\install-windows.tests.ps1 -IncludeRegistry

    Everything here runs against strings and a temporary directory. -IncludeRegistry additionally
    round-trips a real entry through HKCU\Environment: it snapshots the raw value first, adds an
    entry, removes it, and fails unless the value comes back byte for byte. That one is opt-in
    because it touches the machine it runs on; on a CI runner it is free.

    It does NOT download or install anything. Installing is what
    .github/workflows/clean-machine-install.yml is for.
#>

[CmdletBinding()]
param([switch]$IncludeRegistry)

$ErrorActionPreference = 'Stop'

# -Help returns before the program body, so this loads the function definitions and nothing else.
. (Join-Path $PSScriptRoot 'install-windows.ps1') -Help | Out-Null

$script:Failures = 0
function Check {
    param([string]$What, $Actual, $Expected)
    if ($Actual -eq $Expected) {
        Write-Host "  ok   $What"
    } else {
        Write-Host "  FAIL $What" -ForegroundColor Red
        Write-Host "         expected: [$Expected]"
        Write-Host "         actual:   [$Actual]"
        $script:Failures++
    }
}

Write-Host 'Test-PathContains'
Check 'exact match'                (Test-PathContains -RawPath 'C:\a;C:\b' -Dir 'C:\b') $true
Check 'case-insensitive'           (Test-PathContains -RawPath 'C:\A\Bin' -Dir 'c:\a\bin') $true
Check 'trailing backslash in PATH' (Test-PathContains -RawPath 'C:\a\bin\' -Dir 'C:\a\bin') $true
Check 'trailing backslash in Dir'  (Test-PathContains -RawPath 'C:\a\bin' -Dir 'C:\a\bin\') $true
Check 'not a prefix match'         (Test-PathContains -RawPath 'C:\a\binary' -Dir 'C:\a\bin') $false
Check 'empty PATH'                 (Test-PathContains -RawPath '' -Dir 'C:\a') $false
Check 'empty entries ignored'      (Test-PathContains -RawPath 'C:\a;;C:\b' -Dir 'C:\b') $true

Write-Host 'Add-ToPathString'
Check 'appends'                    (Add-ToPathString -RawPath 'C:\a' -Dir 'C:\b') 'C:\a;C:\b'
Check 'empty becomes the entry'    (Add-ToPathString -RawPath '' -Dir 'C:\b') 'C:\b'
Check 'no double semicolon'        (Add-ToPathString -RawPath 'C:\a;' -Dir 'C:\b') 'C:\a;C:\b'
Check 'second run changes nothing' (Add-ToPathString -RawPath 'C:\a;C:\b' -Dir 'C:\b') 'C:\a;C:\b'
Check 'differing case is present'  (Add-ToPathString -RawPath 'C:\A' -Dir 'c:\a') 'C:\A'
# The user's own PATH is not ours to reformat. An empty entry and a %VAR% must survive untouched.
Check 'empty entry preserved'      (Add-ToPathString -RawPath 'C:\a;;C:\b' -Dir 'C:\c') 'C:\a;;C:\b;C:\c'
Check 'unexpanded var preserved'   (Add-ToPathString -RawPath '%USERPROFILE%\bin' -Dir 'C:\c') '%USERPROFILE%\bin;C:\c'

Write-Host 'Remove-FromPathString'
Check 'removes the entry'          (Remove-FromPathString -RawPath 'C:\a;C:\b;C:\c' -Dir 'C:\b') 'C:\a;C:\c'
Check 'removes the last entry'     (Remove-FromPathString -RawPath 'C:\a;C:\b' -Dir 'C:\b') 'C:\a'
Check 'removes the only entry'     (Remove-FromPathString -RawPath 'C:\b' -Dir 'C:\b') ''
Check 'case/slash insensitive'     (Remove-FromPathString -RawPath 'C:\a;C:\B\;C:\c' -Dir 'c:\b') 'C:\a;C:\c'
Check 'absent entry is a no-op'    (Remove-FromPathString -RawPath 'C:\a;C:\c' -Dir 'C:\b') 'C:\a;C:\c'
Check 'empty entry preserved'      (Remove-FromPathString -RawPath 'C:\a;;C:\b' -Dir 'C:\b') 'C:\a;'

Write-Host 'add/remove round-trip leaves the string identical'
$samples = @('C:\a;C:\b', '', 'C:\a;;C:\b', '%USERPROFILE%\bin;C:\a', 'C:\a;')
foreach ($s in $samples) {
    $rt = Remove-FromPathString -RawPath (Add-ToPathString -RawPath $s -Dir 'C:\new') -Dir 'C:\new'
    # A trailing ';' is an empty entry, and appending consumed it. That is the one legitimate
    # difference, so compare with it normalised away rather than pretending it does not happen.
    Check "round-trip [$s]" $rt.TrimEnd(';') $s.TrimEnd(';')
}

Write-Host 'Test-SameVersion'
Check 'tag suffix ignored'         (Test-SameVersion -Tag 'v0.1.4-alpha.5' -Installed '0.1.4') $true
Check 'plain tag'                  (Test-SameVersion -Tag 'v0.1.4' -Installed '0.1.4') $true
Check 'no leading v'               (Test-SameVersion -Tag '0.1.4' -Installed '0.1.4') $true
Check 'different version'          (Test-SameVersion -Tag 'v0.1.5-alpha.1' -Installed '0.1.4') $false
# The reason this is not a wildcard match: a substring test says 0.1.14 contains 0.1.1 and skips
# a real upgrade.
Check 'not a substring match'      (Test-SameVersion -Tag 'v0.1.14' -Installed '0.1.1') $false
Check 'nothing installed'          (Test-SameVersion -Tag 'v0.1.4' -Installed '') $false
Check 'unparseable falls back'     (Test-SameVersion -Tag 'nightly' -Installed 'nightly') $true

Write-Host 'the generated shim'
$BinDir   = Join-Path ([System.IO.Path]::GetTempPath()) ("ama-shim-" + [Guid]::NewGuid().ToString('N'))
$ShimPath = Join-Path $BinDir 'allmyagents.cmd'
try {
    Write-Shim -ExePath 'C:\Users\Test User\AppData\Local\AllMyAgents\allmyagents-desktop.exe' | Out-Null

    $bytes = [System.IO.File]::ReadAllBytes($ShimPath)
    # A .cmd with a UTF-8 BOM makes cmd try to run the BOM as part of the first command.
    Check 'no BOM' ($bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) $false
    Check 'pure ASCII' (@($bytes | Where-Object { $_ -gt 127 }).Count) 0

    $text = [System.IO.File]::ReadAllText($ShimPath)
    Check 'CRLF line endings' ($text -match "[^`r]`n") $false
    Check 'carries the uninstall marker' $text.Contains('generated by the AllMyAgents installer') $true
    Check 'bakes in the exe path' $text.Contains('C:\Users\Test User\AppData\Local\AllMyAgents\allmyagents-desktop.exe') $true
    Check 'quotes the baked path' $text.Contains('set "AMA_EXE=C:\Users\Test User\') $true
    Check 'start has an empty title argument' $text.Contains('start "" "%AMA_EXE%" %*') $true
    Check 'forwards arguments' $text.Contains('%*') $true

    # cmd's own parser is the only real judge of whether this file is valid. Run it with a target
    # that does not exist and check it takes the :missing branch rather than dying on syntax.
    #
    # The redirection is INSIDE the cmd string on purpose. Redirecting a native command's stderr with
    # PowerShell's own `2>&1` wraps each line in an ErrorRecord, which under
    # $ErrorActionPreference='Stop' becomes a terminating NativeCommandError -- so the test fails on a
    # program that behaved exactly as intended. Let cmd do its own redirection and read the file.
    $log = Join-Path $BinDir 'run.log'
    & cmd.exe /c "`"$ShimPath`" > `"$log`" 2>&1"
    $out = Get-Content -LiteralPath $log -Raw
    Check 'missing-exe branch exits non-zero' $LASTEXITCODE 1
    Check 'missing-exe branch explains itself' ($out -like '*is not there any more*') $true
    Check 'no trailing space on the stderr lines' ($out -match ' \r\n') $false

    & cmd.exe /c "`"$ShimPath`" --help > `"$log`" 2>&1"
    $out = Get-Content -LiteralPath $log -Raw
    Check '--help exits zero' $LASTEXITCODE 0
    Check '--help prints usage' ($out -like '*start the AllMyAgents desktop app*') $true

    Write-Host 'Remove-Shim refuses files it did not write'
    Set-Content -LiteralPath $ShimPath -Value '@echo off' -Encoding ascii
    Remove-Shim | Out-Null
    Check 'foreign file left alone' (Test-Path -LiteralPath $ShimPath) $true
} finally {
    Remove-Item -Recurse -Force -LiteralPath $BinDir -ErrorAction SilentlyContinue
}

if ($IncludeRegistry) {
    Write-Host 'real HKCU\Environment round-trip'
    $before = Get-UserPath
    $snapshot = Join-Path ([System.IO.Path]::GetTempPath()) 'ama-user-path-snapshot.txt'
    # Written before anything is changed, so a crash between the add and the remove is recoverable.
    [System.IO.File]::WriteAllText($snapshot, $before.Value, [System.Text.Encoding]::Unicode)
    Write-Host "  (snapshot of the value before this test: $snapshot)"

    $probe = Join-Path ([System.IO.Path]::GetTempPath()) 'ama-path-probe'
    try {
        Add-UserPathEntry -Dir $probe | Out-Null
        $mid = Get-UserPath
        Check 'entry is present after adding' (Test-PathContains -RawPath $mid.Value -Dir $probe) $true
        Check 'value kind unchanged' $mid.Kind $before.Kind

        Add-UserPathEntry -Dir $probe | Out-Null
        $twice = Get-UserPath
        Check 'adding twice does not duplicate' $twice.Value $mid.Value
    } finally {
        Remove-UserPathEntry -Dir $probe | Out-Null
    }
    $after = Get-UserPath
    Check 'PATH restored byte for byte' $after.Value $before.Value
    Check 'value kind restored' $after.Kind $before.Kind
}

Write-Host ''
if ($script:Failures -gt 0) {
    Write-Host "$script:Failures test(s) FAILED" -ForegroundColor Red
    exit 1
}
Write-Host 'all tests passed' -ForegroundColor Green

// Read-only inventory for hubctl supervisors. This exists because a supervisor can outlive both its
// parent desktop process and the worktree containing its code; the symptom must be discoverable without
// guessing from stray console windows.
//
//   pnpm supervisors:status
//   pnpm supervisors:status --json
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'

const json = process.argv.includes('--json')

function entryFromCommandLine(commandLine) {
  const tokens = commandLine.match(/"[^"]*"|'[^']*'|\S+/g)?.map((token) => token.replace(/^(['"])(.*)\1$/, '$2')) ?? []
  if (!tokens.length) return null
  let index = 1 // executable
  while (index < tokens.length && tokens[index].startsWith('-')) {
    const flag = tokens[index++]
    if (flag === '--import' || flag === '--require' || flag === '-r') index++
  }
  const entry = tokens[index]
  return entry && /(?:^|[\\/])hubctl\.(?:js|ts)$/i.test(entry) ? entry : null
}

function windowsProcesses() {
  const query = String.raw`
$all = @(Get-CimInstance Win32_Process)
$ids = @{}
foreach ($p in $all) { $ids[[int]$p.ProcessId] = $true }
@($all |
  Where-Object {
    $_.Name -ieq 'node.exe' -and
    [string]$_.CommandLine -match 'hubctl\.(js|ts)'
  } |
  ForEach-Object {
    [pscustomobject]@{
      pid = [int]$_.ProcessId
      parentPid = [int]$_.ParentProcessId
      parentAlive = $ids.ContainsKey([int]$_.ParentProcessId)
      commandLine = [string]$_.CommandLine
    }
  }) | ConvertTo-Json -Compress
`
  const result = spawnSync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', query],
    { encoding: 'utf8', windowsHide: true }
  )
  if (result.status !== 0) throw new Error(result.stderr.trim() || 'Windows process inventory failed')
  const parsed = result.stdout.trim() ? JSON.parse(result.stdout) : []
  return Array.isArray(parsed) ? parsed : [parsed]
}

function posixProcesses() {
  const result = spawnSync('ps', ['-axo', 'pid=,ppid=,comm=,args='], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr.trim() || 'process inventory failed')
  const all = result.stdout
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/))
    .filter(Boolean)
    .map((match) => ({
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      executable: match[3],
      commandLine: match[4],
    }))
  const ids = new Set(all.map((process) => process.pid))
  return all
    .filter(
      (process) =>
        /^(?:node|nodejs)(?:\.exe)?$/i.test(process.executable.split(/[\\/]/).at(-1) ?? '') &&
        entryFromCommandLine(process.commandLine)
    )
    .map((process) => ({ ...process, parentAlive: ids.has(process.parentPid) }))
}

const processes = (process.platform === 'win32' ? windowsProcesses() : posixProcesses()).map((process) => {
  const entry = entryFromCommandLine(process.commandLine)
  const entryExists = entry ? fs.existsSync(entry) : false
  const status = !entry ? 'entry-unknown' : entryExists ? 'running' : 'ENTRY-MISSING'
  return { ...process, entry, entryExists, status }
})

if (json) {
  console.log(JSON.stringify(processes, null, 2))
} else if (!processes.length) {
  console.log('No AllMyAgents hubctl supervisors found.')
} else {
  console.log('AllMyAgents hubctl supervisors (read-only):')
  for (const process of processes) {
    const parent = process.parentAlive ? `parent ${process.parentPid} alive` : `parent ${process.parentPid} gone`
    console.log(`  PID ${process.pid}  ${process.status}  ${parent}`)
    console.log(`    ${process.entry ?? '(could not resolve entry from command line)'}`)
  }
  const missing = processes.filter((process) => !process.entryExists)
  if (missing.length) {
    console.log(`WARNING: ${missing.length} supervisor(s) cannot reload their own entry and should not be running.`)
  }
}

if (processes.some((process) => !process.entryExists)) process.exitCode = 1

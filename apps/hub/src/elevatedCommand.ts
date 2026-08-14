import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type Database from 'better-sqlite3'

export type ElevationScope = 'disabled' | 'project' | 'machine'
export type ElevatedShell = 'powershell' | 'bash'
export type ElevatedRisk = 'moderate' | 'high' | 'critical'

export const APPLICATION_ELEVATION_POLICY_ID = '__allmyagents_application__'

export interface ProjectElevationPolicy {
  projectId: string
  subject: 'project' | 'application'
  scope: ElevationScope
  allowedRoots: string[]
  updatedAt: string
}

interface ElevationPolicyRow {
  projectId: string
  scope: ElevationScope
  allowedRoots: string
  updatedAt: string
}

export interface ElevatedCommandFinding {
  code: string
  severity: 'warning' | 'danger'
  detail: string
}

export interface ElevatedCommandAnalysis {
  commandHash: string
  risk: ElevatedRisk
  scope: ElevationScope
  cwd: string
  allowedRoots: string[]
  literalPaths: string[]
  outsideAllowedRoots: string[]
  filesystemScope: 'project-roots' | 'machine-wide' | 'no-filesystem-path-detected'
  findings: ElevatedCommandFinding[]
  blastRadius: string[]
  scopeEnforcement: string
  mayProceed: boolean
}

export interface ElevatedCommandRequest {
  command: string
  cwd: string
  shell: ElevatedShell
  timeoutMs: number
}

export interface ElevatedCommandResult {
  ok: boolean
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  truncated: boolean
  durationMs: number
  elevation: 'windows-uac' | 'already-elevated' | 'unavailable'
  error?: string
}

export interface ElevatedCommandRunner {
  execute(request: ElevatedCommandRequest): Promise<ElevatedCommandResult>
}

function canonicalRoot(value: string): string {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function within(root: string, candidate: string): boolean {
  const relative = path.relative(canonicalRoot(root), canonicalRoot(candidate))
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
}

function boundedRoots(requiredRoot: string | undefined, roots: readonly string[]): string[] {
  const result: string[] = []
  for (const raw of [...(requiredRoot ? [requiredRoot] : []), ...roots]) {
    if (typeof raw !== 'string' || !raw.trim() || raw.length > 4_096 || !path.isAbsolute(raw)) {
      throw new Error('elevation allowed roots must be absolute bounded paths')
    }
    const normalized = path.resolve(raw)
    const key = canonicalRoot(normalized)
    if (!result.some((item) => canonicalRoot(item) === key)) result.push(normalized)
  }
  if (result.length > 16) throw new Error('elevation policy may contain at most 16 allowed roots')
  return result
}

export class ProjectElevationPolicyStore {
  private readonly getStmt: Database.Statement
  private readonly upsertStmt: Database.Statement

  constructor(private readonly db: Database.Database) {
    db.exec(
      `CREATE TABLE IF NOT EXISTS project_elevation_policy (
        projectId TEXT PRIMARY KEY, scope TEXT NOT NULL, allowedRoots TEXT NOT NULL, updatedAt TEXT NOT NULL
      )`,
    )
    this.getStmt = db.prepare(
      'SELECT projectId, scope, allowedRoots, updatedAt FROM project_elevation_policy WHERE projectId = ?',
    )
    this.upsertStmt = db.prepare(
      `INSERT INTO project_elevation_policy (projectId, scope, allowedRoots, updatedAt)
       VALUES (@projectId, @scope, @allowedRoots, @updatedAt)
       ON CONFLICT(projectId) DO UPDATE SET scope = excluded.scope, allowedRoots = excluded.allowedRoots, updatedAt = excluded.updatedAt`,
    )
  }

  get(projectId: string, projectPath: string): ProjectElevationPolicy {
    const row = this.getStmt.get(projectId) as ElevationPolicyRow | undefined
    if (!row) {
      return {
        projectId,
        subject: 'project',
        scope: 'disabled',
        allowedRoots: [path.resolve(projectPath)],
        updatedAt: '',
      }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(row.allowedRoots)
    } catch {
      parsed = []
    }
    const roots = Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
    return {
      projectId,
      subject: 'project',
      scope: row.scope === 'project' || row.scope === 'machine' ? row.scope : 'disabled',
      allowedRoots: boundedRoots(projectPath, roots),
      updatedAt: row.updatedAt,
    }
  }

  set(projectId: string, projectPath: string, scope: ElevationScope, extraRoots: readonly string[] = []): ProjectElevationPolicy {
    if (scope !== 'disabled' && scope !== 'project' && scope !== 'machine') throw new Error('invalid elevation scope')
    const allowedRoots = boundedRoots(projectPath, scope === 'project' ? extraRoots : [])
    const policy = { projectId, subject: 'project' as const, scope, allowedRoots, updatedAt: new Date().toISOString() }
    this.upsertStmt.run({ ...policy, allowedRoots: JSON.stringify(allowedRoots) })
    return policy
  }

  /** Application-scoped machine policy used only by the hub-minted Overseer. It deliberately has no
   * implicit project root: service, process, and registry operations must not be falsely attributed to a
   * repository merely to satisfy the persistence shape. */
  getApplication(): ProjectElevationPolicy {
    const row = this.getStmt.get(APPLICATION_ELEVATION_POLICY_ID) as ElevationPolicyRow | undefined
    if (!row) {
      return {
        projectId: APPLICATION_ELEVATION_POLICY_ID,
        subject: 'application',
        scope: 'disabled',
        allowedRoots: [],
        updatedAt: '',
      }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(row.allowedRoots)
    } catch {
      parsed = []
    }
    const roots = Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
    return {
      projectId: APPLICATION_ELEVATION_POLICY_ID,
      subject: 'application',
      scope: row.scope === 'machine' ? 'machine' : 'disabled',
      allowedRoots: boundedRoots(undefined, roots),
      updatedAt: row.updatedAt,
    }
  }

  setApplication(scope: Extract<ElevationScope, 'disabled' | 'machine'>, roots: readonly string[] = []): ProjectElevationPolicy {
    if (scope !== 'disabled' && scope !== 'machine') {
      throw new Error('application elevation scope must be disabled or machine')
    }
    if (roots.length) {
      throw new Error('application machine elevation does not accept allowed paths; use a project policy for root-bounded work')
    }
    const allowedRoots: string[] = []
    const policy = {
      projectId: APPLICATION_ELEVATION_POLICY_ID,
      subject: 'application' as const,
      scope,
      allowedRoots,
      updatedAt: new Date().toISOString(),
    }
    this.upsertStmt.run({ ...policy, allowedRoots: JSON.stringify(allowedRoots) })
    return policy
  }
}

function extractLiteralPaths(command: string): string[] {
  const found = new Set<string>()
  const windows = command.match(/(?:[A-Za-z]:[\\/]|\\\\)[^\s"'`|;&<>]*/gu) ?? []
  for (const candidate of windows) found.add(candidate.replace(/[),\]}]+$/u, ''))
  if (process.platform !== 'win32') {
    const posix = command.match(/(?:^|[\s="'])(\/(?!\/)[^\s"'`|;&<>]*)/gu) ?? []
    for (const match of posix) {
      const candidate = match.trim().replace(/^['"]/u, '').replace(/[),\]}]+$/u, '')
      if (candidate.startsWith('/')) found.add(candidate)
    }
  }
  return [...found].slice(0, 64)
}

/** Conservative, explainable blast-radius analysis. It is intentionally not presented as a shell sandbox. */
export function analyzeElevatedCommand(
  command: string,
  policy: ProjectElevationPolicy,
  cwd: string,
): ElevatedCommandAnalysis {
  const normalized = command.trim()
  if (!normalized || normalized.length > 8_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)) {
    throw new Error('elevated command must be 1 to 8,000 printable characters')
  }
  const literalPaths = extractLiteralPaths(normalized)
  const outsideAllowedRoots = policy.scope === 'project'
    ? literalPaths.filter((candidate) => !policy.allowedRoots.some((root) => within(root, candidate)))
    : []
  const findings: ElevatedCommandFinding[] = []
  const add = (code: string, severity: 'warning' | 'danger', detail: string): void => {
    if (!findings.some((item) => item.code === code)) findings.push({ code, severity, detail })
  }
  if (policy.scope === 'project' && !policy.allowedRoots.some((root) => within(root, cwd))) {
    add('cwd-outside-scope', 'danger', 'The requested working directory is outside every configured project root.')
  }
  if (outsideAllowedRoots.length) {
    add('literal-path-outside-scope', 'danger', 'The command names an absolute path outside the configured project roots.')
  }
  if (/(?:^|[\s;&|])(rm\s+-rf|remove-item\b[^\r\n]*(?:-recurse|-force)|del\s+\/s|rmdir\s+\/s|format\b|diskpart\b|mkfs\b|dd\s+if=)/iu.test(normalized)) {
    add('destructive-filesystem', 'danger', 'The command appears capable of recursively deleting, formatting, or overwriting storage.')
  }
  if (/\b(?:sc(?:\.exe)?\s+(?:create|delete|config|stop)|new-service|set-service|systemctl\s+(?:enable|disable|stop)|launchctl|bcdedit|reg(?:\.exe)?\s+(?:add|delete)|set-itemproperty\b[^\r\n]*registry:)/iu.test(normalized)) {
    add('persistent-system-change', 'danger', 'The command may modify services, boot state, or machine-wide configuration.')
  }
  if (/\b(?:netsh|set-netfirewall|new-netfirewall|iptables|nft\s|route\s+(?:add|delete)|shutdown|restart-computer|reboot)\b/iu.test(normalized)) {
    add('network-or-availability', 'danger', 'The command may alter networking or machine availability.')
  }
  if (/\b(?:takeown|icacls|chmod|chown|setfacl|secedit|net\s+(?:user|localgroup))\b/iu.test(normalized)) {
    add('identity-or-permissions', 'danger', 'The command may change ownership, permissions, accounts, or security policy.')
  }
  if (/\b(?:invoke-webrequest|curl|wget|bitsadmin|certutil)\b/iu.test(normalized)) {
    add('network-transfer', 'warning', 'The command can transfer data over the network; verify source, destination, and credentials.')
  }
  if (/\b(?:invoke-expression|iex|encodedcommand|frombase64string|powershell\s+-c|cmd(?:\.exe)?\s+\/c|sh\s+-c|bash\s+-c)\b/iu.test(normalized)) {
    add('nested-or-obfuscated-shell', 'warning', 'Nested or encoded shell execution makes literal-path analysis incomplete.')
  }
  if (/(?:^|[\\/])\.\.(?:[\\/]|$)|\$env:|%[A-Za-z_][A-Za-z0-9_]*%|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|~[\\/]/u.test(normalized)) {
    add('dynamic-path', 'warning', 'Relative traversal or environment-expanded paths make the final filesystem reach uncertain.')
  }

  const dangerCount = findings.filter((item) => item.severity === 'danger').length
  const risk: ElevatedRisk = dangerCount > 0 ? 'critical' : findings.length > 0 ? 'high' : 'moderate'
  const filesystemScope = policy.scope === 'project'
    ? 'project-roots'
    : literalPaths.length > 0 || findings.some((item) => item.code === 'destructive-filesystem' || item.code === 'dynamic-path')
      ? 'machine-wide'
      : 'no-filesystem-path-detected'
  const blastRadius = [
    policy.scope === 'machine'
      ? 'The configured policy permits machine-wide effects after operator approval.'
      : 'The declared scope is the project roots listed in this report.',
    'The child process receives administrator/root authority and can affect data, services, accounts, and other users if the command reaches them.',
    'Output is bounded for the agent response; side effects are not rolled back automatically.',
  ]
  const scopeViolation = findings.some(
    (item) => item.code === 'cwd-outside-scope' || item.code === 'literal-path-outside-scope',
  )
  return {
    commandHash: crypto.createHash('sha256').update(normalized, 'utf8').digest('hex'),
    risk,
    scope: policy.scope,
    cwd: path.resolve(cwd),
    allowedRoots: [...policy.allowedRoots],
    literalPaths,
    outsideAllowedRoots,
    filesystemScope,
    findings,
    blastRadius,
    scopeEnforcement: policy.scope === 'project'
      ? 'Policy checks the working directory and literal paths before execution, but an arbitrary elevated shell is not an OS sandbox. The operator must treat the command itself as the final authority boundary.'
      : policy.scope === 'machine'
        ? 'Machine scope does not pretend that a repository root contains service, process, registry, or other host-wide effects. The explicit operator approval and command text are the authority boundary.'
        : 'Elevation is disabled until the operator configures an explicit project or application-machine policy.',
    mayProceed: policy.scope !== 'disabled' && (policy.scope === 'machine' || !scopeViolation),
  }
}

const OUTPUT_LIMIT = 64 * 1024

function readBounded(file: string): { text: string; truncated: boolean } {
  try {
    const stat = fs.statSync(file)
    const handle = fs.openSync(file, 'r')
    try {
      const length = Math.min(stat.size, OUTPUT_LIMIT)
      const buffer = Buffer.alloc(length)
      fs.readSync(handle, buffer, 0, length, Math.max(0, stat.size - length))
      return { text: buffer.toString('utf8'), truncated: stat.size > OUTPUT_LIMIT }
    } finally {
      fs.closeSync(handle)
    }
  } catch {
    return { text: '', truncated: false }
  }
}

function psLiteral(value: string): string {
  return `'${value.replace(/'/gu, "''")}'`
}

function execFileResult(file: string, args: string[], timeout: number): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout, maxBuffer: 64 * 1024 }, (error, _stdout, stderr) => {
      const code = typeof (error as NodeJS.ErrnoException & { code?: number } | null)?.code === 'number'
        ? ((error as NodeJS.ErrnoException & { code: number }).code)
        : error ? 1 : 0
      resolve({ code, stderr: stderr?.toString().slice(-8_000) ?? '' })
    })
  })
}

/** Windows ships the first real broker: a one-shot UAC child with no resident privileged service. */
export class NodeElevatedCommandRunner implements ElevatedCommandRunner {
  async execute(request: ElevatedCommandRequest): Promise<ElevatedCommandResult> {
    const started = Date.now()
    if (process.platform !== 'win32') {
      return {
        ok: false,
        exitCode: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        truncated: false,
        durationMs: Date.now() - started,
        elevation: 'unavailable',
        error: 'This build has no interactive root broker for this operating system. Run the app under the required account or use an explicitly granted remote testbed.',
      }
    }
    if (request.shell !== 'powershell') {
      return {
        ok: false,
        exitCode: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        truncated: false,
        durationMs: Date.now() - started,
        elevation: 'unavailable',
        error: 'Windows elevated execution currently supports the PowerShell broker only.',
      }
    }

    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-elevated-'))
    const wrapper = path.join(temp, 'request.ps1')
    const stdoutFile = path.join(temp, 'stdout.txt')
    const stderrFile = path.join(temp, 'stderr.txt')
    const resultFile = path.join(temp, 'result.json')
    const encoded = Buffer.from(request.command, 'utf16le').toString('base64')
    const seconds = Math.max(1, Math.ceil(request.timeoutMs / 1000))
    const script = [
      "$ErrorActionPreference = 'Stop'",
      `$started = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()`,
      `$timedOut = $false`,
      `$exitCode = $null`,
      `Set-Location -LiteralPath ${psLiteral(request.cwd)}`,
      `try {`,
      `  $child = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',${psLiteral(encoded)}) -PassThru -WindowStyle Hidden -RedirectStandardOutput ${psLiteral(stdoutFile)} -RedirectStandardError ${psLiteral(stderrFile)}`,
      `  if (-not $child.WaitForExit(${seconds * 1000})) {`,
      `    $timedOut = $true`,
      `    & taskkill.exe /PID $child.Id /T /F | Out-Null`,
      `    $child.WaitForExit()`,
      `  }`,
      `  $exitCode = if ($timedOut) { $null } else { $child.ExitCode }`,
      `} catch {`,
      `  [IO.File]::AppendAllText(${psLiteral(stderrFile)}, $_.Exception.Message)`,
      `}`,
      `$finished = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()`,
      `$result = @{ exitCode = $exitCode; timedOut = $timedOut; durationMs = ($finished - $started) } | ConvertTo-Json -Compress`,
      `[IO.File]::WriteAllText(${psLiteral(resultFile)}, $result)`,
    ].join('\r\n')
    fs.writeFileSync(wrapper, script, { encoding: 'utf8', mode: 0o600 })
    try {
      const launch = [
        `$process = Start-Process -FilePath 'powershell.exe'`,
        `-ArgumentList @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',${psLiteral(wrapper)})`,
        `-Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $process.ExitCode`,
      ].join(' ')
      const outer = await execFileResult(
        'powershell.exe',
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', launch],
        request.timeoutMs + 5 * 60 * 1000,
      )
      const stdout = readBounded(stdoutFile)
      const stderr = readBounded(stderrFile)
      if (!fs.existsSync(resultFile)) {
        return {
          ok: false,
          exitCode: null,
          stdout: stdout.text,
          stderr: stderr.text || outer.stderr,
          timedOut: false,
          truncated: stdout.truncated || stderr.truncated,
          durationMs: Date.now() - started,
          elevation: 'windows-uac',
          error: outer.stderr || 'The UAC request was cancelled or the elevated helper did not return a result.',
        }
      }
      const result = JSON.parse(fs.readFileSync(resultFile, 'utf8')) as {
        exitCode: number | null
        timedOut: boolean
        durationMs: number
      }
      return {
        ok: result.exitCode === 0 && !result.timedOut,
        exitCode: result.exitCode,
        stdout: stdout.text,
        stderr: stderr.text,
        timedOut: result.timedOut === true,
        truncated: stdout.truncated || stderr.truncated,
        durationMs: Number.isFinite(result.durationMs) ? result.durationMs : Date.now() - started,
        elevation: 'windows-uac',
        ...(result.exitCode === 0 && !result.timedOut
          ? {}
          : { error: result.timedOut ? 'Elevated command timed out and its process tree was terminated.' : `Elevated command exited with code ${result.exitCode}.` }),
      }
    } finally {
      try {
        fs.rmSync(temp, { recursive: true, force: true })
      } catch {
        // A UAC window accepted after the outer broker timed out may still hold a file briefly. Never mask
        // the authoritative command result with best-effort cleanup; the OS temp directory remains bounded
        // to this one request and normal startup/temp maintenance may remove it later.
      }
    }
  }
}

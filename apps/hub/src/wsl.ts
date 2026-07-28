import { execFile } from 'node:child_process'
import type { WslDistro } from './workspaceLocation.js'

export interface ProcessResult {
  exitCode: number
  stdout: string | Buffer
  stderr: string | Buffer
}

export type ProcessRunner = (
  program: string,
  args: readonly string[],
) => Promise<ProcessResult>

export interface DockerWslCapability {
  available: boolean
  reason?: string
}

export interface WslCapability {
  supported: boolean
  reason?: string
  distros: WslDistro[]
  docker: DockerWslCapability
}

function decodeWindowsOutput(value: string | Buffer): string {
  if (typeof value === 'string') return value.replaceAll('\0', '').replace(/^\uFEFF/, '')
  let zeroes = 0
  for (let index = 1; index < value.length; index += 2) {
    if (value[index] === 0) zeroes += 1
  }
  const likelyUtf16 = value.length > 1 && zeroes > value.length / 8
  return value.toString(likelyUtf16 ? 'utf16le' : 'utf8').replaceAll('\0', '').replace(/^\uFEFF/, '')
}

/**
 * Parse `wsl.exe --list --verbose`. Redirected wsl.exe output is UTF-16LE on supported Windows
 * releases, while injected tests and some terminals provide strings/UTF-8, so both are accepted.
 */
export function parseWslDistroList(output: string | Buffer): WslDistro[] {
  const distros: WslDistro[] = []
  for (const rawLine of decodeWindowsOutput(output).split(/\r?\n/)) {
    const line = rawLine.trimEnd()
    if (!line.trim() || /^\s*NAME\s+STATE\s+VERSION\s*$/i.test(line)) continue
    const match = /^\s*(\*)?\s*(.+?)\s+(Running|Stopped)\s+([12])\s*$/i.exec(line)
    if (!match) continue
    distros.push({
      name: match[2]!.trim(),
      state: match[3]!.toLowerCase() === 'running' ? 'running' : 'stopped',
      version: Number(match[4]) as 1 | 2,
      isDefault: match[1] === '*',
    })
  }
  return distros
}

function defaultRun(program: string, args: readonly string[]): Promise<ProcessResult> {
  return new Promise((resolve) => {
    execFile(program, [...args], { encoding: 'buffer', windowsHide: true }, (error, stdout, stderr) => {
      resolve({
        exitCode: typeof (error as NodeJS.ErrnoException | null)?.code === 'number'
          ? ((error as NodeJS.ErrnoException & { code: number }).code)
          : error
            ? 1
            : 0,
        stdout: stdout ?? Buffer.alloc(0),
        stderr: stderr ?? Buffer.alloc(0),
      })
    })
  })
}

export class WslService {
  private readonly platform: NodeJS.Platform
  private readonly run: ProcessRunner

  constructor(options: { platform?: NodeJS.Platform; run?: ProcessRunner } = {}) {
    this.platform = options.platform ?? process.platform
    this.run = options.run ?? defaultRun
  }

  async capability(): Promise<WslCapability> {
    if (this.platform !== 'win32') {
      return {
        supported: false,
        reason: 'WSL is available only on Windows.',
        distros: [],
        docker: {
          available: false,
          reason: 'Docker/WSL targets are available only on Windows.',
        },
      }
    }

    const listed = await this.run('wsl.exe', ['--list', '--verbose'])
    if (listed.exitCode !== 0) {
      return {
        supported: false,
        reason: 'WSL is not installed or is unavailable on this machine.',
        distros: [],
        docker: {
          available: false,
          reason: 'Docker/WSL targets require WSL 2.',
        },
      }
    }
    const allDistros = parseWslDistroList(listed.stdout)
    const dockerManaged = allDistros.some((distro) =>
      /^docker-desktop(?:-data)?$/i.test(distro.name),
    )
    const distros = allDistros.filter(
      (distro) => !/^docker-desktop(?:-data)?$/i.test(distro.name),
    )
    const dockerVersion = await this.run('docker', [
      'version',
      '--format',
      '{{.Server.Version}}',
    ])
    const docker: DockerWslCapability =
      dockerVersion.exitCode === 0 && decodeWindowsOutput(dockerVersion.stdout).trim()
        ? { available: true }
        : dockerManaged
          ? {
              available: false,
              reason: 'Docker Desktop is installed, but its Linux engine is not running.',
            }
          : {
              available: false,
              reason: 'Docker Desktop is not installed or is unavailable.',
            }

    return { supported: true, distros, docker }
  }
}

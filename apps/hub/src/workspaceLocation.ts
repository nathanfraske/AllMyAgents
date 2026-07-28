import path from 'node:path'

export type WslDistroState = 'running' | 'stopped'

/**
 * One registered WSL filesystem. The distro name is part of filesystem identity: two distros may
 * contain byte-for-byte identical path tails without sharing a single inode.
 */
export interface WslDistro {
  name: string
  version: 1 | 2
  state: WslDistroState
  isDefault: boolean
}

export interface LocalWorkspacePath {
  kind: 'local'
  hostPath: string
  key: string
}

export interface WslWorkspacePath {
  kind: 'wsl'
  distro: string
  linuxPath: string
  hostPath: string
  key: string
}

export interface UnavailableWorkspacePath {
  kind: 'unavailable'
  input: string
  distro?: string
  reason: string
  key?: undefined
}

export type WorkspacePath =
  | LocalWorkspacePath
  | WslWorkspacePath
  | UnavailableWorkspacePath

export interface ClassifyWorkspacePathOptions {
  platform?: NodeJS.Platform
  /**
   * Required for an absolute Linux path entered on Windows. UNC paths carry their distro in-band.
   * Callers must persist the resolved name, never the moving concept of "the default distro".
   */
  distro?: string
  /**
   * When present, classification also checks live registration/state/version. Omit for syntax-only
   * parsing (for example while reconstructing a record before the WSL probe has completed).
   */
  distros?: readonly WslDistro[]
}

const WSL_UNC = /^[\\/]{2}(wsl\$|wsl\.localhost)[\\/]+([^\\/]+)(?:[\\/]+(.*))?$/i

function actualDistroName(
  requested: string,
  distros: readonly WslDistro[] | undefined,
): string {
  if (!distros) return requested
  return (
    distros.find((candidate) => candidate.name.toLowerCase() === requested.toLowerCase())?.name ??
    requested
  )
}

function unavailableForDistro(
  input: string,
  requested: string,
  distros: readonly WslDistro[] | undefined,
): UnavailableWorkspacePath | undefined {
  if (!distros) return undefined
  const distro = distros.find(
    (candidate) => candidate.name.toLowerCase() === requested.toLowerCase(),
  )
  if (!distro) {
    return {
      kind: 'unavailable',
      input,
      distro: requested,
      reason: `The ${requested} WSL distro is not installed. It may have been unregistered or renamed.`,
    }
  }
  if (distro.version !== 2) {
    return {
      kind: 'unavailable',
      input,
      distro: distro.name,
      reason: `${distro.name} uses WSL 1. AllMyAgents currently requires WSL 2.`,
    }
  }
  if (distro.state !== 'running') {
    return {
      kind: 'unavailable',
      input,
      distro: distro.name,
      reason: `The ${distro.name} WSL distro this project lives in is not running.`,
    }
  }
  return undefined
}

function canonicalLinuxPath(input: string): string | undefined {
  if (!input.startsWith('/')) return undefined
  const normalized = path.posix.normalize(input.replaceAll('\\', '/'))
  return normalized.startsWith('/') ? normalized : undefined
}

export function wslHostPath(distro: string, linuxPath: string): string {
  const tail = linuxPath === '/' ? '' : linuxPath.slice(1).replaceAll('/', '\\')
  return `\\\\wsl.localhost\\${distro}${tail ? `\\${tail}` : ''}`
}

/**
 * Classify a path by filesystem, not by spelling.
 *
 * `\\wsl$\Ubuntu\x` and `\\wsl.localhost\Ubuntu\x` collapse to one key, while Ubuntu:/x and
 * Debian:/x deliberately do not. Linux paths remain case-sensitive even though their UNC projection is
 * being consumed by a Windows hub.
 */
export function classifyWorkspacePath(
  rawInput: string,
  options: ClassifyWorkspacePathOptions = {},
): WorkspacePath {
  const platform = options.platform ?? process.platform
  const input = rawInput.trim()
  const unc = WSL_UNC.exec(input)
  if (unc) {
    const requestedDistro = unc[2]!
    const unavailable = unavailableForDistro(input, requestedDistro, options.distros)
    if (unavailable) return unavailable
    const distro = actualDistroName(requestedDistro, options.distros)
    const linuxPath = canonicalLinuxPath(`/${(unc[3] ?? '').replaceAll('\\', '/')}`)
    if (!linuxPath) {
      return { kind: 'unavailable', input, distro, reason: `Invalid WSL path: ${input}` }
    }
    return {
      kind: 'wsl',
      distro,
      linuxPath,
      hostPath: wslHostPath(distro, linuxPath),
      key: `wsl:${distro.toLowerCase()}:${linuxPath}`,
    }
  }

  if (platform === 'win32' && input.startsWith('/')) {
    if (!options.distro) {
      return {
        kind: 'unavailable',
        input,
        reason: `Choose a WSL distro for the Linux path ${input}.`,
      }
    }
    const unavailable = unavailableForDistro(input, options.distro, options.distros)
    if (unavailable) return unavailable
    const distro = actualDistroName(options.distro, options.distros)
    const linuxPath = canonicalLinuxPath(input)
    if (!linuxPath) {
      return { kind: 'unavailable', input, distro, reason: `Invalid WSL path: ${input}` }
    }
    return {
      kind: 'wsl',
      distro,
      linuxPath,
      hostPath: wslHostPath(distro, linuxPath),
      key: `wsl:${distro.toLowerCase()}:${linuxPath}`,
    }
  }

  const hostPath =
    platform === 'win32' ? path.win32.resolve(input) : path.posix.resolve(input)
  const identityPath = platform === 'win32' ? hostPath.toLowerCase() : hostPath
  return {
    kind: 'local',
    hostPath,
    key: `local:${platform}:${identityPath}`,
  }
}

export function sameWorkspacePath(left: WorkspacePath, right: WorkspacePath): boolean {
  return left.kind !== 'unavailable' && right.kind !== 'unavailable' && left.key === right.key
}

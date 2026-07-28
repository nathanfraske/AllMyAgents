import { describe, expect, it } from 'vitest'
import {
  classifyWorkspacePath,
  sameWorkspacePath,
  type WslDistro,
} from './workspaceLocation.js'

const distros: WslDistro[] = [
  { name: 'Ubuntu-24.04', version: 2, state: 'running', isDefault: true },
  { name: 'Debian', version: 2, state: 'running', isDefault: false },
]

describe('workspace path classification', () => {
  it('keeps ordinary Windows paths on the Windows filesystem', () => {
    const result = classifyWorkspacePath('C:\\src\\api', {
      platform: 'win32',
      distros,
    })

    expect(result).toMatchObject({
      kind: 'local',
      hostPath: 'C:\\src\\api',
      key: 'local:win32:c:\\src\\api',
    })
  })

  it.each([
    '\\\\wsl$\\Ubuntu-24.04\\home\\me\\api',
    '\\\\wsl.localhost\\ubuntu-24.04\\home\\me\\api',
  ])('canonicalises both WSL UNC spellings (%s)', (input) => {
    const result = classifyWorkspacePath(input, { platform: 'win32', distros })

    expect(result).toEqual({
      kind: 'wsl',
      distro: 'Ubuntu-24.04',
      linuxPath: '/home/me/api',
      hostPath: '\\\\wsl.localhost\\Ubuntu-24.04\\home\\me\\api',
      key: 'wsl:ubuntu-24.04:/home/me/api',
    })
  })

  it('treats an explicitly distro-local path as the same location as its UNC form', () => {
    const local = classifyWorkspacePath('/home/me/api', {
      platform: 'win32',
      distro: 'Ubuntu-24.04',
      distros,
    })
    const unc = classifyWorkspacePath('\\\\wsl$\\Ubuntu-24.04\\home\\me\\api', {
      platform: 'win32',
      distros,
    })

    expect(sameWorkspacePath(local, unc)).toBe(true)
  })

  it('keeps the distro in filesystem identity even when path tails match', () => {
    const ubuntu = classifyWorkspacePath('\\\\wsl$\\Ubuntu-24.04\\home\\me\\api', {
      platform: 'win32',
      distros,
    })
    const debian = classifyWorkspacePath('\\\\wsl$\\Debian\\home\\me\\api', {
      platform: 'win32',
      distros,
    })

    expect(ubuntu.kind).toBe('wsl')
    expect(debian.kind).toBe('wsl')
    expect(sameWorkspacePath(ubuntu, debian)).toBe(false)
    expect(ubuntu.key).not.toBe(debian.key)
  })

  it('preserves Linux case sensitivity within one distro', () => {
    const lower = classifyWorkspacePath('/home/me/api', {
      platform: 'win32',
      distro: 'Ubuntu-24.04',
      distros,
    })
    const upper = classifyWorkspacePath('/home/me/API', {
      platform: 'win32',
      distro: 'Ubuntu-24.04',
      distros,
    })

    expect(sameWorkspacePath(lower, upper)).toBe(false)
  })

  it('reports a missing or renamed distro as unavailable', () => {
    expect(
      classifyWorkspacePath('\\\\wsl$\\Arch\\home\\me\\api', {
        platform: 'win32',
        distros,
      }),
    ).toEqual({
      kind: 'unavailable',
      input: '\\\\wsl$\\Arch\\home\\me\\api',
      distro: 'Arch',
      reason: 'The Arch WSL distro is not installed. It may have been unregistered or renamed.',
    })
  })

  it('reports a stopped distro plainly instead of pretending the folder is missing', () => {
    const stopped: WslDistro[] = [
      { name: 'Ubuntu-24.04', version: 2, state: 'stopped', isDefault: true },
    ]

    expect(
      classifyWorkspacePath('/home/me/api', {
        platform: 'win32',
        distro: 'Ubuntu-24.04',
        distros: stopped,
      }),
    ).toMatchObject({
      kind: 'unavailable',
      distro: 'Ubuntu-24.04',
      reason: 'The Ubuntu-24.04 WSL distro this project lives in is not running.',
    })
  })

  it('rejects WSL 1 explicitly instead of half-supporting it', () => {
    const legacy: WslDistro[] = [
      { name: 'Legacy', version: 1, state: 'running', isDefault: true },
    ]

    expect(
      classifyWorkspacePath('/home/me/api', {
        platform: 'win32',
        distro: 'Legacy',
        distros: legacy,
      }),
    ).toMatchObject({
      kind: 'unavailable',
      distro: 'Legacy',
      reason: 'Legacy uses WSL 1. AllMyAgents currently requires WSL 2.',
    })
  })

  it('requires a concrete distro for a distro-local path', () => {
    expect(
      classifyWorkspacePath('/home/me/api', {
        platform: 'win32',
        distros,
      }),
    ).toMatchObject({
      kind: 'unavailable',
      reason: 'Choose a WSL distro for the Linux path /home/me/api.',
    })
  })

  it('does not interpret POSIX paths as WSL on macOS or Linux', () => {
    expect(classifyWorkspacePath('/home/me/api', { platform: 'linux' })).toMatchObject({
      kind: 'local',
      hostPath: '/home/me/api',
      key: 'local:linux:/home/me/api',
    })
    expect(classifyWorkspacePath('/Users/me/api', { platform: 'darwin' })).toMatchObject({
      kind: 'local',
      key: 'local:darwin:/Users/me/api',
    })
  })
})

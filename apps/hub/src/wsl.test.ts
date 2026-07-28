import { describe, expect, it, vi } from 'vitest'
import { parseWslDistroList, WslService } from './wsl.js'

describe('WSL inventory', () => {
  it('parses the verbose list, including the actual default distro and versions', () => {
    const output = [
      '  NAME                   STATE           VERSION',
      '* Ubuntu-24.04           Running         2',
      '  Debian                 Stopped         2',
      '  Legacy                 Running         1',
      '  docker-desktop         Stopped         2',
      '',
    ].join('\r\n')

    expect(parseWslDistroList(output)).toEqual([
      { name: 'Ubuntu-24.04', state: 'running', version: 2, isDefault: true },
      { name: 'Debian', state: 'stopped', version: 2, isDefault: false },
      { name: 'Legacy', state: 'running', version: 1, isDefault: false },
      { name: 'docker-desktop', state: 'stopped', version: 2, isDefault: false },
    ])
  })

  it('decodes the UTF-16LE output wsl.exe emits when stdout is redirected', () => {
    const output = Buffer.from(
      '* Ubuntu-24.04    Running    2\r\n  Debian    Stopped    2\r\n',
      'utf16le',
    )

    expect(parseWslDistroList(output)).toHaveLength(2)
    expect(parseWslDistroList(output)[0]).toMatchObject({
      name: 'Ubuntu-24.04',
      isDefault: true,
    })
  })

  it('does not probe WSL on macOS or Linux', async () => {
    const run = vi.fn()
    const service = new WslService({ platform: 'linux', run })

    await expect(service.capability()).resolves.toEqual({
      supported: false,
      reason: 'WSL is available only on Windows.',
      distros: [],
      docker: { available: false, reason: 'Docker/WSL targets are available only on Windows.' },
    })
    expect(run).not.toHaveBeenCalled()
  })

  it('enumerates ordinary distros separately from Docker Desktop and reports a down daemon', async () => {
    const run = vi.fn(async (program: string, args: readonly string[]) => {
      if (program === 'wsl.exe') {
        return {
          exitCode: 0,
          stdout:
            '* Ubuntu-24.04 Running 2\r\n  Debian Stopped 2\r\n  docker-desktop Stopped 2\r\n',
          stderr: '',
        }
      }
      expect(program).toBe('docker')
      expect(args).toEqual(['version', '--format', '{{.Server.Version}}'])
      return { exitCode: 1, stdout: '', stderr: 'daemon is not running' }
    })
    const service = new WslService({ platform: 'win32', run })

    await expect(service.capability()).resolves.toEqual({
      supported: true,
      distros: [
        { name: 'Ubuntu-24.04', state: 'running', version: 2, isDefault: true },
        { name: 'Debian', state: 'stopped', version: 2, isDefault: false },
      ],
      docker: {
        available: false,
        reason: 'Docker Desktop is installed, but its Linux engine is not running.',
      },
    })
  })
})

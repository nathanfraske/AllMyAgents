import { describe, expect, it } from 'vitest'
import { buildWslSpawnSpec } from './wslProcess.js'

describe('native WSL process launch', () => {
  it('keeps the distro and Linux cwd in argv while carrying secrets only through the environment', () => {
    const spec = buildWslSpawnSpec(
      'Ubuntu-24.04',
      '/home/me/api',
      '/usr/local/bin/codex',
      ['app-server'],
      {
        CODEX_HOME: '/mnt/c/Users/Me/codex-wsl',
        AMA_SECRET: 'do-not-put-me-in-argv',
      },
    )

    expect(spec.program).toBe('wsl.exe')
    expect(spec.args).toEqual([
      '--distribution',
      'Ubuntu-24.04',
      '--cd',
      '/home/me/api',
      '--exec',
      '/usr/local/bin/codex',
      'app-server',
    ])
    expect(spec.args.join(' ')).not.toContain('do-not-put-me-in-argv')
    expect(spec.env.AMA_SECRET).toBe('do-not-put-me-in-argv')
    expect(spec.env.WSLENV?.split(':')).toEqual(
      expect.arrayContaining(['CODEX_HOME', 'AMA_SECRET']),
    )
  })
})

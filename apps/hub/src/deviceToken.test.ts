import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getOrCreateDeviceToken } from './deviceToken.js'

const roots: string[] = []

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true })
})

describe('device token storage', () => {
  it('repairs permissions on an existing token as well as a newly-created one', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-device-token-'))
    roots.push(root)
    const file = path.join(root, 'device-token.txt')
    const token = 'existing-device-token-that-is-long-enough'
    fs.writeFileSync(file, token)

    expect(getOrCreateDeviceToken(root)).toBe(token)

    if (process.platform === 'win32') {
      const acl = execFileSync('icacls', [file], { encoding: 'utf8', windowsHide: true })
      expect(acl).not.toMatch(/CodexSandboxUsers/i)
      expect(acl).not.toMatch(/Users:\((?:RX|R)\)/i)
    } else {
      expect(fs.statSync(file).mode & 0o077).toBe(0)
    }
  })
})

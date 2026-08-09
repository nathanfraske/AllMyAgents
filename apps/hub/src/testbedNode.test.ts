import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  appendTestbedAudit,
  configureTestbedNode,
  issueTestbedPairingCode,
  machineRoots,
  readTestbedNodeConfig,
} from './testbedNode.js'

const roots: string[] = []

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-testbed-node-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('lightweight testbed node configuration', () => {
  it('fails closed when a scoped node has no explicit roots', () => {
    const dataDir = temporaryRoot()
    expect(() => configureTestbedNode({ dataDir, profile: 'scoped' })).toThrow(/at least one explicit root/u)
    expect(fs.existsSync(path.join(dataDir, 'node-config.json'))).toBe(false)
  })

  it('canonicalizes and persists only the requested scoped capabilities', () => {
    const dataDir = temporaryRoot()
    const approved = path.join(dataDir, 'approved')
    fs.mkdirSync(approved)
    const configured = configureTestbedNode({
      dataDir,
      profile: 'scoped',
      roots: [{ label: 'Build sandbox', path: approved, read: true, write: true, terminal: false }],
    })
    expect(configured).toMatchObject({ profile: 'scoped' })
    expect(configured.roots).toEqual([expect.objectContaining({
      label: 'Build sandbox',
      path: fs.realpathSync.native(approved),
      read: true,
      write: true,
      terminal: false,
    })])
    expect(readTestbedNodeConfig(dataDir)).toEqual(configured)
    const policy = JSON.parse(fs.readFileSync(path.join(dataDir, 'device-executor.json'), 'utf8')) as {
      enabled: boolean
      roots: Array<{ id: string }>
    }
    expect(policy.enabled).toBe(true)
    expect(policy.roots[0]?.id).toMatch(/^root_[0-9a-f]{20}$/u)
  })

  it('describes a whole Linux host and does not pretend WSL is a Linux-host environment', () => {
    expect(machineRoots('linux', [{
      id: 'wsl:Ubuntu',
      kind: 'wsl',
      label: 'Ubuntu',
      platform: 'linux',
      shell: '/bin/sh',
      distro: 'Ubuntu',
    }])).toEqual([{ id: '', label: 'Host filesystem', path: '/', read: true, write: true, terminal: true }])
  })

  it('stores only a digest for a short-lived human pairing code', () => {
    const dataDir = temporaryRoot()
    const code = issueTestbedPairingCode(dataDir, new Date('2026-08-08T12:00:00.000Z'))
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/u)
    const claim = fs.readFileSync(path.join(dataDir, 'pairing-code.json'), 'utf8')
    expect(claim).not.toContain(code)
    expect(claim).toContain('2026-08-08T12:10:00.000Z')
  })

  it('keeps a bounded local audit without recording implicit command content', () => {
    const dataDir = temporaryRoot()
    appendTestbedAudit(dataDir, 'device/action', { op: 'exec', ok: true, targetMs: 14 })
    const event = JSON.parse(fs.readFileSync(path.join(dataDir, 'audit.jsonl'), 'utf8')) as Record<string, unknown>
    expect(event).toMatchObject({ kind: 'device/action', op: 'exec', ok: true, targetMs: 14 })
    expect(event).not.toHaveProperty('command')
  })
})

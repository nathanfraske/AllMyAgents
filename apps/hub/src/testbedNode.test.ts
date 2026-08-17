import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  appendTestbedAudit,
  configureTestbedNode,
  detectMyOwnMeshSocketPath,
  issueTestbedPairingCode,
  machineRoots,
  readTestbedNodeConfig,
  readTestbedBuildIdentity,
  renderLinuxToolchainProfile,
  renderLinuxTestbedService,
  sshHostKeyFingerprints,
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

  it('keeps automatic fleet trust off unless the operator explicitly enables it', () => {
    const dataDir = temporaryRoot()
    const approved = path.join(dataDir, 'approved')
    fs.mkdirSync(approved)
    const safe = configureTestbedNode({
      dataDir,
      profile: 'scoped',
      roots: [{ label: 'Build sandbox', path: approved, read: true, write: false, terminal: false }],
    })
    expect(safe.fleetTrustExchange).toBeUndefined()
    const optedIn = configureTestbedNode({
      dataDir,
      profile: 'scoped',
      fleetTrustExchange: true,
      roots: [{ label: 'Build sandbox', path: approved, read: true, write: false, terminal: false }],
    })
    expect(readTestbedNodeConfig(dataDir).fleetTrustExchange).toBe(true)
    expect(optedIn.fleetTrustExchange).toBe(true)
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

  it('reports a checksum-backed portable build identity and mesh-attested public SSH fingerprints', () => {
    const root = temporaryRoot()
    fs.mkdirSync(path.join(root, 'dist'))
    fs.writeFileSync(path.join(root, 'dist', 'testbedNode.js'), 'node-v2')
    fs.writeFileSync(path.join(root, 'dist', 'remoteDevices.js'), 'remote-v2')
    fs.writeFileSync(path.join(root, 'build.json'), JSON.stringify({ appVersion: '0.1.28', sourceCommit: 'a'.repeat(40) }))
    const files = ['dist/testbedNode.js', 'dist/remoteDevices.js']
    fs.writeFileSync(path.join(root, 'SHA256SUMS'), `${files.map((relative) =>
      `${crypto.createHash('sha256').update(fs.readFileSync(path.join(root, relative))).digest('hex')}  ${relative}`).join('\n')}\n`)
    expect(readTestbedBuildIdentity(root)).toMatchObject({
      appVersion: '0.1.28',
      sourceCommit: 'a'.repeat(40),
      payloadId: expect.stringMatching(/^[0-9a-f]{64}$/u),
      codePayloadId: expect.stringMatching(/^[0-9a-f]{64}$/u),
    })

    const ssh = path.join(root, 'ssh')
    fs.mkdirSync(ssh)
    fs.writeFileSync(path.join(ssh, 'ssh_host_ed25519_key.pub'), `ssh-ed25519 ${Buffer.from('public-key-fixture').toString('base64')} host\n`)
    expect(sshHostKeyFingerprints(ssh)).toEqual([expect.stringMatching(/^ssh-ed25519 SHA256:/u)])
  })

  it('pins the observed mesh socket and orders the testbed after MyOwnMesh without coupling lifetimes', () => {
    expect(detectMyOwnMeshSocketPath(
      { MYOWNMESH_HOME: '/ignored' },
      '/home/testbed',
      (candidate) => candidate === '/var/lib/myownmesh/daemon.sock',
    )).toBe('/var/lib/myownmesh/daemon.sock')
    const unit = renderLinuxTestbedService({
      installRoot: '/home/admini/amt',
      dataDir: '/home/admini/amt/data',
      profile: 'elevated-machine',
      socketPath: '/var/lib/myownmesh/daemon.sock',
    })
    expect(unit).toContain('After=network-online.target myownmesh.service')
    expect(unit).not.toContain('Requires=myownmesh.service')
    expect(unit).toContain('MYOWNMESH_CONTROL_SOCKET=/var/lib/myownmesh/daemon.sock')
    expect(unit).toContain('ALLMYAGENTS_TOOLCHAIN_HOME=/opt/allmyagents-toolchains')
    expect(unit).toContain('RUSTUP_HOME=/opt/allmyagents-toolchains/rustup')
    expect(unit).toContain('CARGO_INSTALL_ROOT=/opt/allmyagents-toolchains')
    expect(unit).toContain('/root/.cargo/bin')
    expect(unit).not.toContain('CARGO_HOME=')
    expect(unit).toContain('UMask=0022')
  })

  it('makes shared compilers visible to ordinary logins without sharing their writable Cargo cache', () => {
    const profile = renderLinuxToolchainProfile({
      toolchainHome: '/opt/allmyagents-toolchains',
      rustupHome: '/opt/rust',
    })
    expect(profile).toContain("export RUSTUP_HOME='/opt/rust'")
    expect(profile).toContain('"$RUSTUP_HOME"/toolchains/*/bin')
    expect(profile).toContain('export PATH')
    expect(profile).not.toContain('CARGO_HOME')
  })
})

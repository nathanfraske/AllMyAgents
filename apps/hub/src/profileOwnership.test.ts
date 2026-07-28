import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProfileOwnership, ProfileOwnershipError } from './profileOwnership.js'

const roots: string[] = []
const tmp = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-profile-owner-'))
  roots.push(dir)
  return dir
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('profile single-writer ownership', () => {
  it('allows only one independent hub to claim a profile', () => {
    const dir = tmp()
    const a = new ProfileOwnership({ ownerId: 'hub-a', pid: process.pid, port: 7819 })
    const b = new ProfileOwnership({ ownerId: 'hub-b', pid: process.pid, port: 7820 })
    expect(a.claim('claude-a', dir).owned).toBe(true)
    expect(b.claim('claude-a', dir)).toMatchObject({
      owned: false,
      owner: { ownerId: 'hub-a', port: 7819 },
    })
  })

  it('reclaims a stale claim whose pid is dead', () => {
    const dir = tmp()
    fs.writeFileSync(
      path.join(dir, '.allmyagents-owner.json'),
      JSON.stringify({ ownerId: 'dead-hub', pid: 2147483647, port: 7788, startedAt: '2020-01-01T00:00:00.000Z' })
    )
    const owner = new ProfileOwnership({ ownerId: 'new-hub', pid: process.pid, port: 7819 })
    expect(owner.claim('claude-a', dir)).toMatchObject({ owned: true, reclaimed: true })
  })

  it('refuses a refresh-capable operation from a non-owner', () => {
    const dir = tmp()
    new ProfileOwnership({ ownerId: 'hub-a', pid: process.pid, port: 7819 }).claim('claude-a', dir)
    const other = new ProfileOwnership({ ownerId: 'hub-b', pid: process.pid, port: 7820 })
    expect(() => other.assertOwned('claude-a', dir, 'refresh credentials')).toThrow(ProfileOwnershipError)
    expect(() => other.assertOwned('claude-a', dir, 'refresh credentials')).toThrow(
      'Another AllMyAgents hub (port 7819) is using claude-a'
    )
  })

  it('lets blue and green generations share one logical supervisor owner', () => {
    const dir = tmp()
    new ProfileOwnership({ ownerId: 'supervisor-1', pid: process.pid, port: 7819 }).claim('claude-a', dir)
    expect(
      new ProfileOwnership({ ownerId: 'supervisor-1', pid: process.pid, port: 7819 }).claim('claude-a', dir).owned
    ).toBe(true)
  })
})

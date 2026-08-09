import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProjectStore } from './projects.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('ProjectStore WSL identity', () => {
  it('persists the concrete distro and native Linux path', () => {
    const db = new Database(':memory:')
    const store = new ProjectStore(db)
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-wsl-project-'))
    roots.push(root)

    const project = store.create('API', root, {
      kind: 'wsl',
      distro: 'Ubuntu-24.04',
      linuxPath: '/home/me/api',
    })

    expect(project.location).toEqual({
      kind: 'wsl',
      distro: 'Ubuntu-24.04',
      linuxPath: '/home/me/api',
    })
    expect(store.get(project.id)?.location).toEqual(project.location)
    expect(store.listReplicas(project.id)).toEqual([
      expect.objectContaining({
        projectId: project.id,
        kind: 'local',
        isPrimary: true,
        path: '/home/me/api',
        environment: expect.objectContaining({ kind: 'wsl', distro: 'Ubuntu-24.04' }),
      }),
    ])
  })

  it('treats the same Linux path in different distros as different projects', () => {
    const db = new Database(':memory:')
    const store = new ProjectStore(db)
    const ubuntuHost = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-ubuntu-project-'))
    const debianHost = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-debian-project-'))
    roots.push(ubuntuHost, debianHost)

    const ubuntu = store.create('Ubuntu API', ubuntuHost, {
      kind: 'wsl',
      distro: 'Ubuntu',
      linuxPath: '/home/me/api',
    })
    const debian = store.create('Debian API', debianHost, {
      kind: 'wsl',
      distro: 'Debian',
      linuxPath: '/home/me/api',
    })

    expect(ubuntu.id).not.toBe(debian.id)
    expect(store.list()).toHaveLength(2)
  })

  it('rejects duplicate UNC aliases for one distro-local project', () => {
    const db = new Database(':memory:')
    const store = new ProjectStore(db)
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-wsl-project-'))
    roots.push(root)
    store.create('API', root, {
      kind: 'wsl',
      distro: 'Ubuntu',
      linuxPath: '/home/me/api',
    })

    expect(() =>
      store.create('Same API', root, {
        kind: 'wsl',
        distro: 'ubuntu',
        linuxPath: '/home/me/api',
      }),
    ).toThrow('already added')
  })

  it('migrates legacy project tables without changing local rows', () => {
    const db = new Database(':memory:')
    db.exec(
      'CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, createdAt TEXT NOT NULL)',
    )
    db.prepare('INSERT INTO projects VALUES (?, ?, ?, ?)').run(
      'legacy',
      'Legacy',
      'C:\\src\\legacy',
      '2026-01-01T00:00:00.000Z',
    )

    const store = new ProjectStore(db)

    expect(store.get('legacy')).toEqual({
      id: 'legacy',
      name: 'Legacy',
      path: 'C:\\src\\legacy',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    expect(store.listReplicas('legacy')).toEqual([
      expect.objectContaining({
        projectId: 'legacy',
        kind: 'local',
        path: 'C:\\src\\legacy',
        isPrimary: true,
        environment: expect.objectContaining({ id: 'host', kind: 'host' }),
      }),
    ])
  })

  it('registers one explicit remote root idempotently and keeps the primary local location', () => {
    const db = new Database(':memory:')
    const store = new ProjectStore(db)
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-replica-project-'))
    roots.push(root)
    const project = store.create('Fleet project', root)

    const first = store.addRemoteReplica({
      projectId: project.id,
      siteId: 'site-laptop',
      siteLabel: 'Laptop',
      rootId: 'root_checkout',
      path: '/home/nathan/project',
      environment: { kind: 'wsl', distro: 'Ubuntu' },
    })
    const repeated = store.addRemoteReplica({
      projectId: project.id,
      siteId: 'site-laptop',
      siteLabel: 'Renamed label does not mint a duplicate',
      rootId: 'root_checkout',
      path: '/different/caller/value',
      environment: { kind: 'wsl', distro: 'Ubuntu' },
    })

    expect(repeated.id).toBe(first.id)
    expect(store.listReplicas(project.id)).toHaveLength(2)
    expect(store.updateReplicaReadiness(project.id, first.id, {
      status: 'dirty',
      gitAvailable: true,
      isRepository: true,
      complete: true,
      clean: false,
      trackedChanges: 2,
      untrackedFiles: 1,
      checkedAt: '2026-08-08T12:00:00.000Z',
      headCommit: 'a'.repeat(40),
      headRef: 'main',
    })).toMatchObject({
      state: 'registered',
      headCommit: 'a'.repeat(40),
      headRef: 'main',
      readiness: { status: 'dirty', trackedChanges: 2, untrackedFiles: 1 },
    })
    expect(store.primaryReplica(project.id)?.kind).toBe('local')
    expect(() => store.removeReplica(project.id, store.primaryReplica(project.id)!.id)).toThrow('primary')
    expect(store.removeReplica(project.id, first.id)).toBe(true)
    expect(store.listReplicas(project.id)).toHaveLength(1)
    store.remove(project.id)
    expect(store.listReplicas(project.id)).toEqual([])
  })
})

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
  })
})

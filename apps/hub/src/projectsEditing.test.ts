import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { ProjectStore } from './projects.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('project editing', () => {
  it('renames a project without changing its filesystem identity or creation time', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-project-edit-'))
    roots.push(root)
    const projectDir = path.join(root, 'project')
    fs.mkdirSync(projectDir)
    const db = new Database(path.join(root, 'hub.db'))
    const projects = new ProjectStore(db)
    const created = projects.create('Original', projectDir)

    const updated = projects.updateName(created.id, '  Renamed project  ')

    expect(updated).toEqual({ ...created, name: 'Renamed project' })
    expect(() => projects.updateName(created.id, '   ')).toThrow(/name is required/i)
    expect(() => projects.updateName('missing', 'Name')).toThrow(/unknown project/i)
    db.close()
  })
})

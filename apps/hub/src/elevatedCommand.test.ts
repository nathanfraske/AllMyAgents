import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Journal } from './journal.js'
import {
  analyzeElevatedCommand,
  ProjectElevationPolicyStore,
} from './elevatedCommand.js'

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.()
})

describe('project elevation policy and blast-radius analysis', () => {
  it('defaults disabled and persists an operator-defined project scope', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-elevation-'))
    const project = path.join(root, 'project')
    const cache = path.join(root, 'cache')
    fs.mkdirSync(project)
    fs.mkdirSync(cache)
    const journal = new Journal(path.join(root, 'hub.db'))
    cleanups.push(() => { journal.db.close(); fs.rmSync(root, { recursive: true, force: true }) })
    const store = new ProjectElevationPolicyStore(journal.db)

    expect(store.get('p1', project)).toMatchObject({ scope: 'disabled', allowedRoots: [path.resolve(project)] })
    expect(store.set('p1', project, 'project', [cache])).toMatchObject({
      scope: 'project',
      allowedRoots: [path.resolve(project), path.resolve(cache)],
    })
    expect(store.get('p1', project)).toMatchObject({ scope: 'project' })
  })

  it('blocks an obvious project-scope escape and explains machine-wide risk', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-elevation-analysis-'))
    const project = path.join(root, 'project')
    const outside = path.join(root, 'outside', 'settings.json')
    fs.mkdirSync(project)
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }))
    const base = {
      projectId: 'p1',
      scope: 'project' as const,
      allowedRoots: [project],
      updatedAt: new Date().toISOString(),
    }

    const scoped = analyzeElevatedCommand(`Get-Content "${outside}"`, base, project)
    expect(scoped.mayProceed).toBe(false)
    expect(scoped.outsideAllowedRoots).toContain(path.resolve(outside))
    expect(scoped.findings).toContainEqual(expect.objectContaining({ code: 'literal-path-outside-scope' }))
    expect(scoped.scopeEnforcement).toMatch(/not an OS sandbox/u)

    const machine = analyzeElevatedCommand(
      `Remove-Item -Recurse -Force "${outside}"`,
      { ...base, scope: 'machine' },
      project,
    )
    expect(machine.mayProceed).toBe(true)
    expect(machine.risk).toBe('critical')
    expect(machine.findings).toContainEqual(expect.objectContaining({ code: 'destructive-filesystem' }))
  })
})

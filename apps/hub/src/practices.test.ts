import { describe, expect, it, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { PracticeStore, decidePracticeGate, practiceScope } from './practices.js'
import type { SessionIdentity } from './identity.js'
import type { DangerFlags } from './types.js'

function freshStore(): PracticeStore {
  return new PracticeStore(new Database(':memory:'))
}

const SAFE: DangerFlags = { busCanUseRiskyTools: false, autoApprovePractices: false }

describe('PracticeStore (persistence + provenance)', () => {
  let store: PracticeStore
  beforeEach(() => {
    store = freshStore()
  })

  it('writes with provenance and reads back by id', () => {
    const p = store.write({ scope: 'account:a1', title: 'Use pnpm', body: 'always pnpm, never npm', fromSession: 's1', fromProfile: 'a1' })
    const got = store.get(p.id)
    expect(got?.title).toBe('Use pnpm')
    expect(got?.body).toBe('always pnpm, never npm')
    expect(got?.fromSession).toBe('s1')
    expect(got?.fromProfile).toBe('a1')
    expect(got?.createdAt).toBeTruthy()
  })

  it('get() is scope-constrained: outside the readable set returns undefined', () => {
    const p = store.write({ scope: 'project:p2', title: 'secret', body: 'not yours' })
    expect(store.get(p.id, ['project:p1', 'account:a1'])).toBeUndefined()
    expect(store.get(p.id, ['project:p2'])?.title).toBe('secret')
  })

  it('edit() patches title/body, bumps updatedAt, and leaves scope + provenance intact', async () => {
    const p = store.write({ scope: 'account:a1', title: 'old', body: 'old body', fromSession: 's1', fromProfile: 'a1' })
    await new Promise((r) => setTimeout(r, 2)) // ensure a distinct updatedAt
    const edited = store.edit(p.id, { title: 'new' })
    expect(edited?.title).toBe('new')
    expect(edited?.body).toBe('old body')
    expect(edited?.scope).toBe('account:a1')
    expect(edited?.fromSession).toBe('s1')
    expect(edited?.updatedAt).not.toBe(p.updatedAt)
  })

  it('list() filters by scope; [] scopes returns nothing; undefined returns all (operator view)', () => {
    store.write({ scope: 'account:a1', title: 'A', body: 'x' })
    store.write({ scope: 'project:p1', title: 'B', body: 'y' })
    store.write({ scope: 'global', title: 'C', body: 'z' })
    expect(store.list({ scopes: ['account:a1'] }).map((p) => p.title)).toEqual(['A'])
    expect(store.list({ scopes: [] })).toEqual([])
    expect(store.list().length).toBe(3)
  })

  it('remove() hard-deletes (the revoke kill-switch)', () => {
    const p = store.write({ scope: 'global', title: 'gone', body: 'soon' })
    store.remove(p.id)
    expect(store.get(p.id)).toBeUndefined()
  })
})

describe('PracticeStore.materialize (the labeled block)', () => {
  it('renders applicable scopes general → specific, each with a provenance line', () => {
    const store = freshStore()
    store.write({ scope: 'global', title: 'Global rule', body: 'be terse', fromSession: 'sess-global-1', fromProfile: 'ops' })
    store.write({ scope: 'project:p1', title: 'Project rule', body: 'run typecheck first', fromSession: 'sess-proj-1', fromProfile: 'codex-b' })
    store.write({ scope: 'account:a1', title: 'Account rule', body: 'prefer vitest', fromSession: 'sess-acct-1', fromProfile: 'a1' })
    store.write({ scope: 'project:other', title: 'Not applicable', body: 'skip me' })

    const text = store.materialize({ provider: 'claude', projectId: 'p1', profileId: 'a1' })
    // General → specific ordering.
    expect(text.indexOf('Global rule')).toBeLessThan(text.indexOf('Project rule'))
    expect(text.indexOf('Project rule')).toBeLessThan(text.indexOf('Account rule'))
    // Out-of-scope practice excluded.
    expect(text).not.toContain('Not applicable')
    // Provenance rides each entry.
    expect(text).toContain('[project] Project rule')
    expect(text).toContain('profile codex-b')
    expect(text).toContain('scope project:p1')
  })

  it('returns empty string when nothing applies', () => {
    const store = freshStore()
    store.write({ scope: 'project:elsewhere', title: 'X', body: 'y' })
    expect(store.materialize({ provider: 'codex', projectId: 'p1', profileId: 'a1' })).toBe('')
  })
})

describe('practiceScope (scope-kind resolution against caller identity)', () => {
  const id: SessionIdentity = { sessionId: 's1', profileId: 'a1', provider: 'claude', projectId: 'p1', label: 'x' }
  const noProject: SessionIdentity = { sessionId: 's2', profileId: 'a2', provider: 'codex', label: 'y' }

  it('default + account → the caller own account shelf', () => {
    expect(practiceScope(id)).toBe('account:a1')
    expect(practiceScope(id, 'account')).toBe('account:a1')
  })
  it('project → the caller project, falling back to account when not in a project', () => {
    expect(practiceScope(id, 'project')).toBe('project:p1')
    expect(practiceScope(noProject, 'project')).toBe('account:a2')
  })
  it('global and vendor map to the fleet scopes', () => {
    expect(practiceScope(id, 'global')).toBe('global')
    expect(practiceScope(id, 'vendor')).toBe('vendor:claude')
    expect(practiceScope(noProject, 'vendor')).toBe('vendor:codex')
  })
})

describe('decidePracticeGate (the scope gradient + Danger Zone overrides)', () => {
  it('own-account writes are auto-allowed (no prompt)', () => {
    expect(decidePracticeGate({ ownAccount: true, isBusTurn: false, danger: SAFE })).toEqual({ action: 'allow' })
  })

  it('project/global/vendor writes require operator approval by default', () => {
    expect(decidePracticeGate({ ownAccount: false, isBusTurn: false, danger: SAFE })).toEqual({ action: 'approve' })
  })

  it('bus turns are hard-denied by default — even for own-account scope', () => {
    expect(decidePracticeGate({ ownAccount: true, isBusTurn: true, danger: SAFE })).toEqual({ action: 'deny-bus' })
    expect(decidePracticeGate({ ownAccount: false, isBusTurn: true, danger: SAFE })).toEqual({ action: 'deny-bus' })
  })

  it('busCanUseRiskyTools override lets a bus turn through (then the normal gradient applies)', () => {
    const danger: DangerFlags = { busCanUseRiskyTools: true, autoApprovePractices: false }
    expect(decidePracticeGate({ ownAccount: true, isBusTurn: true, danger })).toEqual({ action: 'allow' })
    expect(decidePracticeGate({ ownAccount: false, isBusTurn: true, danger })).toEqual({ action: 'approve' })
  })

  it('autoApprovePractices override skips the operator prompt for above-account writes', () => {
    const danger: DangerFlags = { busCanUseRiskyTools: false, autoApprovePractices: true }
    expect(decidePracticeGate({ ownAccount: false, isBusTurn: false, danger })).toEqual({ action: 'allow' })
  })

  it('the bus hard-deny still wins over autoApprovePractices (bus safety is independent)', () => {
    const danger: DangerFlags = { busCanUseRiskyTools: false, autoApprovePractices: true }
    expect(decidePracticeGate({ ownAccount: false, isBusTurn: true, danger })).toEqual({ action: 'deny-bus' })
  })
})

import { describe, expect, it, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { MemoryStore } from './memory.js'

function freshStore(): MemoryStore {
  return new MemoryStore(new Database(':memory:'))
}

describe('MemoryStore.recall (automatic hub-side recall)', () => {
  let store: MemoryStore
  beforeEach(() => {
    store = freshStore()
  })

  it('surfaces memories whose title/body overlaps the prompt, ranked by hit count', () => {
    store.write({ scope: 'project:p1', title: 'Deploy pipeline', body: 'the deploy pipeline uses the staging worktree' })
    store.write({ scope: 'project:p1', title: 'Auth flow', body: 'login uses oauth refresh tokens' })
    const hits = store.recall('how do I run the deploy pipeline for staging?', { scopes: ['project:p1'] })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.title).toBe('Deploy pipeline')
  })

  it('returns nothing when no salient term matches', () => {
    store.write({ scope: 'account:a1', title: 'Colors', body: 'the theme accent is magenta' })
    expect(store.recall('quantum chromodynamics lagrangian', { scopes: ['account:a1'] })).toEqual([])
  })

  it('only recalls from the readable scopes it is given', () => {
    store.write({ scope: 'project:p1', title: 'pipeline note', body: 'pipeline detail' })
    store.write({ scope: 'project:p2', title: 'pipeline other', body: 'pipeline other detail' })
    const hits = store.recall('pipeline', { scopes: ['project:p1'] })
    expect(hits.map((m) => m.scope)).toEqual(['project:p1'])
  })

  it('ignores stopwords and short tokens (a prompt of only those recalls nothing)', () => {
    store.write({ scope: 'global', title: 'the and for with', body: 'this that from into' })
    expect(store.recall('the and for with this', { scopes: ['global'] })).toEqual([])
  })

  it('caps results at the limit', () => {
    for (let i = 0; i < 8; i++) store.write({ scope: 'global', title: `pipeline ${i}`, body: 'pipeline pipeline' })
    expect(store.recall('pipeline', { scopes: ['global'], limit: 3 }).length).toBe(3)
  })
})

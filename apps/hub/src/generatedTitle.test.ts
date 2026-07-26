import { describe, expect, it } from 'vitest'
import { generatedTitle, CHAT_NAMES } from './title.js'

/**
 * New chats are named after scientists, from their own session id.
 *
 * The determinism is the requirement, not a nicety. The name is derived from the id so the hub, a
 * journal replay, and a restart all produce the same one — a chat whose name changed after a reload
 * would be worse than an unnamed chat. It also means the client must never roll its own: two
 * independent "randoms" cannot agree, which is why this takes a seed instead of calling Math.random.
 */
describe('generatedTitle', () => {
  it('is stable for a given session id', () => {
    const id = '0629701e-f848-4c60-8b23-2e0c980c2f92'
    expect(generatedTitle(id)).toBe(generatedTitle(id))
  })

  it('returns a name from the pool', () => {
    expect(CHAT_NAMES).toContain(generatedTitle('any-session-id') as (typeof CHAT_NAMES)[number])
  })

  it('gives different ids different names (not one hot name for everything)', () => {
    const names = new Set(Array.from({ length: 12 }, (_, i) => generatedTitle(`session-${i}`)))
    expect(names.size).toBeGreaterThan(1)
  })

  /** Fermi / Curie / Hopper reads better than Fermi / Fermi 2 / Fermi 3, so collisions walk the pool. */
  it('picks another scientist rather than suffixing while the pool has room', () => {
    const first = generatedTitle('collide')
    const second = generatedTitle('collide', [first])
    expect(second).not.toBe(first)
    expect(second).not.toMatch(/\d/)
    expect(CHAT_NAMES).toContain(second as (typeof CHAT_NAMES)[number])
  })

  it('suffixes deterministically once every name is taken', () => {
    const all = [...CHAT_NAMES]
    const next = generatedTitle('exhausted', all)
    expect(next).toMatch(/ 2$/)
    expect(generatedTitle('exhausted', all)).toBe(next) // still deterministic at the boundary
    expect(generatedTitle('exhausted', [...all, next])).toMatch(/ 3$/)
  })

  it('never returns a name already in use', () => {
    const taken = new Set<string>()
    for (let i = 0; i < CHAT_NAMES.length + 5; i++) {
      const name = generatedTitle(`s-${i}`, taken)
      expect(taken.has(name)).toBe(false)
      taken.add(name)
    }
  })
})

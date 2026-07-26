import { describe, expect, it } from 'vitest'
import { generatedTitle, CHAT_NAMES, WOMEN_CHAT_NAMES, MEN_CHAT_NAMES } from './title.js'

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

/**
 * The owner picks the pool in Settings: women, or everyone. There is deliberately no men-only option.
 *
 * Every property the unpooled generator had has to survive per pool — determinism above all — and the
 * choice has to actually reach the names, which is what these pin. Enough ids to be decisive rather than
 * lucky: with ~53% of the full pool being men, one id proves very little either way.
 */
describe('generatedTitle name pools', () => {
  const women = new Set<string>(WOMEN_CHAT_NAMES)
  const men = new Set<string>(MEN_CHAT_NAMES)
  const ids = Array.from({ length: 60 }, (_, i) => `pool-session-${i}`)

  it('draws only from the women when that is the choice', () => {
    const picked = ids.map((id) => generatedTitle(id, [], 'women'))
    expect(picked.filter((n) => !women.has(n))).toEqual([]) // names the pool should never have offered
    expect(new Set(picked).size).toBeGreaterThan(1) // …and not by collapsing onto one safe name
  })

  it("'everyone' means everyone, not the women's pool with a longer label", () => {
    const picked = ids.map((id) => generatedTitle(id, [], 'everyone'))
    expect(picked.some((n) => men.has(n))).toBe(true)
    expect(picked.some((n) => women.has(n))).toBe(true)
  })

  /** The requirement the whole design rests on, now per pool — and the pool has to change the answer. */
  it('is deterministic within a pool, and the pool is part of the answer', () => {
    for (const id of ids) {
      expect(generatedTitle(id, [], 'women')).toBe(generatedTitle(id, [], 'women'))
      expect(generatedTitle(id, [], 'everyone')).toBe(generatedTitle(id, [], 'everyone'))
    }
    // If the argument were ignored the two pools would agree on every id — this is what catches that.
    expect(ids.some((id) => generatedTitle(id, [], 'women') !== generatedTitle(id, [], 'everyone'))).toBe(true)
  })

  it('walks the chosen pool on a collision instead of escaping into the other one', () => {
    const taken = new Set<string>()
    // Well past the point where an unpooled walk would have wandered into the men, but short of
    // exhausting the women — so every one of these must still be an unsuffixed woman's name.
    for (let i = 0; i < WOMEN_CHAT_NAMES.length - 5; i++) {
      const name = generatedTitle('collide-in-pool', taken, 'women')
      expect(women.has(name)).toBe(true)
      expect(name).not.toMatch(/\d/)
      taken.add(name)
    }
  })

  it('suffixes once the CHOSEN pool is exhausted, not once every name is taken', () => {
    const allWomen = [...WOMEN_CHAT_NAMES]
    const next = generatedTitle('exhausted-women', allWomen, 'women')
    expect(next).toMatch(/ 2$/)
    expect(women.has(next.replace(/ 2$/, ''))).toBe(true) // suffixed a woman, not whoever came next overall
    expect(generatedTitle('exhausted-women', allWomen, 'women')).toBe(next) // deterministic at the boundary
    // The mirror image: the same taken-list leaves 'everyone' with 73 names to spare, so a suffix there
    // would mean the fallback had fired early.
    expect(generatedTitle('exhausted-women', allWomen, 'everyone')).not.toMatch(/\d/)
  })

  /**
   * Existing behaviour is the default. "Only women for this release" is an easy misreading of the
   * request, and it would silently re-name every future chat on hubs that never opened Settings.
   */
  it('defaults to everyone when no pool is passed', () => {
    for (const id of ids) expect(generatedTitle(id)).toBe(generatedTitle(id, [], 'everyone'))
    expect(ids.map((id) => generatedTitle(id)).some((n) => men.has(n))).toBe(true)
  })
})

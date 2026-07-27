import { describe, expect, it } from 'vitest'
import { composeWithPastes, pasteChipLabel, shouldPromotePaste, type PastedText } from './pastePromote'

// New module → mutation-verified (see report). The parity + no-truncation assertions are the point of the
// feature: the content the user pasted must reach the vendor payload IN FULL, on both vendors.

describe('shouldPromotePaste', () => {
  it('promotes at/over the threshold, leaves small pastes alone', () => {
    expect(shouldPromotePaste('x'.repeat(10000), 10000)).toBe(true)
    expect(shouldPromotePaste('x'.repeat(9999), 10000)).toBe(false)
    expect(shouldPromotePaste('a short message', 10000)).toBe(false)
  })
  it('threshold <= 0 disables promotion entirely (ordinary pasting never made weird)', () => {
    expect(shouldPromotePaste('x'.repeat(1_000_000), 0)).toBe(false)
  })
})

describe('composeWithPastes — delivery (both vendors get the FULL content)', () => {
  const blob = (id: string, content: string): PastedText => ({ id, name: `${id}.txt`, content })

  it('is a no-op with no pastes — a normal message is byte-for-byte unchanged', () => {
    expect(composeWithPastes('hello', [])).toBe('hello')
  })

  it('inlines the ENTIRE pasted content, not truncated', () => {
    const big = 'LOG-LINE\n'.repeat(6000) // ~54 KB
    const out = composeWithPastes('why does this fail?', [blob('server', big)])
    expect(out).toContain('why does this fail?')
    expect(out).toContain(big) // the whole thing, verbatim
    expect(out.length).toBeGreaterThanOrEqual(big.length)
    // a unique marker at the very end survives — proves no tail truncation
    const tail = big + 'END-SENTINEL'
    expect(composeWithPastes('', [blob('s', tail)])).toContain('END-SENTINEL')
  })

  it('delivers a paste-only message (empty typed) as just the blob', () => {
    expect(composeWithPastes('   ', [blob('s', 'PAYLOAD')])).toContain('PAYLOAD')
    expect(composeWithPastes('', [blob('s', 'PAYLOAD')]).startsWith('-----')).toBe(true)
  })

  it('keeps multiple pastes, each delimited and complete', () => {
    const out = composeWithPastes('two files', [blob('a', 'AAA'), blob('b', 'BBB')])
    expect(out).toContain('AAA')
    expect(out).toContain('BBB')
    expect(out.indexOf('AAA')).toBeLessThan(out.indexOf('BBB')) // order preserved
  })
})

describe('pasteChipLabel', () => {
  it('shows a size and a line count', () => {
    expect(pasteChipLabel('a\nb\nc')).toMatch(/Pasted text · \d/)
    expect(pasteChipLabel('a\nb\nc')).toContain('3 lines')
    expect(pasteChipLabel('one line')).toContain('1 line')
  })
})

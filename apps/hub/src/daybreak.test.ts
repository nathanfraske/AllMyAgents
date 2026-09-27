import { describe, expect, it, vi } from 'vitest'
import { CodexClient } from './adapters/codex.js'
import { codexCyberAccessProgram, parseCyberAccessProgram, validateDaybreakSelection } from './daybreak.js'

const model = { slug: 'gpt-5.6-sol', name: 'Sol', supportedEfforts: ['low'], serviceTiers: [] }
const blue = { ...model, slug: 'gpt-daybreak-blue-latest' }
const red = { ...model, slug: 'gpt-daybreak-red-latest' }
const account = { provider: 'codex' as const }

describe('account-scoped Daybreak turn selection', () => {
  it.each(['gpt-6-sol', 'gpt-6-luna'])('uses explicit account eligibility for %s without requiring a legacy alias', async slug => {
    const selected = { ...model, slug, cyberAccessPrograms: ['standard', 'daybreakBlue'] as const }
    const catalog = [{ ...selected, cyberAccessPrograms: [...selected.cyberAccessPrograms] }]
    expect(() => validateDaybreakSelection(account, catalog, slug, 'daybreakBlue')).not.toThrow()
    expect(() => validateDaybreakSelection(account, catalog, slug, 'daybreakRed')).toThrow(/does not advertise/)
    expect(() => validateDaybreakSelection(account, [{ ...model, slug, cyberAccessPrograms: [] }, blue], slug, 'daybreakBlue')).toThrow(/does not advertise/)
    const client = new CodexClient('unused', vi.fn())
    const request = vi.spyOn(client, 'request').mockResolvedValue(undefined)
    await client.sendTurn('thread', 'fixture', { model: slug, cyberAccessProgram: 'daybreakBlue' })
    expect(request).toHaveBeenCalledWith('turn/start', expect.objectContaining({ model: slug, cyberAccessProgram: 'daybreakBlue' }))
  })
  it('does not let a legacy alias override explicit access-program denial', () => {
    expect(() => validateDaybreakSelection(account, [{ ...blue, cyberAccessPrograms: [] }], blue.slug, 'daybreakBlue')).toThrow(/does not advertise/)
  })
  it('does not infer program availability from a normal model or fallback', () => {
    for (const catalog of [undefined, [], [model]]) {
      expect(() => validateDaybreakSelection(account, catalog, model.slug, 'daybreakBlue')).toThrow(/does not advertise/)
    }
    expect(() => validateDaybreakSelection(account, [model, blue], model.slug, 'daybreakBlue')).not.toThrow()
    expect(() => validateDaybreakSelection(account, [model, red], model.slug, 'daybreakRed')).not.toThrow()
  })
  it('rejects unknown programs, removed models, cross-provider and mismatched aliases', () => {
    expect(() => parseCyberAccessProgram('daybreak_blue')).toThrow(/Invalid/)
    expect(() => parseCyberAccessProgram(null)).toThrow(/Invalid/)
    expect(() => validateDaybreakSelection(account, [blue], model.slug, 'daybreakBlue')).toThrow(/current catalog/)
    expect(() => validateDaybreakSelection({ provider: 'claude' }, [model, blue], model.slug, 'daybreakBlue')).toThrow(/Codex/)
    expect(() => validateDaybreakSelection(account, [blue, red], red.slug, 'daybreakBlue')).toThrow(/different/)
    expect(() => validateDaybreakSelection(account, [blue], blue.slug, 'standard')).toThrow(/standard model/)
  })
  it.each(['standard', 'daybreakBlue', 'daybreakRed'] as const)('sends explicit %s at the native turn seam, separately from model', async program => {
    const client = new CodexClient('unused', vi.fn())
    const request = vi.spyOn(client, 'request').mockResolvedValue(undefined)
    await client.sendTurn('thread', 'fixture', { model: model.slug, cyberAccessProgram: codexCyberAccessProgram(model.slug, program) })
    expect(request).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledWith('turn/start', expect.objectContaining({ model: model.slug, cyberAccessProgram: program }))
  })
  it('keeps legacy Daybreak aliases on, while ordinary turns explicitly default off', () => {
    expect(codexCyberAccessProgram(blue.slug)).toBe('daybreakBlue')
    expect(codexCyberAccessProgram(red.slug)).toBe('daybreakRed')
    expect(codexCyberAccessProgram(model.slug)).toBe('standard')
    expect(codexCyberAccessProgram()).toBe('standard')
  })
  it('surfaces provider entitlement errors without retrying another program/model', async () => {
    const client = new CodexClient('unused', vi.fn())
    const request = vi.spyOn(client, 'request').mockRejectedValue(Error('model not enabled for Daybreak'))
    await expect(client.sendTurn('thread', 'fixture', { model: model.slug, cyberAccessProgram: 'daybreakBlue' })).rejects.toThrow(/not enabled/)
    expect(request).toHaveBeenCalledTimes(1)
  })
})

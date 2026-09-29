import type { Profile, ProfileAvailableModel } from './types.js'

/** Codex 0.156.1 TurnStartParams, not the Responses API's snake_case values. */
export type CyberAccessProgram = 'standard' | 'daybreakBlue' | 'daybreakRed'

export function parseCyberAccessProgram(value: unknown): CyberAccessProgram | undefined {
  if (value === undefined) return undefined
  if (value === 'standard' || value === 'daybreakBlue' || value === 'daybreakRed') return value
  throw new Error('Invalid Daybreak setting; expected standard, daybreakBlue or daybreakRed')
}

export function daybreakAliasProgram(model?: string): CyberAccessProgram | undefined {
  if (model === 'gpt-daybreak-blue-latest') return 'daybreakBlue'
  if (model === 'gpt-daybreak-red-latest') return 'daybreakRed'
  return undefined
}

/** Catalog presence is an availability hint, never an entitlement grant. The provider remains final. */
export function validateDaybreakSelection(
  profile: Pick<Profile, 'provider'>,
  models: readonly ProfileAvailableModel[] | undefined,
  model: string | undefined,
  program: CyberAccessProgram | undefined,
): void {
  parseCyberAccessProgram(program)
  const alias = daybreakAliasProgram(model)
  if (profile.provider !== 'codex') {
    if (program !== undefined) throw new Error('Daybreak is only supported for Codex accounts')
    return
  }
  if (program === 'standard' && alias) throw new Error('Choose a standard model when turning Daybreak off')
  const requested = program ?? alias
  const selected = models?.find(item => item.slug === model)
  if (requested && selected?.cyberAccessPrograms !== undefined && !selected.cyberAccessPrograms.includes(requested)) {
    throw new Error('This model does not advertise the selected access program for this account. Refresh models or choose another model.')
  }
  if (!requested || requested === 'standard') return
  if (!models?.some(item => item.cyberAccessPrograms !== undefined
    ? item.cyberAccessPrograms.includes(requested) : daybreakAliasProgram(item.slug) === requested)) {
    throw new Error('This account does not advertise that Daybreak program. Refresh its model catalog or turn Daybreak off.')
  }
  if (!selected) {
    throw new Error('Choose a model from this account’s current catalog for Daybreak')
  }
  if (alias && alias !== requested) throw new Error('The selected model alias belongs to a different Daybreak program')
}

/** Explicit Off must not be omitted: omission lets Codex choose its automatic treatment. */
export function codexCyberAccessProgram(model?: string, program?: CyberAccessProgram): CyberAccessProgram {
  return parseCyberAccessProgram(program) ?? daybreakAliasProgram(model) ?? 'standard'
}

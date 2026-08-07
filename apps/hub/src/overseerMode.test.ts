import { describe, expect, it } from 'vitest'
import { applyOverseerModeUpdate, effectiveOverseerMode, overseerModeInstructions } from './overseerMode.js'

describe('Overseer operating modes', () => {
  it('activates Tokenmaxxing with a bounded operator idea pool and explicit no-invented-work rule', () => {
    const config = applyOverseerModeUpdate({}, {
      operatingMode: 'tokenmaxxing',
      maxParallelAgents: 12,
      preferredEffort: 'high',
      guidance: 'Prioritize the oldest reset window.',
      ideaPool: ['Audit recovery', 'Review permissions'],
    })

    expect(effectiveOverseerMode(config)).toMatchObject({
      operatingMode: 'tokenmaxxing',
      policy: { maxParallelAgents: 12, ideaPool: ['Audit recovery', 'Review permissions'] },
    })
    expect(overseerModeInstructions(config)).toMatch(/ask the operator.*capacity.*reset soon/is)
    expect(overseerModeInstructions(config)).toMatch(/not authorization to invent work/i)
  })

  it('reverts to Standard without deleting the reusable mode presets', () => {
    const configured = applyOverseerModeUpdate({}, {
      operatingMode: 'eco',
      ideaPool: ['One focused reproducer'],
      maxParallelAgents: 1,
    })
    const reverted = applyOverseerModeUpdate(configured, { operatingMode: 'standard' })

    expect(effectiveOverseerMode(reverted)).toEqual({ operatingMode: 'standard' })
    expect(reverted.modePolicies?.eco?.ideaPool).toEqual(['One focused reproducer'])
    expect(overseerModeInstructions(reverted)).toMatch(/STANDARD/)
  })

  it('allows an operator to clear optional guidance without deleting the idea pool', () => {
    const configured = applyOverseerModeUpdate({}, {
      operatingMode: 'eco',
      guidance: 'Avoid premium models.',
      ideaPool: ['One reproducer'],
      maxParallelAgents: 1,
    })
    const cleared = applyOverseerModeUpdate(configured, {
      operatingMode: 'eco',
      guidance: '',
    })

    expect(cleared.modePolicies?.eco?.guidance).toBeUndefined()
    expect(cleared.modePolicies?.eco?.ideaPool).toEqual(['One reproducer'])
  })

  it('rejects unbounded swarm sizes and idea pools', () => {
    expect(() => applyOverseerModeUpdate({}, {
      operatingMode: 'tokenmaxxing',
      maxParallelAgents: 17,
    })).toThrow(/1 to 16/)
    expect(() => applyOverseerModeUpdate({}, {
      operatingMode: 'eco',
      ideaPool: Array(21).fill('idea'),
    })).toThrow(/at most 20/)
  })
})

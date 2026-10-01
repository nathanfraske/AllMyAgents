import { expect, it } from 'vitest'
import { createAgentToolSecret, takeAgentToolSecret } from './agentBridgeAuth.js'

it('preserves the supervisor credential through hub flips, rotates on supervisor restart, and removes inherited copies', () => {
  const secret = createAgentToolSecret()
  const blue = { HUB_AGENT_TOOL_SECRET: secret }, green = { HUB_AGENT_TOOL_SECRET: secret }
  expect(takeAgentToolSecret(true, blue)).toBe(secret)
  expect(takeAgentToolSecret(true, green)).toBe(secret)
  expect(blue).toEqual({}); expect(green).toEqual({})
  expect(createAgentToolSecret()).not.toBe(secret)
})

it('isolates standalone/legacy hubs and fails closed on malformed supervised credentials without exposing them', () => {
  const secret = createAgentToolSecret(), env = { HUB_AGENT_TOOL_SECRET: secret }
  expect(takeAgentToolSecret(false, env)).not.toBe(secret)
  expect(env).toEqual({})
  expect(takeAgentToolSecret(true, {})).toMatch(/^[0-9a-f]{64}$/)
  const invalid = { HUB_AGENT_TOOL_SECRET: 'invalid-private-value' }
  expect(() => takeAgentToolSecret(true, invalid)).toThrow('Invalid supervisor agent-tool credential')
  expect(invalid).toEqual({})
})

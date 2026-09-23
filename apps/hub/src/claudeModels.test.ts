import { afterEach, expect, it, vi } from 'vitest'
const query = vi.hoisted(() => vi.fn())
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query }))
import { readClaudeModels } from './claudeModels.js'
afterEach(() => { vi.clearAllMocks(); vi.useRealTimers() })

it('uses metadata control without a prompt; resolves aliases and closes the probe', async () => {
  const close = vi.fn()
  query.mockReturnValue({ close, supportedModels: async () => [
    { value: 'opus', resolvedModel: 'claude-opus-new', displayName: 'New Opus', description: 'A model' },
    { value: 'claude-opus-new', displayName: 'Duplicate' },
  ] })
  const models = await readClaudeModels('account-home')
  expect(models).toEqual([{ slug: 'claude-opus-new', name: 'New Opus', description: 'A model', supportedEfforts: [], serviceTiers: [] }])
  const args = query.mock.calls[0]![0]
  expect(args.options.env.CLAUDE_CONFIG_DIR).toBe('account-home')
  expect(args.options.persistSession).toBe(false)
  expect(args.options.strictMcpConfig).toBe(true)
  expect(await args.prompt.next()).toEqual({ value: undefined, done: true })
  expect(close).toHaveBeenCalledTimes(1)
})
it('closes a failed or hung metadata probe', async () => {
  vi.useFakeTimers()
  const close = vi.fn()
  query.mockReturnValue({ close, supportedModels: () => new Promise(() => {}) })
  const failed = expect(readClaudeModels('unused')).rejects.toThrow('timed out')
  await vi.advanceTimersByTimeAsync(30_000)
  await failed
  expect(close).toHaveBeenCalledTimes(1)
})

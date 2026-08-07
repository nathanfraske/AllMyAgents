import { describe, expect, it, vi, beforeEach } from 'vitest'

/**
 * REGRESSION — our permission modes must never be handed to the SDK's own permissionMode.
 *
 * ClaudeDriver used to map `full` → 'bypassPermissions' and `edits` → 'acceptEdits'. That does not
 * reinforce the hub's policy; it REPLACES it with something weaker. The SDK runtime says so outright:
 *
 *     "canUseTool will not be invoked: permissionMode 'bypassPermissions' auto-approves every tool call
 *      (except explicit deny rules) before the callback is consulted"
 *
 * With the callback skipped, so is everything behind it: worktree containment, the bus-origin clamp that
 * stops a teammate's message driving destructive tools, the ApprovalService audit trail, the
 * eligible-kind whitelist, and the ability to tighten a live chat from Full to Safe.
 *
 * It only failed safe by accident — bypassPermissions ALSO requires a second opt-in flag that was never
 * set, so the bypass never engaged and the callback ran (which is why full-access chats still prompted).
 * "Completing" that oversight would turn the accident into a real hole, so this pins the intent.
 *
 * ASSERTED AT THE RUNTIME BOUNDARY, NOT IN THE SOURCE TEXT. The first version of this test grepped
 * adapters/claude.ts for forbidden strings, which (a) failed immediately because the explanatory comment
 * names the very flag it forbids, and (b) could not have proved anything anyway: the mapping could return
 * through a constant or helper and a source scan would stay green. Capturing the options actually handed
 * to `query` is the only assertion that can fail for the right reason.
 */

const captured: Record<string, unknown>[] = []

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (params: { prompt: string; options: Record<string, unknown> }) => {
    captured.push(params.options)
    // Must be genuinely async-iterable: ClaudeDriver.send awaits `for await` to completion, and a plain
    // array would not exercise the same path.
    return (async function* () {
      yield { type: 'result', subtype: 'success', is_error: false, result: 'ok' }
    })()
  },
}))

const { ClaudeDriver, CLAUDE_AUTO_COMPACT_WINDOW } = await import('./adapters/claude.js')

function makeDriver(
  canUseTool?: (t: string, i: unknown, context?: unknown) => Promise<unknown>
) {
  return new ClaudeDriver(
    '/tmp/profile',
    '/tmp/cwd',
    () => {},
    canUseTool as never
  )
}

beforeEach(() => {
  captured.length = 0
})

describe('ClaudeDriver permission wiring', () => {
  for (const mode of ['full', 'edits', 'safe'] as const) {
    it(`does not hand '${mode}' to the SDK as a permissionMode`, async () => {
      await makeDriver(async () => ({ behavior: 'allow', updatedInput: {} })).send('hi', { permissionMode: mode })

      expect(captured).toHaveLength(1)
      const options = captured[0]!
      // The vendor must stay in its default posture so OUR callback is always consulted.
      expect(options.permissionMode).toBeUndefined()
      expect(options.allowDangerouslySkipPermissions).not.toBe(true)
    })
  }

  it('always installs canUseTool, which is where the hub policy is enforced', async () => {
    await makeDriver(async () => ({ behavior: 'allow', updatedInput: {} })).send('hi', { permissionMode: 'full' })
    expect(typeof captured[0]!.canUseTool).toBe('function')
  })

  it('enables the supported Claude auto-compaction window on every resumed app turn', async () => {
    const driver = makeDriver()
    driver.restore('large-resumed-session')

    await driver.send('new task', { trustProjectConfig: true })

    expect(captured[0]!.settings).toMatchObject({
      autoCompactEnabled: true,
      autoCompactWindow: CLAUDE_AUTO_COMPACT_WINDOW,
    })
  })

  it('appends the AllMyAgents host contract at the system boundary on every resumed invocation', async () => {
    const driver = makeDriver(async () => ({ behavior: 'allow', updatedInput: {} }))
    driver.restore('claude-resume-id')
    const reminder = 'Use mcp__allmyagents__overseer_control and inspect the live schema after compaction.'

    await driver.send('first', { systemPrompt: reminder })
    await driver.send('second', { systemPrompt: reminder })

    expect(captured).toHaveLength(2)
    for (const options of captured) {
      expect(options.resume).toBe('claude-resume-id')
      expect(options.systemPrompt).toEqual({
        type: 'preset',
        preset: 'claude_code',
        append: reminder,
      })
      expect(options.appendSubagentSystemPrompt).toBe(reminder)
    }
  })

  it('passes the handler decision through unchanged, including a denial', async () => {
    // Parameters are declared so the mock's recorded call tuple is typed — a zero-arg vi.fn infers
    // `calls: []`, and destructuring one is a compile error rather than a test failure.
    const handler = vi.fn(async (_toolName: string, _input: unknown) => ({
      behavior: 'deny' as const,
      message: 'outside the worktree',
    }))
    await makeDriver(handler).send('hi', { permissionMode: 'full' })

    const installed = captured[0]!.canUseTool as (t: string, i: unknown) => Promise<unknown>
    await expect(installed('Write', { file_path: '/etc/passwd' })).resolves.toEqual({
      behavior: 'deny',
      message: 'outside the worktree',
    })
    // Assert the arguments we care about rather than the exact arity: the adapter deliberately forwards a
    // THIRD argument (the SDK's permission context, which carries matchedAskRule), so an exact-args
    // matcher would fail on a trailing `undefined` that is not what this test is about.
    const [name, input] = handler.mock.calls[0]!
    expect(name).toBe('Write')
    expect(input).toEqual({ file_path: '/etc/passwd' })
  })

  it('forwards the exact SDK correlation and abort context to the host handler', async () => {
    const handler = vi.fn(
      async (_toolName: string, input: unknown, _context?: unknown) => ({
        behavior: 'allow' as const,
        updatedInput: input,
      })
    )
    await makeDriver(handler).send('hi', { permissionMode: 'safe' })

    const installed = captured[0]!.canUseTool as (
      toolName: string,
      input: unknown,
      context: unknown
    ) => Promise<unknown>
    const signal = new AbortController().signal
    const context = {
      signal,
      toolUseID: 'toolu_context',
      requestId: 'control_context',
      agentID: 'agent_context',
      matchedAskRule: {
        source: 'user_settings',
        toolName: 'AskUserQuestion',
        ruleContent: 'ask the operator',
      },
    }
    const input = { questions: [{ question: 'Exact?' }] }
    await installed('AskUserQuestion', input, context)

    expect(handler).toHaveBeenCalledTimes(1)
    const [toolName, forwardedInput, forwardedContext] = handler.mock.calls[0]!
    expect(toolName).toBe('AskUserQuestion')
    expect(forwardedInput).toBe(input)
    expect(forwardedContext).toBe(context)
    expect(forwardedContext).toMatchObject({
      signal,
      toolUseID: 'toolu_context',
      requestId: 'control_context',
      agentID: 'agent_context',
      matchedAskRule: {
        source: 'user_settings',
        toolName: 'AskUserQuestion',
        ruleContent: 'ask the operator',
      },
    })
  })
})

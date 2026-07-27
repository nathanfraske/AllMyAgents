import { query, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

type EventSink = (kind: string, payload: unknown) => void

/**
 * Context the SDK supplies alongside a permission request. Optional so every existing caller and test is
 * unaffected; only the fields the hub actually acts on are modelled.
 *
 * `matchedAskRule` is the load-bearing one. The SDK says of it: "Hosts ... running host-side
 * auto-approval should treat asks carrying this field as rule-forced: the user's stated intent is a human
 * prompt." Since the hub now decides auto-approval centrally, that obligation is ours — and it can only
 * be honoured if the adapter stops discarding this argument.
 */
export interface ClaudePermissionContext {
  matchedAskRule?: { source: string; toolName: string; ruleContent?: string }
  toolUseID?: string
  agentID?: string
}

export type ClaudePermissionHandler = (
  toolName: string,
  input: unknown,
  context?: ClaudePermissionContext
) => Promise<{ behavior: 'allow'; updatedInput: unknown } | { behavior: 'deny'; message: string }>

export interface ClaudeTurnOptions {
  model?: string
  permissionMode?: 'safe' | 'edits' | 'full'
  effort?: string
  /** True only when the operator approved this project's executable MCP/hook config. */
  trustProjectConfig?: boolean
}

// Claude Code recognizes thinking-budget keywords in the prompt text.
const THINKING_KEYWORD: Record<string, string> = {
  think: 'think',
  megathink: 'think hard',
  ultrathink: 'ultrathink',
}

function numField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function userMessage(text: string, priority?: 'next'): SDKUserMessage {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
    ...(priority ? { priority } : {}),
  }
}

/**
 * The SDK's streaming-input contract owns stdin for the lifetime of the iterable: when the iterable
 * finishes, Query.streamInput closes the CLI's input. A fresh one-message iterable per steer would
 * therefore close stdin after the first correction. Keep one stream open for the whole turn instead.
 */
class ClaudeInputStream implements AsyncIterable<SDKUserMessage> {
  private readonly queued: Array<{
    message: SDKUserMessage
    accepted?: { resolve(): void; reject(error: Error): void }
  }> = []
  private readonly waiting: Array<(result: IteratorResult<SDKUserMessage>) => void> = []
  private inFlight: { resolve(): void; reject(error: Error): void } | undefined
  private closed = false

  constructor(initial: SDKUserMessage) {
    this.queued.push({ message: initial })
  }

  push(message: SDKUserMessage): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Claude input stream is closed'))
    return new Promise<void>((resolve, reject) => {
      const accepted = { resolve, reject }
      const waiter = this.waiting.shift()
      if (waiter) {
        this.inFlight = accepted
        waiter({ value: message, done: false })
      } else {
        this.queued.push({ message, accepted })
      }
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    const error = new Error('Claude turn ended before queued input was accepted')
    this.inFlight?.reject(error)
    this.inFlight = undefined
    for (const item of this.queued.splice(0)) item.accepted?.reject(error)
    for (const waiter of this.waiting.splice(0)) waiter({ value: undefined, done: true })
  }

  abort(error: Error): void {
    if (this.closed) return
    this.closed = true
    this.inFlight?.reject(error)
    this.inFlight = undefined
    for (const item of this.queued.splice(0)) item.accepted?.reject(error)
    for (const waiter of this.waiting.splice(0)) waiter({ value: undefined, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        // Query.streamInput awaits transport.write before requesting the next item. Resolving the prior
        // item's acknowledgement here therefore proves the SDK wrote it, rather than merely that the hub
        // enqueued it. That distinction keeps a process-exit race from marking a bus row delivered.
        this.inFlight?.resolve()
        this.inFlight = undefined
        const item = this.queued.shift()
        if (item) {
          this.inFlight = item.accepted
          return Promise.resolve({ value: item.message, done: false })
        }
        if (this.closed) return Promise.resolve({ value: undefined, done: true })
        return new Promise<IteratorResult<SDKUserMessage>>((resolve) => this.waiting.push(resolve))
      },
    }
  }
}

export class ClaudeDriver {
  private vendorSessionId: string | undefined
  private active: { query: Query; input: ClaudeInputStream } | undefined

  constructor(
    private readonly profileDir: string,
    private readonly cwd: string,
    private readonly onEvent: EventSink,
    private readonly canUseTool?: ClaudePermissionHandler,
    // In-process MCP servers (hub-provided agent tools: inter-agent bus + shared memory). Keyed by
    // server name; the SDK exposes their tools to the agent as `mcp__<name>__<tool>`.
    private readonly mcpServers?: Record<string, unknown>
  ) {}

  get sessionId(): string | undefined {
    return this.vendorSessionId
  }

  restore(vendorSessionId: string): void {
    this.vendorSessionId = vendorSessionId
  }

  get busy(): boolean {
    return this.active !== undefined
  }

  async send(prompt: string, turnOptions: ClaudeTurnOptions = {}): Promise<void> {
    if (this.active) throw new Error('claude session is already running a turn')
    const env = { ...process.env, CLAUDE_CONFIG_DIR: this.profileDir } as Record<string, string>
    const keyword = turnOptions.effort ? THINKING_KEYWORD[turnOptions.effort] : undefined
    const finalPrompt = keyword ? `${keyword}\n\n${prompt}` : prompt
    const options: Record<string, unknown> = {
      env,
      cwd: this.cwd,
    }
    if (this.vendorSessionId) options.resume = this.vendorSessionId
    if (turnOptions.model) options.model = turnOptions.model
    // DELIBERATELY NOT MAPPED ONTO THE SDK'S permissionMode. Our modes are enforced by the hub, and
    // handing them to the vendor as well does not reinforce them — it REPLACES them with something weaker.
    //
    // The SDK runtime says so in as many words: "canUseTool will not be invoked: permissionMode
    // 'bypassPermissions' auto-approves every tool call (except explicit deny rules) before the callback
    // is consulted". So mapping our `full` to bypassPermissions would mean the callback below never runs,
    // and with it none of: the worktree containment check, the bus-origin clamp that stops a teammate
    // message driving destructive tools, the ApprovalService audit trail, the eligible-kind whitelist, or
    // the ability to tighten a live chat from Full to Safe. Precisely the guarantees the hub-side policy
    // exists to provide, silently switched off for the one mode that most needs them.
    //
    // It only failed safe by accident: bypassPermissions ALSO requires allowDangerouslySkipPermissions,
    // which was never set, so the bypass did not take effect and the callback ran anyway — which is why
    // full-access chats were still prompting. Anyone "fixing" that by adding the missing flag would turn
    // an accident into a real hole. `acceptEdits` is left off for the same reason: it auto-accepts edit
    // tools, so it would bypass the containment check for exactly the writes that need bounding.
    //
    // FULL therefore means "no prompts, after the hub's policy has looked at it" — not "no callback".
    if (this.canUseTool) {
      // Forward the SDK's third argument. It used to be dropped, which silently cost us the vendor's own
      // per-invocation identity AND `matchedAskRule` — so a user-configured permissions.ask rule, whose
      // entire purpose is to force a human prompt, was invisible to the hub's auto-approval and got
      // overridden by Full access.
      options.canUseTool = async (toolName: string, input: unknown, context?: ClaudePermissionContext) =>
        this.canUseTool!(toolName, input, context)
    }
    if (this.mcpServers) options.mcpServers = this.mcpServers
    // A string prompt selects the SDK's one-shot mode, where control requests and additional input are
    // unsupported. Its AsyncIterable form selects streaming I/O. The stream stays open until this turn's
    // result so `steer()` can append a priority:'next' user message at Claude Code's next tool boundary.
    const input = new ClaudeInputStream(userMessage(finalPrompt))
    const q = query({ prompt: input, options: options as never })
    this.active = { query: q, input }
    let receivedResult = false
    try {
      for await (const message of q) {
        const m = message as {
          type: string
          session_id?: string
          usage?: unknown
          message?: { usage?: unknown }
        }
        if (typeof m.session_id === 'string') this.vendorSessionId = m.session_id
        this.onEvent(`claude/${m.type}`, message)
        // Surface token usage to the UI's live counter as the turn streams. Assistant messages
        // carry usage under `.message.usage` (the Anthropic API message); the final `result`
        // message carries it at the top level. The SDK gives no total, so we derive it.
        if (m.type === 'assistant') this.emitTokens(m.message?.usage)
        else if (m.type === 'result') {
          receivedResult = true
          this.emitTokens(m.usage)
          // End the iterable with the turn. Any steer not yet acknowledged by Query.streamInput is rejected,
          // so its caller can retain/retry it instead of marking input delivered on a result-vs-steer race.
          input.close()
        }
      }
    } finally {
      if (receivedResult) input.close()
      else input.abort(new Error('Claude turn ended before queued input was accepted'))
      this.active = undefined
    }
  }

  async steer(text: string): Promise<void> {
    const active = this.active
    if (!active) throw new Error('no active Claude turn to steer')
    try {
      await active.input.push(userMessage(text, 'next'))
    } catch {
      throw new Error('no active Claude turn to steer')
    }
  }

  // Best-effort: emit a `session/tokens` event from an Anthropic usage object.
  //
  // CACHE FIELDS ARE PART OF THE INPUT, and dropping them made this counter meaningless. Anthropic
  // reports a cached prompt as `cache_read_input_tokens`, leaving `input_tokens` as only the handful of
  // NEW tokens — typically 1 or 2. So a live turn carrying ~170k of real context streamed
  // `{"input":1,"output":3,"total":4}` and the UI dutifully displayed "4 tokens". Not a formatting
  // problem: the number was right for what it measured and measuring the wrong thing.
  //
  // Kept as separate fields as well as the total, so a reader can still distinguish fresh input from
  // cache reads — that distinction is the whole reason prompt caching is worth having.
  private emitTokens(usage: unknown): void {
    if (!usage || typeof usage !== 'object') return
    const u = usage as Record<string, unknown>
    const input = numField(u.input_tokens)
    const cacheRead = numField(u.cache_read_input_tokens)
    const cacheWrite = numField(u.cache_creation_input_tokens)
    const output = numField(u.output_tokens)
    if (input === undefined && output === undefined && cacheRead === undefined && cacheWrite === undefined) return
    const out: { input?: number; cacheRead?: number; cacheWrite?: number; output?: number; total?: number } = {}
    if (input !== undefined) out.input = input
    if (cacheRead !== undefined) out.cacheRead = cacheRead
    if (cacheWrite !== undefined) out.cacheWrite = cacheWrite
    if (output !== undefined) out.output = output
    out.total = (input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0) + (output ?? 0)
    this.onEvent('session/tokens', out)
  }

  async interrupt(): Promise<void> {
    if (this.active) await this.active.query.interrupt()
  }
}

import { query } from '@anthropic-ai/claude-agent-sdk'

type EventSink = (kind: string, payload: unknown) => void

export type ClaudePermissionHandler = (
  toolName: string,
  input: unknown
) => Promise<{ behavior: 'allow'; updatedInput: unknown } | { behavior: 'deny'; message: string }>

export interface ClaudeTurnOptions {
  model?: string
  permissionMode?: 'safe' | 'edits' | 'full'
  effort?: string
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

export class ClaudeDriver {
  private vendorSessionId: string | undefined
  private active: { interrupt(): Promise<void> } | undefined

  constructor(
    private readonly profileDir: string,
    private readonly cwd: string,
    private readonly onEvent: EventSink,
    private readonly canUseTool?: ClaudePermissionHandler
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
    if (turnOptions.permissionMode === 'edits') options.permissionMode = 'acceptEdits'
    else if (turnOptions.permissionMode === 'full') options.permissionMode = 'bypassPermissions'
    if (this.canUseTool) {
      options.canUseTool = async (toolName: string, input: unknown) => this.canUseTool!(toolName, input)
    }
    const q = query({ prompt: finalPrompt, options: options as never })
    this.active = q as unknown as { interrupt(): Promise<void> }
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
        else if (m.type === 'result') this.emitTokens(m.usage)
      }
    } finally {
      this.active = undefined
    }
  }

  // Best-effort: emit a `session/tokens` event from an Anthropic usage object. Fields are
  // input_tokens/output_tokens (there is no total_tokens on Anthropic usage), so total is the
  // sum of whichever of the two is present. No-op when the usage object carries neither.
  private emitTokens(usage: unknown): void {
    if (!usage || typeof usage !== 'object') return
    const u = usage as Record<string, unknown>
    const input = numField(u.input_tokens)
    const output = numField(u.output_tokens)
    if (input === undefined && output === undefined) return
    const out: { input?: number; output?: number; total?: number } = {}
    if (input !== undefined) out.input = input
    if (output !== undefined) out.output = output
    out.total = (input ?? 0) + (output ?? 0)
    this.onEvent('session/tokens', out)
  }

  async interrupt(): Promise<void> {
    if (this.active) await this.active.interrupt()
  }
}

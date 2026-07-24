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
        const m = message as { type: string; session_id?: string }
        if (typeof m.session_id === 'string') this.vendorSessionId = m.session_id
        this.onEvent(`claude/${m.type}`, message)
      }
    } finally {
      this.active = undefined
    }
  }

  async interrupt(): Promise<void> {
    if (this.active) await this.active.interrupt()
  }
}

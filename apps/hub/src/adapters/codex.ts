import { spawn, type ChildProcess } from 'node:child_process'
import readline from 'node:readline'

type EventSink = (kind: string, payload: unknown) => void

export type CodexApprovalHandler = (method: string, params: unknown) => Promise<unknown>

export interface CodexTurnOptions {
  model?: string
  effort?: string
  serviceTier?: string
  approvalPolicy?: string
}

/** Normalized token usage forwarded to the UI as a `session/tokens` event (all fields optional). */
export interface TokenUsage {
  input?: number
  output?: number
  total?: number
  context?: number
}

function numField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Map a Codex app-server `thread/tokenUsage/updated` notification's params to the hub's normalized
 * token shape. The exact field names vary by installed app-server version, so this probes both a
 * nested usage object (`params.usage` / `tokenUsage` / `tokens` / `info`) and the flat params, in
 * camelCase and snake_case, and never throws on missing fields. Returns undefined when nothing
 * usable is present. The raw notification is still journaled as `codex/thread/tokenUsage/updated`,
 * so the live wire shape can be sanity-checked and this mapping widened if the names differ.
 */
export function mapCodexTokenUsage(params: unknown): TokenUsage | undefined {
  if (!params || typeof params !== 'object') return undefined
  const p = params as Record<string, unknown>
  const nested = [p.usage, p.tokenUsage, p.tokens, p.info].find(
    (v): v is Record<string, unknown> => !!v && typeof v === 'object'
  )
  const pick = (...keys: string[]): number | undefined => {
    for (const src of [nested, p]) {
      if (!src) continue
      for (const key of keys) {
        const n = numField(src[key])
        if (n !== undefined) return n
      }
    }
    return undefined
  }
  const input = pick('input_tokens', 'inputTokens', 'input', 'prompt_tokens', 'promptTokens')
  const output = pick('output_tokens', 'outputTokens', 'output', 'completion_tokens', 'completionTokens')
  let total = pick('total_tokens', 'totalTokens', 'total', 'total_token_usage', 'totalTokenUsage')
  if (total === undefined && input !== undefined && output !== undefined) total = input + output
  const context = pick(
    'context_window',
    'contextWindow',
    'context',
    'context_tokens',
    'contextTokens',
    'used_context_window',
    'usedContextWindow'
  )
  const out: TokenUsage = {}
  if (input !== undefined) out.input = input
  if (output !== undefined) out.output = output
  if (total !== undefined) out.total = total
  if (context !== undefined) out.context = context
  return Object.keys(out).length > 0 ? out : undefined
}

interface Pending {
  method: string
  resolve: (value: unknown) => void
  reject: (err: Error) => void
}

export class CodexClient {
  private child: ChildProcess | undefined
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  // threadId -> id of the turn currently running on that thread (for steer's expectedTurnId)
  private readonly activeTurns = new Map<string, string>()
  private initPromise: Promise<void> | undefined

  constructor(
    private readonly profileDir: string,
    private readonly onEvent: EventSink,
    private readonly onApproval?: CodexApprovalHandler
  ) {}

  private send(msg: Record<string, unknown>): void {
    this.child?.stdin?.write(JSON.stringify(msg) + '\n')
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { method, resolve: resolve as (v: unknown) => void, reject })
      this.send(params === undefined ? { id, method } : { id, method, params })
    })
  }

  async ensureStarted(): Promise<void> {
    if (!this.initPromise) this.initPromise = this.startInner()
    return this.initPromise
  }

  private async startInner(): Promise<void> {
    const child = spawn('codex app-server', {
      shell: true,
      env: { ...process.env, CODEX_HOME: this.profileDir },
    })
    this.child = child
    if (child.stdout) {
      const rl = readline.createInterface({ input: child.stdout })
      rl.on('line', (line) => this.onLine(line))
    }
    child.stderr?.on('data', (d: Buffer) => this.onEvent('codex/stderr', d.toString()))
    child.on('exit', (code) => {
      this.onEvent('codex/exited', { code })
      const err = new Error(`codex app-server exited (${code})`)
      for (const p of this.pending.values()) p.reject(err)
      this.pending.clear()
      this.child = undefined
      this.initPromise = undefined
    })
    await this.request('initialize', {
      clientInfo: { name: 'aiagentapp-hub', title: 'AiAgentApp hub', version: '0.0.1' },
    })
    this.send({ method: 'initialized' })
  }

  private onLine(line: string): void {
    if (!line.trim()) return
    let msg: { id?: number; method?: string; params?: unknown; result?: unknown; error?: unknown }
    try {
      msg = JSON.parse(line) as typeof msg
    } catch {
      this.onEvent('codex/raw', line)
      return
    }
    const isResponse = msg.id !== undefined && msg.method === undefined
    const isServerRequest = msg.id !== undefined && msg.method !== undefined
    if (isResponse) {
      const p = this.pending.get(msg.id as number)
      if (!p) return
      this.pending.delete(msg.id as number)
      if (msg.error) p.reject(new Error(`${p.method}: ${JSON.stringify(msg.error)}`))
      else p.resolve(msg.result)
      return
    }
    if (isServerRequest) {
      const id = msg.id as number
      const method = msg.method as string
      this.onEvent(`codex/request/${method}`, msg.params ?? null)
      if (this.onApproval) {
        void this.onApproval(method, msg.params ?? null)
          .then((result) => this.send({ id, result }))
          .catch(() => this.send({ id, result: { decision: 'decline' } }))
      } else {
        this.send({ id, result: { decision: 'decline' } })
      }
      return
    }
    // Track the active turn per thread so steer can target it: turn/started carries the
    // new turn's id (params.turn.id); turn/completed and turn/error end that turn.
    if (msg.method === 'turn/started') {
      const p = msg.params as { threadId?: string; turn?: { id?: string } } | null
      if (p?.threadId && p.turn?.id) this.activeTurns.set(p.threadId, p.turn.id)
    } else if (msg.method === 'turn/completed' || msg.method === 'turn/error') {
      const p = msg.params as { threadId?: string } | null
      if (p?.threadId) this.activeTurns.delete(p.threadId)
    }
    this.onEvent(`codex/${msg.method}`, msg.params ?? null)
  }

  async startThread(cwd: string): Promise<string> {
    await this.ensureStarted()
    const result = await this.request<{ threadId?: string; thread?: { id?: string } }>('thread/start', { cwd })
    const threadId = result.threadId ?? result.thread?.id
    if (!threadId) throw new Error('thread/start returned no thread id')
    return threadId
  }

  async resumeThread(threadId: string): Promise<void> {
    await this.ensureStarted()
    await this.request('thread/resume', { threadId })
  }

  async sendTurn(threadId: string, text: string, opts: CodexTurnOptions = {}): Promise<void> {
    const params: Record<string, unknown> = { threadId, input: [{ type: 'text', text }] }
    if (opts.model) params.model = opts.model
    if (opts.effort) params.effort = opts.effort
    if (opts.serviceTier) params.serviceTier = opts.serviceTier
    if (opts.approvalPolicy) params.approvalPolicy = opts.approvalPolicy
    await this.request('turn/start', params)
  }

  async interrupt(threadId: string): Promise<void> {
    await this.request('turn/interrupt', { threadId })
  }

  // Append user input to the turn currently running on this thread. The app-server requires
  // expectedTurnId to match the live turn (else -32600), so we send the tracked active turn id.
  async steer(threadId: string, text: string): Promise<void> {
    const expectedTurnId = this.activeTurns.get(threadId)
    if (!expectedTurnId) throw new Error('no active Codex turn to steer')
    await this.request('turn/steer', {
      threadId,
      input: [{ type: 'text', text }],
      expectedTurnId,
    })
  }

  async readRateLimits(): Promise<unknown> {
    await this.ensureStarted()
    return this.request('account/rateLimits/read', {})
  }

  stop(): void {
    this.child?.kill()
  }
}

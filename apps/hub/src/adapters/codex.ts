import { spawn, type ChildProcess } from 'node:child_process'
import readline from 'node:readline'

type EventSink = (kind: string, payload: unknown) => void

export type CodexApprovalHandler = (method: string, params: unknown) => Promise<unknown>

export interface CodexTurnOptions {
  model?: string
  effort?: string
  approvalPolicy?: string
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
    if (opts.approvalPolicy) params.approvalPolicy = opts.approvalPolicy
    await this.request('turn/start', params)
  }

  async interrupt(threadId: string): Promise<void> {
    await this.request('turn/interrupt', { threadId })
  }

  async readRateLimits(): Promise<unknown> {
    await this.ensureStarted()
    return this.request('account/rateLimits/read', {})
  }

  stop(): void {
    this.child?.kill()
  }
}

import crypto from 'node:crypto'
import http from 'node:http'
import {
  BROWSER_PROTOCOL_VERSION,
  type BrowserCommand,
  type BrowserCommandResult,
  type BrowserHostHello,
  type BrowserNavigationEvent,
  type BrowserOperation,
  type BrowserResultContent,
} from './browserProtocol.js'

const NO_HOST =
  'Browser unavailable: no compatible AllMyAgents desktop browser host is connected. Headless hub sessions cannot browse.'
const NO_SECRET =
  'Browser unavailable: this hub was started without an authenticated desktop browser broker.'

export interface BrowserTransport {
  hello(signal: AbortSignal): Promise<BrowserHostHello>
  command(command: BrowserCommand, signal: AbortSignal): Promise<{ hello: BrowserHostHello; result: BrowserCommandResult }>
  nextEvent(signal: AbortSignal): Promise<{ hello: BrowserHostHello; event?: BrowserNavigationEvent }>
}

interface ActiveCommand {
  abort: AbortController
  cancelled: boolean
}

function privateTransport(address: string, secret: string): BrowserTransport {
  const base = new URL(address)
  if (
    base.protocol !== 'http:' ||
    !['127.0.0.1', '::1', '[::1]', 'localhost'].includes(base.hostname) ||
    !base.port ||
    base.username ||
    base.password ||
    base.pathname !== '/'
  ) {
    throw new Error('Browser unavailable: the desktop browser bridge address is not a private loopback endpoint.')
  }

  const request = async <T>(path: string, method: 'GET' | 'POST', body: unknown, signal: AbortSignal): Promise<T> =>
    await new Promise<T>((resolve, reject) => {
      const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
      const req = http.request(
        {
          hostname: base.hostname === '[::1]' ? '::1' : base.hostname,
          port: Number(base.port),
          path,
          method,
          headers: {
            authorization: `Bearer ${secret}`,
            accept: 'application/json',
            ...(bytes
              ? { 'content-type': 'application/json', 'content-length': String(bytes.length) }
              : {}),
          },
          signal,
        },
        (res) => {
          const chunks: Buffer[] = []
          let size = 0
          res.on('data', (chunk: Buffer) => {
            size += chunk.length
            if (size > 12_500_000) {
              req.destroy(new Error('Browser unavailable: the desktop browser response was too large.'))
              return
            }
            chunks.push(chunk)
          })
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8')
            if (res.statusCode !== 200) {
              reject(new Error(`Browser unavailable: the desktop browser host rejected the command (${res.statusCode ?? 0}).`))
              return
            }
            try {
              resolve(JSON.parse(text) as T)
            } catch {
              reject(new Error('Browser unavailable: the desktop browser host returned invalid JSON.'))
            }
          })
        },
      )
      req.on('error', reject)
      if (bytes) req.write(bytes)
      req.end()
    })

  return {
    hello: (signal) => request('/hello', 'GET', undefined, signal),
    command: (command, signal) => request('/command', 'POST', command, signal),
    nextEvent: (signal) => request('/events/next', 'GET', undefined, signal),
  }
}

export class BrowserBroker {
  private readonly commandTimeoutMs: number
  private readonly hostLeaseMs: number
  private readonly now: () => number
  private readonly transport: BrowserTransport | null
  private readonly configurationError: string | null
  private lastHostSeenAt = 0
  private desktopInstanceId: string | null = null
  private compatibilityError: string | null = null
  private reportedHostError: string | null = null
  private readonly activeCommands = new Map<string, ActiveCommand>()
  private readonly sessionIdleWaiters = new Map<string, Set<() => void>>()
  private navigationListener: ((event: BrowserNavigationEvent) => void) | null = null
  private running = false
  private eventAbort: AbortController | null = null

  constructor(options: {
    address?: string
    secret?: string
    commandTimeoutMs?: number
    hostLeaseMs?: number
    now?: () => number
    transport?: BrowserTransport
  }) {
    this.commandTimeoutMs = options.commandTimeoutMs ?? 45_000
    this.hostLeaseMs = options.hostLeaseMs ?? 20_000
    this.now = options.now ?? Date.now
    if (options.transport) {
      this.transport = options.transport
      this.configurationError = null
    } else if (!options.secret || !options.address) {
      this.transport = null
      this.configurationError = NO_SECRET
    } else {
      try {
        this.transport = privateTransport(options.address, options.secret)
        this.configurationError = null
      } catch (err) {
        this.transport = null
        this.configurationError = err instanceof Error ? err.message : String(err)
      }
    }
  }

  onNavigation(listener: (event: BrowserNavigationEvent) => void): void {
    this.navigationListener = listener
  }

  start(): void {
    if (this.running || !this.transport) return
    this.running = true
    void this.refresh().finally(() => {
      if (this.running) void this.eventLoop()
    })
  }

  stop(): void {
    this.running = false
    this.eventAbort?.abort()
    this.eventAbort = null
  }

  status(): { available: boolean; reason?: string; desktopInstanceId?: string } {
    if (this.configurationError) return { available: false, reason: this.configurationError }
    if (this.compatibilityError) return { available: false, reason: this.compatibilityError }
    if (this.reportedHostError) return { available: false, reason: this.reportedHostError }
    if (!this.hostIsLive()) return { available: false, reason: NO_HOST }
    return { available: true, desktopInstanceId: this.desktopInstanceId ?? undefined }
  }

  async refresh(): Promise<void> {
    if (!this.transport) return
    const abort = AbortSignal.timeout(3_000)
    try {
      this.noteHost(await this.transport.hello(abort))
    } catch {
      // The lease makes an absent or disconnected desktop unavailable without
      // turning transient connection errors into a second, ambiguous state.
    }
  }

  async executeDetailed(input: {
    sessionId: string
    operation: BrowserOperation
    arguments: Record<string, unknown>
  }): Promise<{ content: BrowserResultContent[]; data?: Record<string, unknown> }> {
    if (!this.status().available) await this.refresh()
    const state = this.status()
    if (!state.available) throw new Error(state.reason)
    if (!this.transport) throw new Error(NO_SECRET)
    if (this.activeCommands.size >= 64) {
      throw new Error('Browser unavailable: the desktop browser command queue is full.')
    }
    if (this.activeCommands.has(input.sessionId)) {
      throw new Error('Browser unavailable: another browser command is already running for this chat.')
    }

    const command: BrowserCommand = {
      id: `browser_${crypto.randomBytes(12).toString('hex')}`,
      protocolVersion: BROWSER_PROTOCOL_VERSION,
      sessionId: input.sessionId,
      operation: input.operation,
      arguments: input.arguments,
    }
    const expectedDesktopInstanceId = this.desktopInstanceId
    const abort = new AbortController()
    const active: ActiveCommand = { abort, cancelled: false }
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      abort.abort()
    }, this.commandTimeoutMs)
    timer.unref?.()
    this.activeCommands.set(input.sessionId, active)
    try {
      const response = await this.transport.command(command, abort.signal)
      this.noteHost(response.hello)
      if (this.compatibilityError) throw new Error(this.compatibilityError)
      if (expectedDesktopInstanceId && response.hello.desktopInstanceId !== expectedDesktopInstanceId) {
        throw new Error('Browser unavailable: the desktop browser host restarted during the command.')
      }
      if (
        response.result.protocolVersion !== BROWSER_PROTOCOL_VERSION ||
        response.result.id !== command.id
      ) {
        throw new Error('Browser unavailable: the desktop browser response did not match the command.')
      }
      if (active.cancelled) {
        throw new Error('Browser command cancelled because this chat’s browser authority changed.')
      }
      if (!response.result.ok) {
        throw new Error(response.result.error || 'The desktop browser command failed.')
      }
      return {
        content: response.result.content ?? [],
        ...(response.result.data ? { data: response.result.data } : {}),
      }
    } catch (err) {
      if (timedOut) {
        throw new Error('Browser unavailable: the desktop browser host did not answer in time.')
      }
      throw err
    } finally {
      clearTimeout(timer)
      if (this.activeCommands.get(input.sessionId) === active) this.activeCommands.delete(input.sessionId)
      this.noteSessionIdle(input.sessionId)
    }
  }

  async execute(input: {
    sessionId: string
    operation: BrowserOperation
    arguments: Record<string, unknown>
  }): Promise<BrowserResultContent[]> {
    return (await this.executeDetailed(input)).content
  }

  cancelSession(sessionId: string): void {
    const active = this.activeCommands.get(sessionId)
    if (active) active.cancelled = true
  }

  async executeAfterCurrent(input: {
    sessionId: string
    operation: BrowserOperation
    arguments: Record<string, unknown>
  }): Promise<BrowserResultContent[]> {
    while (true) {
      await this.waitForSessionIdle(input.sessionId)
      try {
        return await this.execute(input)
      } catch (err) {
        if (
          err instanceof Error &&
          err.message === 'Browser unavailable: another browser command is already running for this chat.'
        ) {
          continue
        }
        throw err
      }
    }
  }

  private async eventLoop(): Promise<void> {
    while (this.running && this.transport) {
      const abort = new AbortController()
      this.eventAbort = abort
      const timer = setTimeout(() => abort.abort(), 22_000)
      timer.unref?.()
      try {
        const response = await this.transport.nextEvent(abort.signal)
        this.noteHost(response.hello)
        if (this.compatibilityError) continue
        if (response.event) {
          if (response.event.protocolVersion !== BROWSER_PROTOCOL_VERSION) {
            throw new Error(`Unsupported browser event protocol version ${response.event.protocolVersion}.`)
          }
          this.navigationListener?.(response.event)
        }
      } catch {
        if (this.running) await new Promise((resolve) => setTimeout(resolve, 500))
      } finally {
        clearTimeout(timer)
        if (this.eventAbort === abort) this.eventAbort = null
      }
    }
  }

  private noteHost(hello: BrowserHostHello): void {
    if (hello.protocolVersion !== BROWSER_PROTOCOL_VERSION) {
      this.compatibilityError =
        `Browser unavailable: desktop browser protocol ${hello.protocolVersion} is incompatible with hub protocol ${BROWSER_PROTOCOL_VERSION}.`
      return
    }
    if (!hello.desktopInstanceId) {
      this.compatibilityError = 'Browser unavailable: desktop browser host identity is missing.'
      return
    }
    this.compatibilityError = null
    this.desktopInstanceId = hello.desktopInstanceId
    this.lastHostSeenAt = this.now()
    this.reportedHostError =
      hello.available === false
        ? hello.reason || 'Browser unavailable: this desktop platform has no verified isolated browser host.'
        : null
  }

  private hostIsLive(): boolean {
    return Boolean(this.desktopInstanceId) && this.now() - this.lastHostSeenAt <= this.hostLeaseMs
  }

  private waitForSessionIdle(sessionId: string): Promise<void> {
    if (!this.activeCommands.has(sessionId)) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const waiters = this.sessionIdleWaiters.get(sessionId) ?? new Set<() => void>()
      waiters.add(resolve)
      this.sessionIdleWaiters.set(sessionId, waiters)
    })
  }

  private noteSessionIdle(sessionId: string): void {
    const waiters = this.sessionIdleWaiters.get(sessionId)
    if (!waiters) return
    this.sessionIdleWaiters.delete(sessionId)
    for (const resolve of waiters) resolve()
  }
}

import readline from 'node:readline'
import { z } from 'zod'
import { AGENT_TOOLS, AGENT_TOOLS_INSTRUCTIONS, type AgentToolOutput, type AgentToolSpec } from './agentToolCore.js'

/**
 * A minimal, dependency-free MCP server (JSON-RPC 2.0 over line-delimited stdio) exposing the shared
 * agent tools (agentToolCore.ts) to `codex app-server`, which spawns one of these per Codex thread and
 * loads it from the profile's `config.toml [mcp_servers.allmyagents]`.
 *
 * This is the Codex-side counterpart of the Claude in-process SDK server (agentTools.ts): both expose
 * the SAME `AGENT_TOOLS`, so Codex agents gain send/list/read + memory + practice parity with Claude.
 * The protocol shape (initialize → tools/list → tools/call, protocolVersion 2025-06-18) matches what
 * the installed codex 0.145 app-server sends, verified against a live app-server.
 *
 * Identity is NOT decided here — `execute(name, args)` is injected. In the hub the bridge forwards the
 * call (with the calling child's cwd) to the hub, which resolves the Codex SESSION and runs the body
 * under that identity + the same ACL/gating as Claude (see agentBridge.ts / SessionManager).
 */
export type AgentToolExecutor = (name: string, args: unknown) => Promise<AgentToolOutput>

export interface AgentMcpServerOptions {
  execute: AgentToolExecutor
  write: (msg: unknown) => void
  tools?: readonly AgentToolSpec[]
  instructions?: string
  serverInfo?: { name: string; version: string }
  onLog?: (msg: string) => void
}

// The MCP protocol version the installed codex app-server negotiates. We echo it back; if a future
// client sends a different one we still respond (MCP clients tolerate a server echoing their version).
const PROTOCOL_VERSION = '2025-06-18'

interface JsonRpcMessage {
  jsonrpc?: string
  id?: number | string | null
  method?: string
  params?: unknown
  result?: unknown
  error?: unknown
}

/** Build the JSON Schema an MCP client needs for a tool's `inputSchema` from its zod raw shape. */
export function inputSchemaFor(spec: AgentToolSpec): Record<string, unknown> {
  return z.toJSONSchema(z.object(spec.schema)) as Record<string, unknown>
}

export class AgentMcpServer {
  private readonly tools: readonly AgentToolSpec[]
  private readonly byName: Map<string, AgentToolSpec>
  private readonly instructions: string
  private readonly serverInfo: { name: string; version: string }

  constructor(private readonly opts: AgentMcpServerOptions) {
    this.tools = opts.tools ?? AGENT_TOOLS
    this.byName = new Map(this.tools.map((t) => [t.name, t]))
    this.instructions = opts.instructions ?? AGENT_TOOLS_INSTRUCTIONS
    this.serverInfo = opts.serverInfo ?? { name: 'allmyagents', version: '0.1.0' }
  }

  /** Parse one line of stdin and dispatch it. Non-JSON lines are ignored (logged if onLog is set). */
  async handleLine(line: string): Promise<void> {
    if (!line.trim()) return
    let msg: JsonRpcMessage
    try {
      msg = JSON.parse(line) as JsonRpcMessage
    } catch {
      this.opts.onLog?.(`ignoring non-JSON line: ${line.slice(0, 120)}`)
      return
    }
    await this.dispatch(msg)
  }

  private reply(id: JsonRpcMessage['id'], result: unknown): void {
    this.opts.write({ jsonrpc: '2.0', id, result })
  }

  private replyError(id: JsonRpcMessage['id'], code: number, message: string): void {
    this.opts.write({ jsonrpc: '2.0', id, error: { code, message } })
  }

  private async dispatch(msg: JsonRpcMessage): Promise<void> {
    const { method, id } = msg
    // Notifications (no id) are fire-and-forget — never answered.
    const isNotification = id === undefined || id === null
    switch (method) {
      case 'initialize':
        this.reply(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: this.serverInfo,
          instructions: this.instructions,
        })
        return
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return // no response
      case 'ping':
        if (!isNotification) this.reply(id, {})
        return
      case 'tools/list':
        this.reply(id, {
          tools: this.tools.map((spec) => ({
            name: spec.name,
            description: spec.description,
            inputSchema: inputSchemaFor(spec),
          })),
        })
        return
      case 'tools/call': {
        const params = (msg.params ?? {}) as { name?: string; arguments?: unknown }
        const name = params.name ?? ''
        if (!this.byName.has(name)) {
          // Report as a tool error (isError) rather than a JSON-RPC error, so the model sees it.
          this.reply(id, { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true })
          return
        }
        try {
          const output = await this.opts.execute(name, params.arguments ?? {})
          this.reply(id, {
            content: typeof output === 'string'
              ? [{ type: 'text', text: output }]
              : output,
          })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          this.reply(id, { content: [{ type: 'text', text: `Tool error: ${message}` }], isError: true })
        }
        return
      }
      default:
        if (!isNotification) this.replyError(id, -32601, `method not found: ${method ?? '(none)'}`)
        return
    }
  }
}

/**
 * Wire an AgentMcpServer to stdio streams (defaults: process.stdin/stdout). Returns the server so a
 * caller/test can also drive it directly. Each response is written as one JSON line (the framing codex
 * expects). Calls are handled sequentially per line but awaited so ordering is preserved.
 */
export function runStdioAgentMcpServer(opts: {
  execute: AgentToolExecutor
  input?: NodeJS.ReadableStream
  output?: NodeJS.WritableStream
  instructions?: string
  serverInfo?: { name: string; version: string }
  onLog?: (msg: string) => void
}): AgentMcpServer {
  const output = opts.output ?? process.stdout
  const server = new AgentMcpServer({
    execute: opts.execute,
    instructions: opts.instructions,
    serverInfo: opts.serverInfo,
    onLog: opts.onLog,
    write: (msg) => output.write(JSON.stringify(msg) + '\n'),
  })
  const rl = readline.createInterface({ input: opts.input ?? process.stdin })
  // Serialize handling so writes never interleave mid-line under a burst of input.
  let chain: Promise<void> = Promise.resolve()
  rl.on('line', (line) => {
    chain = chain.then(() => server.handleLine(line)).catch((err) => opts.onLog?.(String(err)))
  })
  return server
}

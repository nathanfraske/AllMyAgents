import { describe, it, expect } from 'vitest'
import { AgentMcpServer, inputSchemaFor, type AgentToolExecutor } from './agentMcpServer.js'
import { AGENT_TOOLS, getAgentTool } from './agentToolCore.js'

// Drive the server the way the codex app-server does (verified line shapes against codex 0.145):
// initialize (protocolVersion 2025-06-18) → notifications/initialized → tools/list → tools/call.
function driver(execute: AgentToolExecutor) {
  const out: Record<string, unknown>[] = []
  const server = new AgentMcpServer({ execute, write: (m) => out.push(m as Record<string, unknown>) })
  return { server, out }
}

const okExecutor: AgentToolExecutor = async (name, args) => `ran ${name} with ${JSON.stringify(args)}`

describe('AgentMcpServer (the real stdio MCP server codex loads for the Codex path)', () => {
  it('answers initialize with the negotiated protocol version, serverInfo, and instructions', async () => {
    const { server, out } = driver(okExecutor)
    await server.handleLine(
      JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'codex-mcp-client' } } })
    )
    expect(out).toHaveLength(1)
    const r = out[0]! as { id: number; result: { protocolVersion: string; serverInfo: { name: string }; instructions: string; capabilities: unknown } }
    expect(r.id).toBe(0)
    expect(r.result.protocolVersion).toBe('2025-06-18')
    expect(r.result.serverInfo.name).toBe('allmyagents')
    expect(r.result.capabilities).toEqual({ tools: {} })
    expect(r.result.instructions).toMatch(/semi-trusted/)
  })

  it('notifications/initialized gets no reply (it has no id)', async () => {
    const { server, out } = driver(okExecutor)
    await server.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }))
    expect(out).toHaveLength(0)
  })

  it('tools/list returns all 10 tools with a valid JSON-Schema inputSchema', async () => {
    const { server, out } = driver(okExecutor)
    await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { progressToken: 0 } } }))
    const tools = (out[0]! as { result: { tools: { name: string; description: string; inputSchema: Record<string, unknown> }[] } }).result.tools
    expect(tools.map((t) => t.name)).toEqual(AGENT_TOOLS.map((t) => t.name))
    for (const t of tools) {
      expect(t.inputSchema.type).toBe('object')
      expect(t.description.length).toBeGreaterThan(10)
    }
    // send_message's schema advertises the expected args (body required; to_session/subject optional).
    const send = tools.find((t) => t.name === 'send_message')!
    const props = send.inputSchema.properties as Record<string, unknown>
    expect(Object.keys(props).sort()).toEqual(['body', 'subject', 'to_session'])
    expect(send.inputSchema.required).toEqual(['body'])
  })

  it('tools/call dispatches to the executor and wraps the string in MCP text content', async () => {
    const { server, out } = driver(okExecutor)
    await server.handleLine(
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_agents', arguments: {} } })
    )
    const r = out[0]! as { result: { content: { type: string; text: string }[]; isError?: boolean } }
    expect(r.result.isError).toBeUndefined()
    expect(r.result.content[0]!.type).toBe('text')
    expect(r.result.content[0]!.text).toBe('ran list_agents with {}')
  })

  it('an unknown tool name comes back as an isError result (not a transport error)', async () => {
    const { server, out } = driver(okExecutor)
    await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'nope', arguments: {} } }))
    const r = out[0]! as { result: { content: { text: string }[]; isError: boolean } }
    expect(r.result.isError).toBe(true)
    expect(r.result.content[0]!.text).toMatch(/Unknown tool: nope/)
  })

  it('an executor that throws is reported as an isError tool result', async () => {
    const { server, out } = driver(async () => {
      throw new Error('hub unreachable')
    })
    await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'list_agents', arguments: {} } }))
    const r = out[0]! as { result: { content: { text: string }[]; isError: boolean } }
    expect(r.result.isError).toBe(true)
    expect(r.result.content[0]!.text).toMatch(/Tool error: hub unreachable/)
  })

  it('ping replies empty; an unknown method with an id is a JSON-RPC method-not-found error', async () => {
    const { server, out } = driver(okExecutor)
    await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'ping' }))
    expect(out[0]).toEqual({ jsonrpc: '2.0', id: 5, result: {} })
    await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'resources/list' }))
    const err = out[1]! as { id: number; error: { code: number } }
    expect(err.id).toBe(6)
    expect(err.error.code).toBe(-32601)
  })

  it('a non-JSON line is ignored (never throws, writes nothing)', async () => {
    const { server, out } = driver(okExecutor)
    await server.handleLine('this is not json')
    await server.handleLine('   ')
    expect(out).toHaveLength(0)
  })
})

describe('inputSchemaFor', () => {
  it('converts a tool zod shape to JSON Schema with descriptions + required', () => {
    const schema = inputSchemaFor(getAgentTool('memory_write')!)
    const props = schema.properties as Record<string, { description?: string; enum?: string[] }>
    expect(schema.type).toBe('object')
    expect(props.title!.description).toBeTruthy()
    expect(props.scope!.enum).toEqual(['account', 'project'])
    expect(schema.required).toEqual(['title', 'body'])
  })
})

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import type { SessionIdentity } from './identity.js'
import { AGENT_TOOLS, AGENT_TOOLS_INSTRUCTIONS, type AgentServices, type AgentToolContext } from './agentToolCore.js'

// Re-export the service interfaces from the shared core so existing importers (executor.ts,
// agentWorker.ts, sessions.ts, the worker tests) keep resolving them from agentTools.ts unchanged.
export type { Awaitable, MemoryServices, PracticeServices } from './agentToolCore.js'
export type { AgentServices }

const textResult = (text: string): { content: { type: 'text'; text: string }[] } => ({
  content: [{ type: 'text', text }],
})

/**
 * Build the per-session in-process MCP server exposing the inter-agent + memory tools to a Claude
 * agent. The server is bound to one identity (the hub attributes every call to that caller), so the
 * agent cannot spoof another session. Tools are namespaced `mcp__allmyagents__*`.
 *
 * The tool set is sourced from the provider-agnostic {@link AGENT_TOOLS} core (agentToolCore.ts) — the
 * SAME specs the Codex stdio MCP server exposes — so both providers get identical names, descriptions,
 * zod schemas, bodies, and the `instructions` string. This function is a thin transport adapter: it maps
 * each core spec into the Claude SDK `tool()` shape and wraps the body's plain-text return in MCP text
 * content. Behavior is identical to the pre-refactor inlined server.
 */
export function buildAgentMcpServer(identity: SessionIdentity, services: AgentServices) {
  const ctx: AgentToolContext = { identity, services }
  return createSdkMcpServer({
    name: 'allmyagents',
    version: '0.1.0',
    instructions: AGENT_TOOLS_INSTRUCTIONS,
    tools: AGENT_TOOLS.map((spec) =>
      tool(spec.name, spec.description, spec.schema, async (args: unknown) => textResult(await spec.run(args as never, ctx)))
    ),
  })
}

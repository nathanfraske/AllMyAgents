import { fileURLToPath } from 'node:url'
import { runStdioAgentMcpServer, type AgentToolExecutor } from './agentMcpServer.js'
import { AGENT_TOOLS, AGENT_TOOL_CATALOG_OPERATION, type AgentToolSpec } from './agentToolCore.js'

/**
 * The thin MCP bridge `codex app-server` spawns per Codex thread (declared in the profile's
 * `config.toml [mcp_servers.allmyagents]`, see codexMcpConfig.ts). It exposes the shared agent tools
 * over stdio and forwards each call to the hub, which resolves the identity + runs the real body.
 *
 * IDENTITY (the crux). Codex passes NO thread/session id to an MCP server (verified against codex
 * 0.145 — the stdio child gets identical static config and a generic `initialize`). The one
 * per-session signal codex DOES give a stdio MCP child is its **cwd**: codex spawns the child with the
 * thread's cwd (its session worktree/dir). So the bridge sends `process.cwd()` (which the agent cannot
 * spoof — it is the child process's own working directory, set by codex, not a tool argument) plus the
 * profile id + a hub↔bridge shared secret; the hub maps (profileId, cwd) → the Codex SessionIdentity
 * and runs the tool under the SAME ACL/gating as the Claude path. See docs/codex-agent-tools-parity.md
 * for the attribution analysis + the residual owner decision (cwd is unique per worktree session but
 * can collide for non-worktree/imported sessions sharing a dir).
 */
export interface BridgeEnv {
  hubUrl: string
  secret: string
  profileId: string
  /** Hub-issued thread binding. Absent only for older threads during a rolling upgrade. */
  sessionId?: string
  cwd: string
}

export function readBridgeEnv(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): BridgeEnv {
  const hubUrl = env.AMA_HUB_URL ?? ''
  const secret = env.AMA_HUB_SECRET ?? ''
  const profileId = env.AMA_PROFILE_ID ?? ''
  const sessionId = env.AMA_SESSION_ID?.trim() || undefined
  return { hubUrl, secret, profileId, ...(sessionId ? { sessionId } : {}), cwd }
}

/**
 * Build the executor that forwards a tool call to the hub's internal route. On any transport/HTTP
 * failure it returns a model-readable error string (never throws), so a hub hiccup surfaces as a tool
 * message rather than crashing the Codex turn.
 */
export function makeHubExecutor(cfg: BridgeEnv, fetchImpl: typeof fetch = fetch): AgentToolExecutor {
  return async (name, args) => {
    if (!cfg.hubUrl || !cfg.secret) {
      return 'Tool error: the AllMyAgents bridge is not configured (missing hub URL or secret).'
    }
    try {
      const res = await fetchImpl(`${cfg.hubUrl.replace(/\/$/, '')}/internal/agent-tool`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.secret}` },
        body: JSON.stringify({
          profileId: cfg.profileId,
          sessionId: cfg.sessionId,
          cwd: cfg.cwd,
          tool: name,
          args: args ?? {},
        }),
      })
      const data = (await res.json().catch(() => ({}))) as {
        text?: string
        result?: Awaited<ReturnType<AgentToolExecutor>>
        error?: string
      }
      if (!res.ok || data.error) {
        return `Tool error: ${data.error ?? `hub returned ${res.status}`}`
      }
      return data.result ?? data.text ?? ''
    } catch (err) {
      return `Tool error: could not reach the hub (${err instanceof Error ? err.message : String(err)}).`
    }
  }
}

/** No role comes from MCP arguments or cwd guessing here: the hub resolves the live binding.
 * Old/unreachable hubs retain the pre-upgrade catalog, never a cached role or new execution grant.
 * The deadline keeps discovery from wedging startup during a hub restart.
 */
export function makeHubToolCatalog(cfg: BridgeEnv, fetchImpl: typeof fetch = fetch) {
  const execute = makeHubExecutor(cfg, ((url, init) => fetchImpl(url, {
    ...init, signal: AbortSignal.timeout(3_000),
  })) as typeof fetch)
  return async (): Promise<readonly AgentToolSpec[]> => {
    const result = await execute(AGENT_TOOL_CATALOG_OPERATION, {})
    try {
      if (typeof result !== 'string') return AGENT_TOOLS
      const data = JSON.parse(result) as { version?: unknown; tools?: unknown }
      if (data.version !== 1 || !Array.isArray(data.tools) || !data.tools.every((name) => typeof name === 'string')) return AGENT_TOOLS
      const names = new Set(data.tools)
      return AGENT_TOOLS.filter((tool) => names.has(tool.name))
    } catch { return AGENT_TOOLS }
  }
}

/** Start the stdio MCP server on this process's stdin/stdout. Runs until stdin closes. */
export function startBridge(): void {
  const cfg = readBridgeEnv()
  runStdioAgentMcpServer({
    execute: makeHubExecutor(cfg),
    listTools: makeHubToolCatalog(cfg),
    // Never write logs to stdout — that channel is the MCP JSON-RPC transport. Use stderr.
    onLog: (m) => process.stderr.write(`[allmyagents-bridge] ${m}\n`),
  })
}

// Auto-start only when executed directly as `node agentBridge.js` (not when imported by a test).
const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (invokedDirectly) startBridge()

import fs from 'node:fs'
import path from 'node:path'

/**
 * Register (and idempotently refresh) the hub's `allmyagents` MCP server in a Codex profile's
 * `config.toml`, under `CODEX_HOME` — the mechanism `codex app-server` uses to load external MCP
 * servers (verified against codex 0.145: `[mcp_servers.<name>]` with `command`/`args`/`[env]` for a
 * stdio server). This is what gives a Codex agent the `mcp__allmyagents__*` tools, matching the
 * Claude in-process server. The server NAME must stay `allmyagents` so the tool namespace
 * (`mcp__allmyagents__*`), the hub's auto-allow set, and the trust contract all line up across
 * providers.
 *
 * We own only our own `[mcp_servers.allmyagents]` (+ its `.env` sub-table); every other line in the
 * file — the operator's model/sandbox settings and any other MCP servers — is preserved. Writing is a
 * strip-our-tables-then-append, so it is idempotent and safe to re-run on every spawn.
 */
export interface CodexAgentMcpOptions {
  /** Absolute path to the built bridge entry (agentBridge.js) codex spawns per thread. */
  bridgePath: string
  /** The hub's loopback base URL the bridge forwards tool calls to (e.g. http://127.0.0.1:7777). */
  hubUrl: string
  /** Shared secret authenticating the bridge → hub call (bearer for the internal route). */
  secret: string
  /** The profile this config belongs to — sent to the hub so identity resolution is profile-scoped. */
  profileId: string
  /** Node executable to launch the bridge with (default 'node'). */
  nodePath?: string
  /** MCP server name (default 'allmyagents' — do not change without updating the namespace + ACL). */
  serverName?: string
}

export const AGENT_MCP_SERVER_NAME = 'allmyagents'

/** Encode a string as a TOML basic string (escaping backslashes + quotes). */
function tomlStr(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

/** Normalize a filesystem path to forward slashes (valid + unambiguous in TOML on Windows too). */
function fwd(p: string): string {
  return p.replace(/\\/g, '/')
}

/** Render just the `[mcp_servers.<name>]` + `[mcp_servers.<name>.env]` tables for these options. */
export function renderCodexAgentMcpBlock(opts: CodexAgentMcpOptions): string {
  const name = opts.serverName ?? AGENT_MCP_SERVER_NAME
  const node = opts.nodePath ?? 'node'
  const lines = [
    `[mcp_servers.${name}]`,
    `command = ${tomlStr(node)}`,
    `args = [${tomlStr(fwd(opts.bridgePath))}]`,
    '',
    `[mcp_servers.${name}.env]`,
    `AMA_HUB_URL = ${tomlStr(opts.hubUrl)}`,
    `AMA_HUB_SECRET = ${tomlStr(opts.secret)}`,
    `AMA_PROFILE_ID = ${tomlStr(opts.profileId)}`,
  ]
  return lines.join('\n')
}

/**
 * Return `existing` config.toml text with any prior `[mcp_servers.<name>]` and
 * `[mcp_servers.<name>.env]` tables removed. A TOML table runs from its header to the next header, so
 * we drop the header line and every line under it until the next `[...]` header, for exactly our
 * server's tables — leaving all other content (including other `[mcp_servers.*]`) untouched.
 */
export function stripCodexAgentMcpBlock(existing: string, serverName = AGENT_MCP_SERVER_NAME): string {
  const target = `mcp_servers.${serverName}`
  const out: string[] = []
  let removing = false
  for (const line of existing.split('\n')) {
    const header = /^\s*\[\[?\s*([^[\]]+?)\s*\]\]?\s*$/.exec(line)
    if (header) {
      const tableName = header[1]
      removing = tableName === target || tableName.startsWith(target + '.')
      if (removing) continue
    } else if (removing) {
      continue
    }
    out.push(line)
  }
  // Collapse the trailing blank lines the strip may leave, then re-add a single terminating newline.
  return out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '') + '\n'
}

/** Compute the new config.toml text: strip our old tables, then append the fresh block. */
export function upsertCodexAgentMcp(existing: string, opts: CodexAgentMcpOptions): string {
  const name = opts.serverName ?? AGENT_MCP_SERVER_NAME
  const stripped = stripCodexAgentMcpBlock(existing, name).replace(/\s*$/, '')
  const block = renderCodexAgentMcpBlock(opts)
  return (stripped ? stripped + '\n\n' : '') + block + '\n'
}

/**
 * Read `<codexHome>/config.toml` (may not exist), upsert our server table, write it back. Creates the
 * directory + file if missing. Returns the path written. Throws on IO failure so the caller can decide
 * whether to journal/continue — unlike instruction materialization, a failure here means the Codex
 * agent silently lacks the tools, which is worth surfacing.
 */
export function writeCodexAgentMcpConfig(codexHome: string, opts: CodexAgentMcpOptions): string {
  const file = path.join(codexHome, 'config.toml')
  let existing = ''
  try {
    existing = fs.readFileSync(file, 'utf8')
  } catch {
    /* no config yet */
  }
  const next = upsertCodexAgentMcp(existing, opts)
  fs.mkdirSync(codexHome, { recursive: true })
  fs.writeFileSync(file, next)
  return file
}

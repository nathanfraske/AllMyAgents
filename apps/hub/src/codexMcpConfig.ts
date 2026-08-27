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
  /**
   * Extra node args placed BEFORE the bridge path. A BUILT hub needs none (plain `node dist/agentBridge.js`);
   * a DEV hub running from source points at `agentBridge.ts` and passes the tsx ESM loader here, e.g.
   * `['--import', 'file:///…/tsx/dist/esm/index.mjs']`. The loader must be an ABSOLUTE specifier: codex
   * spawns the bridge with the THREAD's cwd, so a bare `tsx/esm` would resolve against that dir and fail.
   */
  nodeArgs?: string[]
  /** MCP server name (default 'allmyagents' — do not change without updating the namespace + ACL). */
  serverName?: string
}

export const AGENT_MCP_SERVER_NAME = 'allmyagents'
const FILE_CREDENTIAL_STORE = 'cli_auth_credentials_store = "file"'

/** Raw thread-scoped MCP config accepted by Codex's `thread/start` / `thread/resume` config override. */
export interface CodexAgentMcpServerConfig {
  command: string
  args: string[]
  env: Record<string, string>
}

/** Encode a string as a TOML basic string (escaping backslashes + quotes). */
function tomlStr(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

/** Normalize a filesystem path to forward slashes (valid + unambiguous in TOML on Windows too). */
function fwd(p: string): string {
  return p.replace(/\\/g, '/')
}

/** Build the executable MCP config shared by durable TOML and exact per-thread overrides. */
export function codexAgentMcpServerConfig(
  opts: CodexAgentMcpOptions,
  extraEnv: Record<string, string> = {},
): CodexAgentMcpServerConfig {
  return {
    command: opts.nodePath ?? 'node',
    args: [...(opts.nodeArgs ?? []), fwd(opts.bridgePath)],
    env: {
      AMA_HUB_URL: opts.hubUrl,
      AMA_HUB_SECRET: opts.secret,
      AMA_PROFILE_ID: opts.profileId,
      ...extraEnv,
    },
  }
}

/** Render just the `[mcp_servers.<name>]` + `[mcp_servers.<name>.env]` tables for these options. */
export function renderCodexAgentMcpBlock(opts: CodexAgentMcpOptions): string {
  const name = opts.serverName ?? AGENT_MCP_SERVER_NAME
  const server = codexAgentMcpServerConfig(opts)
  const lines = [
    `[mcp_servers.${name}]`,
    `command = ${tomlStr(server.command)}`,
    // node args (dev tsx loader, if any) come first, then the bridge entry itself.
    `args = [${server.args.map(tomlStr).join(', ')}]`,
    '',
    `[mcp_servers.${name}.env]`,
    ...Object.entries(server.env).map(([key, value]) => `${key} = ${tomlStr(value)}`),
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

/**
 * AllMyAgents profiles are intentionally isolated CODEX_HOME directories and the login saga verifies,
 * archives, restores, and watches `<profile>/auth.json`. Codex's `auto` credential-store mode may choose
 * the OS keyring instead, which makes a successful login invisible to that per-profile durability
 * boundary and can make later app-server launches appear signed out. Pin only this app-managed profile
 * to the documented file store while preserving every unrelated top-level key and table.
 */
export function upsertCodexFileCredentialStore(existing: string): string {
  const lines = existing.replace(/\r\n/g, '\n').split('\n')
  const firstTable = lines.findIndex((line) => /^\s*\[\[?[^\]]+\]\]?\s*(?:#.*)?$/.test(line))
  const topLevelEnd = firstTable === -1 ? lines.length : firstTable
  let replaced = false
  const topLevel: string[] = []
  for (let index = 0; index < topLevelEnd; index += 1) {
    const line = lines[index]!
    if (/^\s*cli_auth_credentials_store\s*=/.test(line)) {
      if (!replaced) topLevel.push(FILE_CREDENTIAL_STORE)
      replaced = true
    } else {
      topLevel.push(line)
    }
  }
  if (!replaced) {
    while (topLevel.length && topLevel[topLevel.length - 1] === '') topLevel.pop()
    topLevel.push(FILE_CREDENTIAL_STORE)
    if (firstTable !== -1) topLevel.push('')
  }
  const remainder = firstTable === -1 ? [] : lines.slice(firstTable)
  return [...topLevel, ...remainder].join('\n').replace(/\s*$/, '') + '\n'
}

/** Compute the new config.toml text: strip our old tables, then append the fresh block. */
export function upsertCodexAgentMcp(existing: string, opts: CodexAgentMcpOptions): string {
  const name = opts.serverName ?? AGENT_MCP_SERVER_NAME
  const credentialBound = upsertCodexFileCredentialStore(existing)
  const stripped = stripCodexAgentMcpBlock(credentialBound, name).replace(/\s*$/, '')
  const block = renderCodexAgentMcpBlock(opts)
  return (stripped ? stripped + '\n\n' : '') + block + '\n'
}

/** Pin an app-managed CODEX_HOME to auth.json before launching login, even before it has a chat/MCP block. */
export function writeCodexFileCredentialStoreConfig(codexHome: string): string {
  const file = path.join(codexHome, 'config.toml')
  let existing = ''
  try {
    existing = fs.readFileSync(file, 'utf8')
  } catch {
    /* fresh managed profile */
  }
  const next = upsertCodexFileCredentialStore(existing)
  fs.mkdirSync(codexHome, { recursive: true })
  if (next !== existing) fs.writeFileSync(file, next)
  return file
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

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  renderCodexAgentMcpBlock,
  stripCodexAgentMcpBlock,
  upsertCodexAgentMcp,
  writeCodexAgentMcpConfig,
  type CodexAgentMcpOptions,
} from './codexMcpConfig.js'

const OPTS: CodexAgentMcpOptions = {
  bridgePath: 'C:\\Users\\Admin\\hub\\agentBridge.js',
  hubUrl: 'http://127.0.0.1:7777',
  secret: 'sekret',
  profileId: 'codex-a',
}

describe('renderCodexAgentMcpBlock', () => {
  it('renders a stdio server table + env sub-table codex 0.145 accepts', () => {
    const toml = renderCodexAgentMcpBlock(OPTS)
    expect(toml).toContain('[mcp_servers.allmyagents]')
    expect(toml).toContain('command = "node"')
    // Windows backslashes are normalized to forward slashes (valid + unambiguous in TOML).
    expect(toml).toContain('args = ["C:/Users/Admin/hub/agentBridge.js"]')
    expect(toml).toContain('[mcp_servers.allmyagents.env]')
    expect(toml).toContain('AMA_HUB_URL = "http://127.0.0.1:7777"')
    expect(toml).toContain('AMA_HUB_SECRET = "sekret"')
    expect(toml).toContain('AMA_PROFILE_ID = "codex-a"')
  })

  it('escapes quotes/backslashes in string values (TOML basic-string safety)', () => {
    const toml = renderCodexAgentMcpBlock({ ...OPTS, secret: 'a"b\\c' })
    expect(toml).toContain('AMA_HUB_SECRET = "a\\"b\\\\c"')
  })

  // A DEV hub runs from source, so the bridge is agentBridge.TS and needs the tsx ESM loader in front of
  // it. Without this the dev harness the desktop app actually uses (pnpm hubctl:dev) wires no bridge at
  // all and Codex silently loses the whole tool surface.
  it('places nodeArgs (the dev tsx loader) BEFORE the bridge path', () => {
    const loader = 'file:///C:/repo/node_modules/tsx/dist/esm/index.mjs'
    const toml = renderCodexAgentMcpBlock({
      ...OPTS,
      bridgePath: 'C:\\Users\\Admin\\hub\\src\\agentBridge.ts',
      nodeArgs: ['--import', loader],
    })
    expect(toml).toContain(`args = ["--import", "${loader}", "C:/Users/Admin/hub/src/agentBridge.ts"]`)
  })

  it('omits nodeArgs entirely when not given (built-hub path unchanged)', () => {
    expect(renderCodexAgentMcpBlock(OPTS)).toContain('args = ["C:/Users/Admin/hub/agentBridge.js"]')
  })
})

describe('upsert / strip (preserve the operator config; own only our table)', () => {
  it('appends the block to a config with other settings + another MCP server, keeping them intact', () => {
    const existing = [
      'model = "gpt-5-codex"',
      'approval_policy = "on-request"',
      '',
      '[mcp_servers.playwright]',
      'command = "npx"',
      'args = ["@playwright/mcp@latest"]',
      '',
    ].join('\n')
    const next = upsertCodexAgentMcp(existing, OPTS)
    expect(next).toContain('model = "gpt-5-codex"')
    expect(next).toContain('[mcp_servers.playwright]')
    expect(next).toContain('args = ["@playwright/mcp@latest"]')
    expect(next).toContain('[mcp_servers.allmyagents]')
  })

  it('is idempotent: upserting twice leaves exactly one allmyagents table', () => {
    const once = upsertCodexAgentMcp('', OPTS)
    const twice = upsertCodexAgentMcp(once, { ...OPTS, secret: 'rotated' })
    expect(twice.match(/\[mcp_servers\.allmyagents\]/g)).toHaveLength(1)
    expect(twice.match(/\[mcp_servers\.allmyagents\.env\]/g)).toHaveLength(1)
    // The refreshed value replaced the old one (no stale secret left behind).
    expect(twice).toContain('AMA_HUB_SECRET = "rotated"')
    expect(twice).not.toContain('AMA_HUB_SECRET = "sekret"')
  })

  it('strip removes our table + its env sub-table but nothing after the next header', () => {
    const existing = [
      '[mcp_servers.allmyagents]',
      'command = "node"',
      'args = ["old.js"]',
      '',
      '[mcp_servers.allmyagents.env]',
      'AMA_HUB_SECRET = "old"',
      '',
      '[mcp_servers.keepme]',
      'command = "keep"',
    ].join('\n')
    const stripped = stripCodexAgentMcpBlock(existing)
    expect(stripped).not.toContain('allmyagents')
    expect(stripped).toContain('[mcp_servers.keepme]')
    expect(stripped).toContain('command = "keep"')
  })
})

describe('writeCodexAgentMcpConfig (filesystem)', () => {
  it('creates config.toml under a fresh CODEX_HOME and round-trips', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-codexhome-'))
    try {
      const file = writeCodexAgentMcpConfig(tmp, OPTS)
      expect(file).toBe(path.join(tmp, 'config.toml'))
      const text = fs.readFileSync(file, 'utf8')
      expect(text).toContain('[mcp_servers.allmyagents]')
      // A second write (e.g. next spawn) does not duplicate or corrupt.
      writeCodexAgentMcpConfig(tmp, OPTS)
      const again = fs.readFileSync(file, 'utf8')
      expect(again.match(/\[mcp_servers\.allmyagents\]/g)).toHaveLength(1)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  encodeClaudeCwd,
  normPath,
  cwdMatches,
  isUnderWorktrees,
  isCandidateClaudeDir,
  parseClaudeRecords,
  parseCodexRecords,
  discoverImportableChats,
  readProjectConfig,
  importKey,
} from './importScan.js'
import { defaultHomeProfiles, CLAUDE_DEFAULT_ID, CODEX_DEFAULT_ID } from './profiles.js'
import type { Profile } from './types.js'

describe('encodeClaudeCwd (lossy forward encoding, verified against real dirs)', () => {
  it('collapses every non-alphanumeric char to a dash', () => {
    expect(encodeClaudeCwd('C:\\Users\\Admin\\AiAgentApp')).toBe('C--Users-Admin-AiAgentApp')
    expect(encodeClaudeCwd('C:\\Users\\Admin\\AiAgentApp\\apps\\hub')).toBe('C--Users-Admin-AiAgentApp-apps-hub')
  })
  it('is lossy: space, dash and dot collide onto one name', () => {
    expect(encodeClaudeCwd('a foo bar')).toBe(encodeClaudeCwd('a-foo-bar'))
    expect(encodeClaudeCwd('a.foo.bar')).toBe(encodeClaudeCwd('a foo bar'))
  })
})

describe('cwdMatches / normPath (the ground-truth confirmation)', () => {
  it('normalizes separators, trailing slash and case', () => {
    expect(normPath('C:\\Users\\Admin\\AiAgentApp\\')).toBe('c:/users/admin/aiagentapp')
  })
  it('matches the folder itself', () => {
    expect(cwdMatches('C:\\Users\\Admin\\AiAgentApp', 'C:/Users/Admin/AiAgentApp')).toBe(true)
  })
  it('matches a nested cwd (inside the folder)', () => {
    expect(cwdMatches('C:\\Users\\Admin\\AiAgentApp\\apps\\hub', 'C:\\Users\\Admin\\AiAgentApp')).toBe(true)
  })
  it('rejects a sibling that merely shares a prefix', () => {
    expect(cwdMatches('C:\\Users\\Admin\\AiAgentApp2', 'C:\\Users\\Admin\\AiAgentApp')).toBe(false)
  })
  it('rejects an unrelated folder', () => {
    expect(cwdMatches('C:\\Users\\Admin\\Other', 'C:\\Users\\Admin\\AiAgentApp')).toBe(false)
  })
})

describe('isUnderWorktrees (hub scratch exclusion)', () => {
  const root = 'C:\\Users\\Admin\\AiAgentApp\\data\\worktrees'
  it('flags a cwd inside the worktrees root', () => {
    expect(isUnderWorktrees('C:\\Users\\Admin\\AiAgentApp\\data\\worktrees\\24605d07', root)).toBe(true)
  })
  it('leaves a normal project cwd alone', () => {
    expect(isUnderWorktrees('C:\\Users\\Admin\\AiAgentApp', root)).toBe(false)
  })
})

describe('isCandidateClaudeDir (fast narrowing before cwd confirmation)', () => {
  const target = 'C:\\Users\\Admin\\AiAgentApp'
  it('accepts the exact encoded folder', () => {
    expect(isCandidateClaudeDir('C--Users-Admin-AiAgentApp', target)).toBe(true)
  })
  it('accepts a subfolder encoding (prefix + dash)', () => {
    expect(isCandidateClaudeDir('C--Users-Admin-AiAgentApp-apps-hub', target)).toBe(true)
  })
  it('rejects an unrelated folder', () => {
    expect(isCandidateClaudeDir('C--Users-Admin-Documents-Other', target)).toBe(false)
  })
})

describe('parseClaudeRecords (real Claude JSONL shape)', () => {
  it('pulls cwd/sessionId/model/gitBranch, skips tool_result, finds the first real prompt', () => {
    const records = [
      { type: 'queue-operation', operation: 'enqueue', sessionId: 'sid-1' },
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'Fix the login redirect loop' }] },
        cwd: 'C:\\Users\\Admin\\AiAgentApp',
        gitBranch: 'main',
        sessionId: 'sid-1',
      },
      { type: 'assistant', message: { model: 'claude-opus-4-8', content: [{ type: 'text', text: 'ok' }] }, sessionId: 'sid-1' },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'x' }] }, sessionId: 'sid-1' },
      { type: 'ai-title', aiTitle: 'Login redirect fix', sessionId: 'sid-1' },
    ]
    const p = parseClaudeRecords(records)
    expect(p.sessionId).toBe('sid-1')
    expect(p.cwd).toBe('C:\\Users\\Admin\\AiAgentApp')
    expect(p.gitBranch).toBe('main')
    expect(p.model).toBe('claude-opus-4-8')
    expect(p.firstPrompt).toBe('Fix the login redirect loop')
    expect(p.aiTitle).toBe('Login redirect fix')
    expect(p.messageCount).toBe(3) // 2 user + 1 assistant
  })
  it('handles a string content body and ignores meta user records', () => {
    const p = parseClaudeRecords([
      { type: 'user', isMeta: true, message: { content: 'Caveat: The messages below were generated…' } },
      { type: 'user', message: { content: 'just a plain string prompt' }, cwd: 'C:/x' },
    ])
    expect(p.firstPrompt).toBe('just a plain string prompt')
  })
  it('strips the hub-prepended thinking-budget keyword line from the first prompt', () => {
    const p = parseClaudeRecords([
      { type: 'user', message: { content: [{ type: 'text', text: 'ultrathink\n\nWhat is 29 times 31?' }] }, cwd: 'C:/x' },
    ])
    expect(p.firstPrompt).toBe('What is 29 times 31?')
  })
  it('skips slash-command probes (no real prompt, no ai-title)', () => {
    const p = parseClaudeRecords([
      { type: 'user', isMeta: true, message: { content: '<local-command-caveat>…</local-command-caveat>' } },
      { type: 'user', message: { content: '<command-name>/usage</command-name>' }, cwd: 'C:/x' },
    ])
    expect(p.firstPrompt).toBeUndefined()
    expect(p.aiTitle).toBeUndefined()
  })
})

describe('parseCodexRecords (real Codex rollout shape)', () => {
  it('reads session_meta and the first user_message event, skipping injected framing', () => {
    const records = [
      {
        type: 'session_meta',
        payload: { session_id: '019f9127-4ec1-7763-9756-fb1064aa8658', cwd: 'C:\\Users\\Admin\\AiAgentApp\\spikes', originator: 'aiagentapp-spike', cli_version: '0.145.0' },
      },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } },
      { type: 'response_item', payload: { role: 'user', type: 'message', content: [{ type: 'input_text', text: '<recommended_plugins> …' }] } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'Reply with exactly: hub spike ok' } },
      { type: 'event_msg', payload: { type: 'agent_message', message: 'hub spike ok' } },
    ]
    const p = parseCodexRecords(records)
    expect(p.sessionId).toBe('019f9127-4ec1-7763-9756-fb1064aa8658')
    expect(p.cwd).toBe('C:\\Users\\Admin\\AiAgentApp\\spikes')
    expect(p.originator).toBe('aiagentapp-spike')
    expect(p.firstPrompt).toBe('Reply with exactly: hub spike ok')
    expect(p.messageCount).toBe(2) // 1 user_message + 1 agent_message
  })
})

describe('defaultHomeProfiles (~/.claude + ~/.codex as importable profiles)', () => {
  let home: string
  beforeAll(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-home-'))
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true })
  })
  afterAll(() => fs.rmSync(home, { recursive: true, force: true }))
  it('registers both homes as fixed-id profiles when the dirs exist (no cred file required)', () => {
    const profs = defaultHomeProfiles(home)
    expect(profs).toEqual([
      { id: CLAUDE_DEFAULT_ID, provider: 'claude', dir: path.join(home, '.claude') },
      { id: CODEX_DEFAULT_ID, provider: 'codex', dir: path.join(home, '.codex') },
    ])
  })
  it('omits a home whose directory is absent', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-nohome-'))
    fs.mkdirSync(path.join(empty, '.codex'))
    expect(defaultHomeProfiles(empty).map((p) => p.id)).toEqual([CODEX_DEFAULT_ID])
    fs.rmSync(empty, { recursive: true, force: true })
  })
})

describe('readProjectConfig (values-free surfacing of MCP / hooks / memory)', () => {
  let dir: string
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-cfg-'))
    fs.writeFileSync(
      path.join(dir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          github: { command: 'npx', args: ['-y', 'server-github'], env: { GITHUB_TOKEN: 'secret' } },
          remote: { type: 'http', url: 'https://example.com/mcp' },
        },
      })
    )
    fs.mkdirSync(path.join(dir, '.claude'))
    fs.writeFileSync(
      path.join(dir, '.claude', 'settings.json'),
      JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node', args: ['audit hook.js'], shell: 'bash' }] }] }, permissions: { allow: ['Bash'], deny: [] } })
    )
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'project memory')
  })
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))
  it('surfaces MCP transport + the COMMAND that runs (never the secret values), hooks + hook commands, permissions, memory', () => {
    const cfg = readProjectConfig(dir)
    // The command/url IS surfaced (it is the executable surface the operator approves — "runs `npx …`"),
    // but the secret env/header VALUES are NOT, only hasSecrets.
    expect(cfg.mcpServers).toEqual([
      { name: 'github', transport: 'stdio', hasSecrets: true, command: 'npx -y server-github' },
      { name: 'remote', transport: 'http', hasSecrets: false, command: 'https://example.com/mcp' },
    ])
    expect(cfg.hooks).toEqual(['PreToolUse'])
    // The actual hook command must be shown — "a PreToolUse hook exists" is not a decision anyone can make.
    expect(cfg.hookCommands).toEqual([
      {
        event: 'PreToolUse',
        command: 'node',
        args: ['audit hook.js'],
        shell: 'bash',
      },
    ])
    expect(cfg.hasPermissions).toBe(true)
    expect(cfg.memoryFiles).toEqual([{ name: 'CLAUDE.md', bytes: fs.statSync(path.join(dir, 'CLAUDE.md')).size }])
    expect(cfg.sources).toContain('.mcp.json')
    // Sanity: no secret VALUE leaks into the surfaced config.
    expect(JSON.stringify(cfg)).not.toContain('secret')
  })
  it('returns empty config for a bare folder', () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-bare-'))
    const cfg = readProjectConfig(bare)
    expect(cfg.mcpServers).toEqual([])
    expect(cfg.hooks).toEqual([])
    expect(cfg.hookCommands).toEqual([])
    expect(cfg.memoryFiles).toEqual([])
    fs.rmSync(bare, { recursive: true, force: true })
  })
})

// --- Fixture round trip: exercise the real file walk + cwd confirmation + dedupe end-to-end -------
describe('discoverImportableChats (fixture profiles on disk)', () => {
  let tmp: string
  let profiles: Profile[]
  const target = path.join('C:', 'proj', 'MyApp') // a synthetic target cwd embedded in the fixtures

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-import-'))
    // Claude profile: two transcripts under the encoded folder — one matching the target cwd, one
    // whose cwd is a sibling (must be rejected despite the lossy folder-name collision).
    const claudeDir = path.join(tmp, 'claude-a')
    const enc = encodeClaudeCwd(target)
    const projDir = path.join(claudeDir, 'projects', enc)
    fs.mkdirSync(projDir, { recursive: true })
    fs.writeFileSync(
      path.join(projDir, 'aaaaaaaa-0000-0000-0000-000000000001.jsonl'),
      [
        JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'Build the widget' }] }, cwd: target, sessionId: 'aaaaaaaa-0000-0000-0000-000000000001' }),
        JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-4-8', content: [{ type: 'text', text: 'done' }] }, sessionId: 'aaaaaaaa-0000-0000-0000-000000000001' }),
      ].join('\n')
    )
    // A sibling cwd that encodes into the SAME candidate-prefix bucket — rejected via the cwd field.
    const sibling = path.join('C:', 'proj', 'MyApp-other')
    const sibDir = path.join(claudeDir, 'projects', encodeClaudeCwd(sibling))
    fs.mkdirSync(sibDir, { recursive: true })
    fs.writeFileSync(
      path.join(sibDir, 'bbbbbbbb-0000-0000-0000-000000000002.jsonl'),
      JSON.stringify({ type: 'user', message: { content: 'nope' }, cwd: sibling, sessionId: 'bbbbbbbb-0000-0000-0000-000000000002' })
    )
    // Codex profile: one rollout for the target cwd in the date-partitioned tree.
    const codexDir = path.join(tmp, 'codex-a')
    const dayDir = path.join(codexDir, 'sessions', '2026', '07', '23')
    fs.mkdirSync(dayDir, { recursive: true })
    fs.writeFileSync(
      path.join(dayDir, 'rollout-2026-07-23T17-45-05-cccccccc-0000-0000-0000-000000000003.jsonl'),
      [
        JSON.stringify({ type: 'session_meta', payload: { session_id: 'cccccccc-0000-0000-0000-000000000003', cwd: target, originator: 'vscode' } }),
        JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'Ship the codex change' } }),
      ].join('\n')
    )
    profiles = [
      { id: 'claude-a', provider: 'claude', dir: claudeDir },
      { id: 'codex-a', provider: 'codex', dir: codexDir },
    ]
  })

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('finds the matching Claude + Codex chats, rejects the sibling, auto-names them', async () => {
    const res = await discoverImportableChats({ profiles, path: target, importedKeys: new Set() })
    const ids = res.chats.map((c) => c.vendorSessionId).sort()
    expect(ids).toEqual(['aaaaaaaa-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000003'])
    const claude = res.chats.find((c) => c.provider === 'claude')!
    expect(claude.title).toBe('Build the widget')
    expect(claude.model).toBe('claude-opus-4-8')
    expect(claude.profileId).toBe('claude-a')
    const codex = res.chats.find((c) => c.provider === 'codex')!
    expect(codex.title).toBe('Ship the codex change')
    expect(res.byProfile).toEqual({ 'claude-a': 1, 'codex-a': 1 })
  })

  it('marks an already-imported chat and drops it from the byProfile count', async () => {
    const importedKeys = new Set([importKey('claude-a', 'aaaaaaaa-0000-0000-0000-000000000001')])
    const res = await discoverImportableChats({ profiles, path: target, importedKeys })
    const claude = res.chats.find((c) => c.vendorSessionId === 'aaaaaaaa-0000-0000-0000-000000000001')!
    expect(claude.alreadyImported).toBe(true)
    expect(res.byProfile).toEqual({ 'codex-a': 1 }) // claude one is already imported → not counted
  })

  it('excludes transcripts whose cwd is inside the hub worktrees root', async () => {
    // Point the worktrees root at the target so the fixtures count as "hub scratch" → nothing offered.
    const res = await discoverImportableChats({ profiles, path: target, importedKeys: new Set(), worktreesRoot: target })
    expect(res.chats).toHaveLength(0)
  })
})

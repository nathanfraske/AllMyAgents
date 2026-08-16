import crypto from 'node:crypto'
import type Database from 'better-sqlite3'

export type GitHubAutomationCapability =
  | 'pull_requests'
  | 'pull_request_merges'
  | 'workflow_runs'
  | 'repository_pushes'

export type GitHubAutomationPolicyScope = 'project' | 'session'

export interface GitHubAutomationPolicy {
  scope: GitHubAutomationPolicyScope
  targetId: string
  capabilities: GitHubAutomationCapability[]
  updatedAt: string
}

interface GitHubAutomationPolicyRow {
  scope: string
  targetId: string
  capabilities: string
  updatedAt: string
}

export interface GitHubAutomationApproval {
  capability: GitHubAutomationCapability
  transport: 'cli' | 'mcp'
  operation: string
  /** Explicit owner/repository selector, when the request carries one. */
  repository?: string
  /** Bounded audit data. Free-form PR bodies/comments are represented by length + digest, never copied. */
  parameterSummary?: Record<string, string | number | boolean | null | { chars: number; sha256: string }>
}

export const GITHUB_AUTOMATION_CAPABILITIES: readonly GitHubAutomationCapability[] = [
  'pull_requests',
  'pull_request_merges',
  'workflow_runs',
  'repository_pushes',
]

const CAPABILITY_SET = new Set<string>(GITHUB_AUTOMATION_CAPABILITIES)

export function normalizeGitHubAutomationCapabilities(
  values: readonly unknown[],
): GitHubAutomationCapability[] {
  const result: GitHubAutomationCapability[] = []
  for (const value of values) {
    if (typeof value !== 'string' || !CAPABILITY_SET.has(value)) {
      throw new Error(
        `GitHub automation capabilities may contain only ${GITHUB_AUTOMATION_CAPABILITIES.join(', ')}`,
      )
    }
    const capability = value as GitHubAutomationCapability
    if (!result.includes(capability)) result.push(capability)
  }
  return result
}

/**
 * Durable operator policy. Project grants follow a project across manager/team rotations; session grants
 * are an exact-chat escape hatch for a particular manager or Overseer. No absent row implies authority.
 */
export class GitHubAutomationPolicyStore {
  private readonly getStmt: Database.Statement
  private readonly upsertStmt: Database.Statement

  constructor(private readonly db: Database.Database) {
    db.exec(
      `CREATE TABLE IF NOT EXISTS github_automation_policy (
        scope TEXT NOT NULL,
        targetId TEXT NOT NULL,
        capabilities TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        PRIMARY KEY (scope, targetId)
      )`,
    )
    this.getStmt = db.prepare(
      'SELECT scope, targetId, capabilities, updatedAt FROM github_automation_policy WHERE scope = ? AND targetId = ?',
    )
    this.upsertStmt = db.prepare(
      `INSERT INTO github_automation_policy (scope, targetId, capabilities, updatedAt)
       VALUES (@scope, @targetId, @capabilities, @updatedAt)
       ON CONFLICT(scope, targetId) DO UPDATE SET
         capabilities = excluded.capabilities,
         updatedAt = excluded.updatedAt`,
    )
  }

  get(scope: GitHubAutomationPolicyScope, targetId: string): GitHubAutomationPolicy {
    const row = this.getStmt.get(scope, targetId) as GitHubAutomationPolicyRow | undefined
    if (!row) return { scope, targetId, capabilities: [], updatedAt: '' }
    let parsed: unknown = []
    try {
      parsed = JSON.parse(row.capabilities)
    } catch {
      // A malformed row never creates authority.
    }
    let capabilities: GitHubAutomationCapability[] = []
    try {
      capabilities = Array.isArray(parsed) ? normalizeGitHubAutomationCapabilities(parsed) : []
    } catch {
      // Unknown values from a newer or damaged row fail closed instead of being partially honored.
    }
    return { scope, targetId, capabilities, updatedAt: row.updatedAt }
  }

  set(
    scope: GitHubAutomationPolicyScope,
    targetId: string,
    values: readonly unknown[],
  ): GitHubAutomationPolicy {
    if (scope !== 'project' && scope !== 'session') throw new Error('invalid GitHub automation policy scope')
    const normalizedTarget = targetId.trim()
    if (!normalizedTarget || normalizedTarget.length > 256) throw new Error('invalid GitHub automation policy target')
    const capabilities = normalizeGitHubAutomationCapabilities(values)
    const policy: GitHubAutomationPolicy = {
      scope,
      targetId: normalizedTarget,
      capabilities,
      updatedAt: new Date().toISOString(),
    }
    this.upsertStmt.run({ ...policy, capabilities: JSON.stringify(capabilities) })
    return policy
  }
}

const PR_OPERATIONS = new Set([
  'checks',
  'close',
  'comment',
  'create',
  'diff',
  'edit',
  'list',
  'ready',
  'reopen',
  'review',
  'status',
  'view',
])
const WORKFLOW_OPERATIONS = new Set(['list', 'run', 'view'])
const RUN_OPERATIONS = new Set(['cancel', 'list', 'rerun', 'view', 'watch'])
const SHELL_META = /[\r\n;&|<>`$()]/u
const SHELL_CONTROL_TOKENS = new Set(['&&', '||', ';', '|', '&', '>', '>>', '<', '<<'])

function unquote(token: string): string {
  return token.length >= 2 &&
    ((token.startsWith('"') && token.endsWith('"')) ||
      (token.startsWith("'") && token.endsWith("'")))
    ? token.slice(1, -1)
    : token
}

function commandTokens(payload: unknown): string[] | undefined {
  const p = payload as {
    input?: { command?: unknown } | null
    command?: unknown
    cmd?: unknown
    commandActions?: unknown
  } | null
  if (!p) return undefined
  const actions = Array.isArray(p.commandActions) ? p.commandActions : undefined
  const actionCommand =
    actions?.length === 1 &&
    actions[0] &&
    typeof actions[0] === 'object' &&
    typeof (actions[0] as { command?: unknown }).command === 'string'
      ? (actions[0] as { command: string }).command
      : undefined
  const raw = actionCommand ?? p.input?.command ?? p.command ?? p.cmd
  if (Array.isArray(raw)) {
    if (
      raw.length === 0 ||
      raw.some((token) => typeof token !== 'string' || !token.trim() || SHELL_META.test(token))
    ) {
      return undefined
    }
    const tokens = raw.map((token) => (token as string).trim())
    return tokens.some((token) => SHELL_CONTROL_TOKENS.has(token)) ? undefined : tokens.map(unquote)
  }
  if (typeof raw !== 'string') return undefined
  const command = raw.trim()
  if (!command || SHELL_META.test(command)) return undefined
  const matches = command.match(/"[^"]*"|'[^']*'|[^\s]+/gu)
  if (!matches || matches.join(' ').replace(/\s+/gu, ' ') !== command.replace(/\s+/gu, ' ')) {
    return undefined
  }
  return matches.map(unquote)
}

function normalizedRepository(value: string): string | undefined {
  const candidate = value.trim().replace(/\.git$/iu, '').replace(/^https?:\/\/(?:www\.)?github\.com\//iu, '')
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/u.exec(candidate)
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : undefined
}

function explicitRepository(tokens: readonly string[]): string | undefined | null {
  let repository: string | undefined
  const accept = (candidate: string | undefined): boolean => {
    if (!candidate || (repository !== undefined && repository !== candidate)) return false
    repository = candidate
    return true
  }
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!
    if (token === '--repo' || token === '-R') {
      const value = tokens[i + 1]
      if (!value || !accept(normalizedRepository(value))) return null
      i += 1
      continue
    }
    if (token.startsWith('--repo=') || token.startsWith('-R=')) {
      if (!accept(normalizedRepository(token.slice(token.indexOf('=') + 1)))) return null
      continue
    }
    if (token.startsWith('-R') && token.length > 2) {
      if (!accept(normalizedRepository(token.slice(2)))) return null
      continue
    }
    const urlMatch = /https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/|$)/iu.exec(token)
    if (urlMatch && !accept(`${urlMatch[1]}/${urlMatch[2].replace(/\.git$/iu, '')}`.toLowerCase())) {
      return null
    }
    const qualifiedPr = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#\d+$/u.exec(token)
    if (qualifiedPr && !accept(`${qualifiedPr[1]}/${qualifiedPr[2]}`.toLowerCase())) return null
    if (/^--hostname(?:=|$)/u.test(token)) return null
  }
  return repository
}

function classifyGh(tokens: string[]): GitHubAutomationApproval | undefined {
  // Paths are rejected even when their basename is gh: a repository-local lookalike executable must not
  // inherit the authority intended for the installed GitHub CLI.
  if (!/^(?:gh|gh\.exe)$/iu.test(tokens[0] ?? '')) return undefined
  if (tokens.length < 3) return undefined
  let cursor = 1
  let repository: string | undefined
  while (cursor < tokens.length && tokens[cursor]!.startsWith('-')) {
    const flag = tokens[cursor]!
    if (flag === '--repo' || flag === '-R') {
      const parsed = normalizedRepository(tokens[cursor + 1] ?? '')
      if (!parsed || (repository !== undefined && repository !== parsed)) return undefined
      repository = parsed
      cursor += 2
      continue
    }
    if (flag.startsWith('--repo=') || flag.startsWith('-R=')) {
      const parsed = normalizedRepository(flag.slice(flag.indexOf('=') + 1))
      if (!parsed || (repository !== undefined && repository !== parsed)) return undefined
      repository = parsed
      cursor += 1
      continue
    }
    if (flag.startsWith('-R') && flag.length > 2) {
      const parsed = normalizedRepository(flag.slice(2))
      if (!parsed || (repository !== undefined && repository !== parsed)) return undefined
      repository = parsed
      cursor += 1
      continue
    }
    return undefined
  }
  const group = tokens[cursor++]?.toLowerCase()
  const operation = tokens[cursor++]?.toLowerCase()
  if (!group || !operation) return undefined
  const target = explicitRepository(tokens.slice(cursor))
  if (target === null) return undefined
  if (repository && target && repository !== target) return undefined
  repository = target ?? repository
  if (group === 'pr') {
    const args = tokens.slice(cursor)
    if (args.some((token) =>
      token === '-F' || token.startsWith('-F') ||
      token === '-T' || token.startsWith('-T') ||
      token === '-e' || token === '--editor' ||
      token === '-w' || token === '--web' ||
      token === '--delete-last' ||
      token === '--admin' || token.startsWith('--admin=') ||
      token === '--delete-branch' || token.startsWith('--delete-branch=') ||
      token === '--body-file' || token.startsWith('--body-file=') ||
      token === '--template' || token.startsWith('--template=') ||
      token === '--recover' || token.startsWith('--recover='),
    )) {
      return undefined
    }
    const hasFlag = (...names: string[]): boolean =>
      args.some((token) => names.some((name) => token === name || token.startsWith(`${name}=`)))
    const hasNonemptyValue = (...names: string[]): boolean =>
      args.some((token, index) => names.some((name) =>
        (token.startsWith(`${name}=`) && token.length > name.length + 1) ||
        (token === name && !!args[index + 1] && !args[index + 1]!.startsWith('-')),
      ))
    // Keep standing grants non-interactive. Otherwise gh may open an editor or prompt for a choice in a
    // tool process the agent cannot answer, leaving the turn looking frozen after its approval vanished.
    if (operation === 'create') {
      const fillsFromCommit = hasFlag('-f', '--fill', '--fill-first', '--fill-verbose')
      if (
        !hasNonemptyValue('-H', '--head') ||
        (!fillsFromCommit && !(hasNonemptyValue('-t', '--title') && hasNonemptyValue('-b', '--body')))
      ) {
        return undefined
      }
    }
    if (operation === 'comment' && !hasNonemptyValue('-b', '--body')) return undefined
    if (operation === 'review') {
      const approveOnly = hasFlag('-a', '--approve')
      const writtenReview = hasFlag('-c', '--comment', '-r', '--request-changes')
      if (!approveOnly && !(writtenReview && hasNonemptyValue('-b', '--body'))) return undefined
    }
    if (operation === 'merge') {
      if (!hasFlag('-m', '--merge', '-r', '--rebase', '-s', '--squash', '--disable-auto')) {
        return undefined
      }
      return { capability: 'pull_request_merges', transport: 'cli', operation: 'gh pr merge', ...(repository ? { repository } : {}) }
    }
    if (PR_OPERATIONS.has(operation)) {
      return { capability: 'pull_requests', transport: 'cli', operation: `gh pr ${operation}`, ...(repository ? { repository } : {}) }
    }
    return undefined
  }
  if (group === 'workflow' && WORKFLOW_OPERATIONS.has(operation)) {
    const args = tokens.slice(cursor)
    // `--field`/`-F` treats @value as a filename and uploads its contents. Raw fields remain literal.
    if (operation === 'run' && args.some((token) => token === '-F' || token.startsWith('-F') || token === '--field' || token.startsWith('--field='))) {
      return undefined
    }
    if (operation === 'run' && (!args[0] || args[0].startsWith('-'))) return undefined
    return { capability: 'workflow_runs', transport: 'cli', operation: `gh workflow ${operation}`, ...(repository ? { repository } : {}) }
  }
  if (group === 'run' && RUN_OPERATIONS.has(operation)) {
    const args = tokens.slice(cursor)
    if (operation === 'cancel' && args.some((token) => token === '--force')) return undefined
    if (operation !== 'list' && (!args[0] || args[0].startsWith('-'))) return undefined
    return { capability: 'workflow_runs', transport: 'cli', operation: `gh run ${operation}`, ...(repository ? { repository } : {}) }
  }
  return undefined
}

function classifyGitPush(tokens: string[]): GitHubAutomationApproval | undefined {
  if (!/^(?:git|git\.exe)$/iu.test(tokens[0] ?? '') || tokens[1] !== 'push') return undefined
  const args = tokens.slice(2)
  if (
    args.some((arg) =>
      arg === '-f' ||
      arg === '--force' ||
      arg.startsWith('--force=') ||
      arg.startsWith('--force-with-lease') ||
      arg === '-d' ||
      arg === '--delete' ||
      arg === '--mirror' ||
      arg === '--prune' ||
      arg.startsWith('+') ||
      arg.includes(':') ||
      /^(?:--repo|--git-dir|--work-tree|--receive-pack|--exec)(?:=|$)/u.test(arg) ||
      /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(arg) ||
      /^[^/@\s]+@[^:\s]+:/u.test(arg),
    )
  ) {
    return undefined
  }
  const valueFlags = new Set(['-o', '--push-option'])
  const flagOnly = new Set([
    '-u', '--set-upstream', '--porcelain', '--quiet', '-q', '--verbose', '-v', '--dry-run',
    '--follow-tags', '--atomic', '--no-verify',
  ])
  const positional: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!
    if (valueFlags.has(arg)) {
      // Push options are interpreted by a remote hook and may request arbitrary server-side behavior;
      // keep them outside the standing grant.
      return undefined
    }
    if (arg.startsWith('--push-option=') || arg.startsWith('-o')) return undefined
    if (flagOnly.has(arg)) continue
    if (arg.startsWith('-')) return undefined
    positional.push(arg)
  }
  // Requiring the literal origin remote prevents a repository config from silently selecting a different
  // upstream. A branch/ref may follow, but force/delete refspecs were rejected above.
  if (positional.length !== 2 || positional[0] !== 'origin') return undefined
  return { capability: 'repository_pushes', transport: 'cli', operation: 'git push' }
}

const MCP_PULL_REQUEST_OPERATIONS = new Set([
  'add_comment_to_pull_request',
  'close_pull_request',
  'create_pull_request',
  'create_pull_request_review',
  'get_pull_request',
  'get_pull_request_diff',
  'get_pull_request_files',
  'get_pull_request_reviews',
  'list_pull_requests',
  'mark_pull_request_ready_for_review',
  'reopen_pull_request',
  'request_pull_request_review',
  'update_pull_request',
])
const MCP_WORKFLOW_OPERATIONS = new Set([
  'cancel_workflow_run',
  'get_workflow_run',
  'list_workflow_runs',
  'rerun_workflow',
  'run_workflow',
  'trigger_workflow',
])

function mcpOperation(toolName: string): string | undefined {
  const lower = toolName.trim().toLowerCase()
  if (lower.startsWith('mcp__github__')) return lower.slice('mcp__github__'.length)
  // Some vendor bridges flatten the official server name into one prefix.
  if (lower.startsWith('github_')) return lower.slice('github_'.length)
  return undefined
}

function repositoryFromToolInput(input: unknown): string | undefined | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
  const row = input as Record<string, unknown>
  const candidates: string[] = []
  if (typeof row.owner === 'string' && typeof row.repo === 'string') {
    const candidate = normalizedRepository(`${row.owner}/${row.repo}`)
    if (!candidate) return null
    candidates.push(candidate)
  }
  for (const key of ['repository', 'repo', 'nameWithOwner']) {
    if (typeof row[key] === 'string' && (row[key] as string).includes('/')) {
      const candidate = normalizedRepository(row[key] as string)
      if (!candidate) return null
      candidates.push(candidate)
    }
  }
  if (new Set(candidates).size > 1) return null
  return candidates[0]
}

function classifyMcp(payload: unknown): GitHubAutomationApproval | undefined {
  const p = payload as { toolName?: unknown; input?: unknown } | null
  if (!p || typeof p.toolName !== 'string') return undefined
  const operation = mcpOperation(p.toolName)
  if (!operation) return undefined
  const repository = repositoryFromToolInput(p.input)
  if (repository === null) return undefined
  if (operation === 'merge_pull_request') {
    return { capability: 'pull_request_merges', transport: 'mcp', operation, ...(repository ? { repository } : {}) }
  }
  if (MCP_PULL_REQUEST_OPERATIONS.has(operation)) {
    return { capability: 'pull_requests', transport: 'mcp', operation, ...(repository ? { repository } : {}) }
  }
  if (MCP_WORKFLOW_OPERATIONS.has(operation)) {
    return { capability: 'workflow_runs', transport: 'mcp', operation, ...(repository ? { repository } : {}) }
  }
  return undefined
}

const CONNECTOR_PULL_REQUEST_OPERATIONS = new Set([
  'add_comment_to_issue',
  'add_comment_to_pull_request',
  'close_pull_request',
  'create_pull_request',
  'create_pull_request_review',
  'mark_pull_request_ready_for_review',
  'reopen_pull_request',
  'request_pull_request_review',
  'update_issue_comment',
  'update_pull_request',
])
const CONNECTOR_WORKFLOW_OPERATIONS = new Set([
  'cancel_workflow_run',
  'rerun_workflow',
  'run_workflow',
  'trigger_workflow',
])
const CONNECTOR_REPOSITORY_PUSH_OPERATIONS = new Set([
  'create_or_update_file',
  'push_files',
])

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function repositoryFromConnectorParams(input: Record<string, unknown>): string | undefined | null {
  const candidates: string[] = []
  const add = (value: unknown): boolean => {
    if (typeof value !== 'string') return true
    const normalized = normalizedRepository(value)
    if (!normalized) return false
    candidates.push(normalized)
    return true
  }
  for (const key of ['repository_full_name', 'repo_full_name', 'repository', 'nameWithOwner']) {
    if (!add(input[key])) return null
  }
  if (typeof input.owner === 'string' || typeof input.repo === 'string') {
    if (typeof input.owner !== 'string' || typeof input.repo !== 'string') return null
    if (!add(`${input.owner}/${input.repo}`)) return null
  }
  return new Set(candidates).size > 1 ? null : candidates[0]
}

function connectorParameterSummary(
  input: Record<string, unknown>,
  repository: string,
): NonNullable<GitHubAutomationApproval['parameterSummary']> {
  const summary: NonNullable<GitHubAutomationApproval['parameterSummary']> = { repository }
  const scalarKeys = [
    'pr_number', 'pull_number', 'issue_number', 'comment_id', 'run_id', 'workflow_id',
    'base_branch', 'head_branch', 'branch', 'ref', 'draft', 'maintainer_can_modify',
  ]
  for (const key of scalarKeys) {
    const value = input[key]
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) {
      summary[key] = value
    }
  }
  for (const key of ['title', 'body', 'comment']) {
    const value = input[key]
    if (typeof value !== 'string') continue
    summary[key] = {
      chars: value.length,
      sha256: crypto.createHash('sha256').update(value).digest('hex'),
    }
  }
  return summary
}

/**
 * Codex apps use an MCP form elicitation for connector approvals. This is intentionally stricter than
 * the generic MCP classifier: only the trusted GitHub connector, its empty approval form, one explicit
 * repository, and a closed operation grammar can consume an operator's standing GitHub grant.
 */
function classifyCodexConnectorElicitation(payload: unknown): GitHubAutomationApproval | undefined {
  if (!isPlainObject(payload)) return undefined
  if (payload.serverName !== 'codex_apps' || payload.mode !== 'form') return undefined
  const schema = payload.requestedSchema
  if (!isPlainObject(schema) || schema.type !== 'object' || !isPlainObject(schema.properties)) return undefined
  if (Object.keys(schema.properties).length !== 0) return undefined
  const meta = payload._meta
  if (!isPlainObject(meta)) return undefined
  if (
    meta.source !== 'connector' ||
    meta.connector_name !== 'GitHub' ||
    meta.codex_approval_kind !== 'mcp_tool_call'
  ) {
    return undefined
  }
  if (meta.request_type !== undefined && meta.request_type !== 'approval_request') return undefined
  const named = [meta.tool_name, meta.tool_title]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim().toLowerCase())
  if (named.length === 0 || new Set(named).size !== 1) return undefined
  const operation = named[0]!
  if (!/^[a-z][a-z0-9_]{0,127}$/u.test(operation)) return undefined
  if (!isPlainObject(meta.tool_params)) return undefined
  const repository = repositoryFromConnectorParams(meta.tool_params)
  // Connector standing grants never infer a repository from cwd. A project/session policy must be bound
  // to the exact repository named in the signed provider request.
  if (!repository) return undefined
  const base = {
    transport: 'mcp' as const,
    operation: `GitHub connector ${operation}`,
    repository,
    parameterSummary: connectorParameterSummary(meta.tool_params, repository),
  }
  if (operation === 'merge_pull_request') return { ...base, capability: 'pull_request_merges' }
  if (CONNECTOR_PULL_REQUEST_OPERATIONS.has(operation)) return { ...base, capability: 'pull_requests' }
  if (CONNECTOR_WORKFLOW_OPERATIONS.has(operation)) return { ...base, capability: 'workflow_runs' }
  if (CONNECTOR_REPOSITORY_PUSH_OPERATIONS.has(operation)) return { ...base, capability: 'repository_pushes' }
  return undefined
}

/**
 * Recognize a bounded GitHub operation. Unknown tools/verbs and any composed shell request ask the operator.
 * `gh api`, auth/secrets/config/repository administration, release deletion, and force/delete pushes are
 * intentionally outside this grammar.
 */
export function classifyGitHubAutomationApproval(
  kind: string,
  payload: unknown,
): GitHubAutomationApproval | undefined {
  const p = payload as { toolName?: unknown; matchedAskRule?: unknown } | null
  if (!p || p.matchedAskRule) return undefined
  if (kind === 'claude/tool') {
    if (p.toolName === 'Bash') {
      const tokens = commandTokens(payload)
      return tokens ? (classifyGh(tokens) ?? classifyGitPush(tokens)) : undefined
    }
    return classifyMcp(payload)
  }
  if (
    kind === 'codex/item/commandExecution/requestApproval' ||
    kind === 'codex/execCommandApproval'
  ) {
    const tokens = commandTokens(payload)
    return tokens ? (classifyGh(tokens) ?? classifyGitPush(tokens)) : undefined
  }
  if (kind === 'codex/mcpServer/elicitation/request') {
    return classifyCodexConnectorElicitation(payload)
  }
  return undefined
}

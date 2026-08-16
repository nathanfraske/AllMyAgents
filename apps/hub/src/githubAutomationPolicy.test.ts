import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import {
  classifyGitHubAutomationApproval,
  GitHubAutomationPolicyStore,
} from './githubAutomationPolicy.js'

const databases: Database.Database[] = []
afterEach(() => {
  while (databases.length) databases.pop()?.close()
})
describe('GitHubAutomationPolicyStore', () => {
  it('survives reconstruction and revokes with an explicit empty capability list', () => {
    const db = new Database(':memory:')
    databases.push(db)
    new GitHubAutomationPolicyStore(db).set('project', 'p1', ['pull_requests', 'workflow_runs'])

    const restored = new GitHubAutomationPolicyStore(db)
    expect(restored.get('project', 'p1')).toMatchObject({
      scope: 'project', targetId: 'p1', capabilities: ['pull_requests', 'workflow_runs'],
    })
    restored.set('project', 'p1', [])
    expect(new GitHubAutomationPolicyStore(db).get('project', 'p1').capabilities).toEqual([])
  })

  it('fails closed for a malformed or future capability row instead of partially honoring it', () => {
    const db = new Database(':memory:')
    databases.push(db)
    const store = new GitHubAutomationPolicyStore(db)
    db.prepare(
      `INSERT INTO github_automation_policy (scope, targetId, capabilities, updatedAt)
       VALUES ('session', 's1', ?, '2026-08-05T00:00:00.000Z')`,
    ).run(JSON.stringify(['pull_requests', 'future_repository_admin']))
    expect(store.get('session', 's1').capabilities).toEqual([])
  })
})

describe('GitHub automation approval classifier', () => {
  it('recognizes one bounded command and rejects shell composition and executable paths', () => {
    expect(classifyGitHubAutomationApproval('claude/tool', {
      toolName: 'Bash', input: { command: 'gh run rerun 123' },
    })).toMatchObject({ capability: 'workflow_runs', operation: 'gh run rerun' })
    expect(classifyGitHubAutomationApproval('claude/tool', {
      toolName: 'Bash', input: { command: 'gh run rerun 123; gh repo delete acme/widget' },
    })).toBeUndefined()
    expect(classifyGitHubAutomationApproval('claude/tool', {
      toolName: 'Bash', input: { command: './gh pr view 42' },
    })).toBeUndefined()
  })

  const connector = (operation: string, params: Record<string, unknown>, overrides: Record<string, unknown> = {}) => ({
    serverName: 'codex_apps',
    mode: 'form',
    requestedSchema: { type: 'object', properties: {} },
    _meta: {
      source: 'connector',
      connector_name: 'GitHub',
      codex_approval_kind: 'mcp_tool_call',
      tool_title: operation,
      tool_params: params,
    },
    ...overrides,
  })

  it('maps exact Codex GitHub connector operations to the narrow granted capability', () => {
    expect(classifyGitHubAutomationApproval(
      'codex/mcpServer/elicitation/request',
      connector('update_pull_request', {
        repository_full_name: 'OpenAI/Codex', pr_number: 31, body: 'new body',
      }),
    )).toMatchObject({
      capability: 'pull_requests',
      transport: 'mcp',
      repository: 'openai/codex',
      parameterSummary: {
        repository: 'openai/codex',
        pr_number: 31,
        body: { chars: 8, sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) },
      },
    })
    expect(classifyGitHubAutomationApproval(
      'codex/mcpServer/elicitation/request',
      connector('merge_pull_request', { repository_full_name: 'openai/codex', pr_number: 31 }),
    )).toMatchObject({ capability: 'pull_request_merges' })
    expect(classifyGitHubAutomationApproval(
      'codex/mcpServer/elicitation/request',
      connector('run_workflow', { repo_full_name: 'openai/codex', workflow_id: 'ci.yml' }),
    )).toMatchObject({ capability: 'workflow_runs' })
  })

  it('fails closed for generic forms, other connectors, ambiguous repositories, and unknown operations', () => {
    expect(classifyGitHubAutomationApproval('codex/mcpServer/elicitation/request', {
      serverName: 'codex_apps', mode: 'form', requestedSchema: { type: 'object', properties: {} },
      _meta: { source: 'connector', connector_name: 'GitHub', codex_approval_kind: 'question' },
    })).toBeUndefined()
    expect(classifyGitHubAutomationApproval(
      'codex/mcpServer/elicitation/request',
      connector('update_pull_request', { repository_full_name: 'openai/codex' }, {
        _meta: {
          source: 'connector', connector_name: 'Linear', codex_approval_kind: 'mcp_tool_call',
          tool_title: 'update_pull_request', tool_params: { repository_full_name: 'openai/codex' },
        },
      }),
    )).toBeUndefined()
    expect(classifyGitHubAutomationApproval(
      'codex/mcpServer/elicitation/request',
      connector('update_pull_request', {
        repository_full_name: 'openai/codex', repo_full_name: 'attacker/elsewhere',
      }),
    )).toBeUndefined()
    expect(classifyGitHubAutomationApproval(
      'codex/mcpServer/elicitation/request',
      connector('delete_repository', { repository_full_name: 'openai/codex' }),
    )).toBeUndefined()
  })
})

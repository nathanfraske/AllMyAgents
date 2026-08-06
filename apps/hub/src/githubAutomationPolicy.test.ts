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
})

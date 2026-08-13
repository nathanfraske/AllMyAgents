import { describe, expect, it } from 'vitest'
import {
  managerCapabilityForTool,
  managerGrantWithinCeiling,
  managerToolGrantCovers,
  narrowManagerToolGrants,
  normalizeManagerToolGrants,
} from './managerCapabilities.js'

describe('manager semantic capabilities', () => {
  it('gives Claude and Codex equivalent shell and write grants', () => {
    const grants = normalizeManagerToolGrants(['Bash', 'Edit'])
    expect(grants).toEqual(['shell', 'file_write'])
    expect(managerToolGrantCovers(grants, 'Bash')).toBe(true)
    expect(managerToolGrantCovers(grants, 'PowerShell')).toBe(true)
    expect(managerToolGrantCovers(grants, 'commandExecution')).toBe(true)
    expect(managerToolGrantCovers(grants, 'Edit')).toBe(true)
    expect(managerToolGrantCovers(grants, 'Write')).toBe(true)
    expect(managerToolGrantCovers(grants, 'fileChange')).toBe(true)
  })

  it('maps browser and durable-run MCP names while preserving unknown exact tools', () => {
    expect(managerCapabilityForTool('mcp__allmyagents__start_run')).toBe('runs')
    expect(managerCapabilityForTool('browser_navigate')).toBe('browser')
    expect(normalizeManagerToolGrants(['mcp__github__create_issue'])).toEqual(['mcp__github__create_issue'])
    expect(managerToolGrantCovers(['mcp__github__create_issue'], 'mcp__github__create_issue')).toBe(true)
    expect(managerToolGrantCovers(['mcp__github__create_issue'], 'mcp__github__merge_pull_request')).toBe(false)
  })

  it('uses semantic containment for delegation and narrowing', () => {
    expect(managerGrantWithinCeiling('commandExecution', ['Bash'])).toBe(true)
    expect(managerGrantWithinCeiling('fileChange', ['file_write'])).toBe(true)
    expect(narrowManagerToolGrants(['Bash', 'Edit', 'WebFetch'], ['shell', 'web'])).toEqual({
      kept: ['shell', 'web'],
      revoked: ['file_write'],
    })
  })
})

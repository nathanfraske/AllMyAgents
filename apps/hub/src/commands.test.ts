import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { commandDescription, readProfileCommands } from './commands.js'

describe('commandDescription', () => {
  it('prefers the frontmatter description key', () => {
    const raw = ['---', 'allowed-tools: Bash(git:*)', 'description: Create a git commit', '---', '', '## Context'].join('\n')
    expect(commandDescription(raw)).toBe('Create a git commit')
  })

  it('unquotes a quoted frontmatter description', () => {
    expect(commandDescription('---\ndescription: "Ping the agent"\n---\nbody')).toBe('Ping the agent')
    expect(commandDescription("---\ndescription: 'Ping'\n---\nbody")).toBe('Ping')
  })

  it('falls back to the first content line when there is no frontmatter, stripping heading marks', () => {
    expect(commandDescription('# Reticulate splines\n\nmore text')).toBe('Reticulate splines')
    expect(commandDescription('\n\nplain first line\nsecond')).toBe('plain first line')
  })

  it('skips the frontmatter block and uses the first body line when no description key is present', () => {
    const raw = ['---', 'allowed-tools: Bash', '---', '', '## Do the thing', 'detail'].join('\n')
    expect(commandDescription(raw)).toBe('Do the thing')
  })

  it('returns empty string for an empty / metadata-only file', () => {
    expect(commandDescription('')).toBe('')
    expect(commandDescription('---\nallowed-tools: Bash\n---\n')).toBe('')
  })

  it('truncates an overlong description', () => {
    const long = 'x'.repeat(200)
    const out = commandDescription(long)
    expect(out.length).toBeLessThanOrEqual(120)
    expect(out.endsWith('…')).toBe(true)
  })
})

describe('readProfileCommands', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-cmds-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function write(rel: string, content: string): void {
    const full = path.join(dir, 'commands', rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content)
  }

  it('returns [] when the profile has no commands directory', () => {
    expect(readProfileCommands(dir)).toEqual([])
  })

  it('lists top-level *.md commands with parsed descriptions, sorted by name', () => {
    write('ping.md', '---\ndescription: says pong\n---\nrun')
    write('deploy.md', '# Deploy the app\n')
    const cmds = readProfileCommands(dir)
    expect(cmds.map((c) => c.name)).toEqual(['deploy', 'ping'])
    expect(cmds.find((c) => c.name === 'ping')?.description).toBe('says pong')
    expect(cmds.find((c) => c.name === 'deploy')?.description).toBe('Deploy the app')
  })

  it('namespaces subdirectory commands with a colon (Claude Code convention)', () => {
    write('git/commit.md', '---\ndescription: commit staged\n---')
    const cmds = readProfileCommands(dir)
    expect(cmds.map((c) => c.name)).toContain('git:commit')
  })

  it('ignores non-markdown files', () => {
    write('ping.md', 'x')
    write('README.txt', 'not a command')
    write('notes.json', '{}')
    expect(readProfileCommands(dir).map((c) => c.name)).toEqual(['ping'])
  })
})

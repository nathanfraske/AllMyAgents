import { describe, expect, it } from 'vitest'
import { basename, stripShellWrapper, toolBlurb, truncateMiddle } from './toolBlurb'
import type { ThreadItem } from './store.svelte'

// New module → "passes against old code too" is hollow (there is no old code). Each assertion below was
// confirmed to FAIL under a deliberate mutation of the function it covers (documented in the report),
// so it discriminates behaviour rather than merely exercising it.

let n = 0
function tool(toolName: string, toolInput: unknown): ThreadItem {
  return { key: `k${n++}`, kind: 'tool', ts: '2026-07-26T00:00:00.000Z', toolName, toolInput }
}

describe('basename', () => {
  it('takes the last segment for either separator', () => {
    expect(basename('/a/b/c.ts')).toBe('c.ts')
    expect(basename('C:\\x\\y\\z.svelte')).toBe('z.svelte')
    expect(basename('bare.txt')).toBe('bare.txt')
  })
  it('ignores a trailing slash', () => {
    expect(basename('/a/b/')).toBe('b')
  })
})

describe('truncateMiddle', () => {
  it('keeps both ends and drops the middle', () => {
    const out = truncateMiddle('abcdefghijklmnopqrstuvwxyz', 11)
    expect(out).toBe('abcde…vwxyz')
    expect(out.length).toBe(11)
  })
  it('leaves short strings alone', () => {
    expect(truncateMiddle('short', 48)).toBe('short')
  })
})

describe('toolBlurb — Claude tools', () => {
  it('reads a file by BASENAME, with the full path on hover', () => {
    const b = toolBlurb(tool('Read', { file_path: '/Users/x/proj/apps/web/src/lib/ThreadView.svelte' }))
    expect(b?.label).toBe('ThreadView.svelte')
    expect(b?.title).toBe('/Users/x/proj/apps/web/src/lib/ThreadView.svelte')
  })

  it('uses the notebook_path spelling for NotebookEdit (not file_path)', () => {
    // The load-bearing distinction: a NotebookEdit carries notebook_path, never file_path.
    const b = toolBlurb(tool('NotebookEdit', { notebook_path: '/nb/explore.ipynb' }))
    expect(b?.label).toBe('explore.ipynb')
  })

  it('prefers Bash description over the raw command, keeping the command as the hover', () => {
    const b = toolBlurb(tool('Bash', { command: 'pnpm --filter web test -- --run', description: 'Run web tests' }))
    expect(b?.label).toBe('Run web tests')
    expect(b?.title).toBe('pnpm --filter web test -- --run')
  })

  it('falls back to a trimmed command when Bash has no description, never a 400-char one-liner', () => {
    const long = 'echo ' + 'x'.repeat(400)
    const b = toolBlurb(tool('Bash', { command: long }))
    expect(b?.label.length).toBeLessThanOrEqual(80)
    expect(b?.label.endsWith('…')).toBe(true)
    expect(b?.title).toBe(long) // full command still available on hover
  })

  it('shows a search pattern and where it looks', () => {
    expect(toolBlurb(tool('Grep', { pattern: 'TODO', path: 'apps/web/src' }))?.label).toBe('TODO in src')
    expect(toolBlurb(tool('Glob', { pattern: '**/*.svelte' }))?.label).toBe('**/*.svelte')
  })

  it('handles url / query tools', () => {
    expect(toolBlurb(tool('WebFetch', { url: 'https://example.com/x' }))?.label).toBe('https://example.com/x')
    expect(toolBlurb(tool('WebSearch', { query: 'svelte 5 runes' }))?.label).toBe('svelte 5 runes')
  })

  it('degrades to undefined for an unknown tool shape — caller shows the plain name', () => {
    expect(toolBlurb(tool('TodoWrite', { todos: [] }))).toBeUndefined()
    expect(toolBlurb(tool('MysteryFutureTool', { wat: 1 }))).toBeUndefined()
    expect(toolBlurb(tool('Read', {}))).toBeUndefined() // no file_path → no blurb, not "undefined"
  })
})

describe('stripShellWrapper', () => {
  it('unwraps the real Windows powershell form Codex actually emits', () => {
    // Exactly what the sandbox showed: the launcher path buried the real command.
    expect(
      stripShellWrapper('"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command ls')
    ).toBe('ls')
    expect(
      stripShellWrapper(`"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command 'cat package.json'`)
    ).toBe('cat package.json')
  })
  it('unwraps cmd /c and sh/bash -c', () => {
    expect(stripShellWrapper('cmd.exe /c dir')).toBe('dir')
    expect(stripShellWrapper('/bin/bash -lc "echo hi"')).toBe('echo hi')
    expect(stripShellWrapper('sh -c ls')).toBe('ls')
  })
  it('leaves a bare command untouched', () => {
    expect(stripShellWrapper('npm run build')).toBe('npm run build')
    expect(stripShellWrapper('git commit -m "powershell is fine mid-string"')).toBe(
      'git commit -m "powershell is fine mid-string"'
    )
  })
})

describe('toolBlurb — Codex tools', () => {
  it('reads a Codex command from a string, an argv array, or a { command } object', () => {
    expect(toolBlurb(tool('command', 'npm run build'))?.label).toBe('npm run build')
    expect(toolBlurb(tool('command', ['git', 'status']))?.label).toBe('git status')
    expect(toolBlurb(tool('command', { command: 'ls -la' }))?.label).toBe('ls -la')
  })

  it('unwraps the powershell launcher for the label but keeps the full command on hover', () => {
    const raw = '"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command ls'
    const b = toolBlurb(tool('command', raw))
    expect(b?.label).toBe('ls')
    expect(b?.title).toBe(raw)
  })

  it('labels a Codex fileChange by basename', () => {
    const b = toolBlurb(tool('fileChange', { path: 'apps/web/src/lib/store.svelte.ts' }))
    expect(b?.label).toBe('edit store.svelte.ts')
    expect(b?.title).toBe('apps/web/src/lib/store.svelte.ts')
  })

  it('lets an mcp:* tool fall back to its own name (the name is the subject)', () => {
    expect(toolBlurb(tool('mcp:search', { q: 'x' }))).toBeUndefined()
  })
})

describe('toolBlurb — non-tool items', () => {
  it('is undefined for anything that is not a tool call', () => {
    expect(toolBlurb({ key: 'a', kind: 'assistant', ts: '', text: 'hi' })).toBeUndefined()
    expect(toolBlurb({ key: 'r', kind: 'reasoning', ts: '', text: 'thinking' })).toBeUndefined()
  })
})

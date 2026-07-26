import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { checkWriteScope } from './writeScope.js'

/**
 * REGRESSION — NotebookEdit escaped the worktree boundary entirely.
 *
 * The guard enumerated NotebookEdit as a write tool but read `input.file_path`, while the SDK's schema
 * (sdk-tools.d.ts NotebookEditInput) names the field `notebook_path` and documents it as absolute. Reading
 * the wrong field does not fail loudly: it yields `undefined`, and the old code treated "no path" as
 * "nothing to check, allow". So a session advertising worktree isolation would happily write a notebook
 * anywhere on disk — in BOTH the in-process and worker executors, which each carried their own copy.
 *
 * Hence two properties are asserted here: the right field per tool, and FAIL CLOSED when a recognised
 * write tool's path cannot be read at all.
 */

const WT = path.resolve('/tmp/ama-wt')
const spec = { worktree: WT, cwd: WT }

describe('checkWriteScope', () => {
  it('denies a NotebookEdit whose notebook_path is outside the worktree', () => {
    const outside = path.resolve('/tmp/elsewhere/victim.ipynb')
    expect(checkWriteScope(spec, 'NotebookEdit', { notebook_path: outside })).toMatch(/outside/)
  })

  it('allows a NotebookEdit inside the worktree', () => {
    expect(checkWriteScope(spec, 'NotebookEdit', { notebook_path: path.join(WT, 'nb.ipynb') })).toBeUndefined()
  })

  it('denies a Write outside and allows one inside', () => {
    expect(checkWriteScope(spec, 'Write', { file_path: path.resolve('/tmp/elsewhere/x.ts') })).toMatch(/outside/)
    expect(checkWriteScope(spec, 'Write', { file_path: path.join(WT, 'x.ts') })).toBeUndefined()
  })

  it('resolves a relative path against the session cwd', () => {
    expect(checkWriteScope(spec, 'Edit', { file_path: 'src/x.ts' })).toBeUndefined()
    expect(checkWriteScope(spec, 'Edit', { file_path: '../escape/x.ts' })).toMatch(/outside/)
  })

  /** "I could not tell where this writes" is not a reason to permit it — that is the NotebookEdit bug. */
  it('fails CLOSED when a recognised write tool has no usable path', () => {
    expect(checkWriteScope(spec, 'NotebookEdit', { file_path: path.join(WT, 'nb.ipynb') })).toMatch(/notebook_path/)
    expect(checkWriteScope(spec, 'Write', {})).toMatch(/file_path/)
    expect(checkWriteScope(spec, 'Write', { file_path: 42 })).toMatch(/file_path/)
    expect(checkWriteScope(spec, 'Write', null)).toMatch(/file_path/)
  })

  it('ignores tools that do not write, and sessions with no worktree', () => {
    expect(checkWriteScope(spec, 'Bash', { command: 'ls /' })).toBeUndefined()
    expect(checkWriteScope(spec, 'Read', { file_path: '/etc/passwd' })).toBeUndefined()
    expect(checkWriteScope({ worktree: undefined, cwd: WT }, 'Write', { file_path: '/anywhere' })).toBeUndefined()
  })

  /** A sibling directory sharing the root's name prefix is NOT inside it. */
  it('does not treat a name-prefix sibling as inside the worktree', () => {
    expect(checkWriteScope(spec, 'Write', { file_path: `${WT}-evil/x.ts` })).toMatch(/outside/)
  })
})

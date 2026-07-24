import fs from 'node:fs'
import path from 'node:path'

export const repoRoot = path.resolve(import.meta.dirname, '..', '..')

const journalDir = path.join(repoRoot, 'journal')
fs.mkdirSync(journalDir, { recursive: true })

export function resolveFromRoot(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(repoRoot, p)
}

export function appendEvent(stream: string, event: unknown): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), event })
  fs.appendFileSync(path.join(journalDir, `${stream}.jsonl`), line + '\n')
}

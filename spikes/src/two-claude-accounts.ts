import fs from 'node:fs'
import path from 'node:path'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { appendEvent, resolveFromRoot } from './journal.js'

const dirA = resolveFromRoot(process.argv[2] ?? 'profiles/claude-a')
const dirB = resolveFromRoot(process.argv[3] ?? 'profiles/claude-b')

for (const dir of [dirA, dirB]) {
  if (!fs.existsSync(path.join(dir, '.credentials.json'))) {
    console.warn(`[warn] no .credentials.json in ${dir} — if the session fails auth, run: pnpm login:claude ${dir}`)
  }
}

async function run(label: string, configDir: string): Promise<string | undefined> {
  const env = { ...process.env, CLAUDE_CONFIG_DIR: configDir } as Record<string, string>
  let sessionId: string | undefined
  const session = query({
    prompt: `Reply with exactly: hello from account ${label}. Do not use any tools.`,
    options: { env, maxTurns: 1 },
  })
  for await (const message of session) {
    appendEvent(`two-accounts-${label}`, message)
    const m = message as Record<string, unknown> & { type: string }
    if (m.type === 'assistant') {
      const inner = m.message as { content?: unknown } | undefined
      console.log(`[${label}] assistant:`, JSON.stringify(inner?.content))
    } else if (m.type === 'result') {
      sessionId = m.session_id as string | undefined
      console.log(`[${label}] result: session=${sessionId} error=${m.is_error}`)
    } else {
      console.log(`[${label}] ${m.type}`)
    }
  }
  return sessionId
}

console.log(`[two-accounts] A=${dirA}`)
console.log(`[two-accounts] B=${dirB}`)
console.log('[two-accounts] launching both sessions concurrently…')
const started = Date.now()
const [a, b] = await Promise.all([run('A', dirA), run('B', dirB)])
console.log(`[two-accounts] done in ${((Date.now() - started) / 1000).toFixed(1)}s — sessions A=${a} B=${b}`)
console.log('[two-accounts] interleaved [A]/[B] lines above prove concurrent sessions from two isolated config dirs')

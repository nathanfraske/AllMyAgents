import { query } from '@anthropic-ai/claude-agent-sdk'
import { appendEvent, resolveFromRoot } from './journal.js'

const profileDir = process.argv[2] ? resolveFromRoot(process.argv[2]) : undefined
const env = { ...process.env } as Record<string, string>
if (profileDir) env.CLAUDE_CONFIG_DIR = profileDir

console.log(`[claude-min] one session, config dir: ${profileDir ?? '(default ~/.claude)'}`)

try {
  const session = query({
    prompt: 'Reply with exactly: hub spike ok. Do not use any tools.',
    options: { env, maxTurns: 1 },
  })
  for await (const message of session) {
    appendEvent('claude-min', message)
    const m = message as Record<string, unknown> & { type: string }
    if (m.type === 'assistant') {
      const inner = m.message as { content?: unknown } | undefined
      console.log('[assistant]', JSON.stringify(inner?.content))
    } else if (m.type === 'result') {
      console.log('[result]', JSON.stringify({ session_id: m.session_id, is_error: m.is_error, result: m.result }))
    } else {
      console.log(`[${m.type}]`)
    }
  }
  console.log('[claude-min] done — events in journal/claude-min.jsonl')
} catch (err) {
  console.error('[claude-min] failed:', err instanceof Error ? err.message : err)
  console.error('If this is an auth error: pnpm login:claude profiles/claude-a, then retry as: pnpm spike:claude profiles/claude-a')
  process.exitCode = 1
}

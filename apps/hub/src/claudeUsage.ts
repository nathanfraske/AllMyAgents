import { query } from '@anthropic-ai/claude-agent-sdk'

export interface ClaudeUsageLine {
  label: string
  percent: number
  resets: string
}

// Matches lines like: "Current session: 71% used · resets Jul 23, 6:59pm (America/Chicago)"
const LINE = /^(Current [^:]+):\s*(\d+)%\s*used\s*·\s*resets\s*(.+)$/gm

export function parseClaudeUsage(text: string): ClaudeUsageLine[] {
  const out: ClaudeUsageLine[] = []
  LINE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = LINE.exec(text)) !== null) {
    out.push({ label: (m[1] as string).trim(), percent: Number(m[2]), resets: (m[3] as string).trim() })
  }
  return out
}

// Runs `/usage` in an ephemeral headless turn under the given config dir and parses the dashboard text.
export async function readClaudeUsage(profileDir: string): Promise<ClaudeUsageLine[]> {
  const env = { ...process.env, CLAUDE_CONFIG_DIR: profileDir } as Record<string, string>
  let text = ''
  const q = query({ prompt: '/usage', options: { env, maxTurns: 1 } as never })
  for await (const message of q) {
    const m = message as { type: string; result?: string }
    if (m.type === 'result' && typeof m.result === 'string') text += '\n' + m.result
  }
  return parseClaudeUsage(text)
}

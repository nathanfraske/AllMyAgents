import { query } from '@anthropic-ai/claude-agent-sdk'

export interface ClaudeUsageLine {
  label: string
  percent: number
  resets: string
  resetsAt?: number
}

// Matches lines like: "Current session: 71% used · resets Jul 23, 6:59pm (America/Chicago)"
const LINE = /^(Current [^:]+):\s*(\d+)%\s*used\s*·\s*resets\s*(.+)$/gm

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
}

// "Jul 30, 1:59pm (America/Chicago)" -> unix seconds. Parsed in the hub's local tz,
// which matches the tz shown by /usage. Wraps to next year if the date already passed.
export function parseResetDate(s: string): number | undefined {
  const m = /([A-Za-z]{3})\s+(\d{1,2}),\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(s)
  if (!m) return undefined
  const mon = MONTHS[(m[1] as string).toLowerCase()]
  if (mon === undefined) return undefined
  const day = Number(m[2])
  let hour = Number(m[3]) % 12
  if (/pm/i.test(m[5] as string)) hour += 12
  const min = m[4] ? Number(m[4]) : 0
  const now = new Date()
  let d = new Date(now.getFullYear(), mon, day, hour, min, 0)
  if (d.getTime() < now.getTime() - 2 * 86_400_000) {
    d = new Date(now.getFullYear() + 1, mon, day, hour, min, 0)
  }
  return Math.floor(d.getTime() / 1000)
}

export function parseClaudeUsage(text: string): ClaudeUsageLine[] {
  const out: ClaudeUsageLine[] = []
  LINE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = LINE.exec(text)) !== null) {
    const resets = (m[3] as string).trim()
    out.push({ label: (m[1] as string).trim(), percent: Number(m[2]), resets, resetsAt: parseResetDate(resets) })
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

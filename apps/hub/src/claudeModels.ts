import { query } from '@anthropic-ai/claude-agent-sdk'
import { modelCatalogDeadline } from './modelCatalog.js'
import type { ProfileAvailableModel } from './types.js'

/** SDK control-plane discovery with an open, EMPTY input stream: not a billable prompt or /model turn. */
export async function readClaudeModels(profileDir: string): Promise<ProfileAvailableModel[]> {
  let finish!: () => void
  const stopped = new Promise<void>(resolve => { finish = resolve })
  async function* emptyInput(): AsyncGenerator<never> { await stopped }
  const q = query({ prompt: emptyInput(), options: {
    env: { ...process.env, CLAUDE_CONFIG_DIR: profileDir },
    cwd: profileDir,
    persistSession: false,
    tools: [],
    mcpServers: {},
    strictMcpConfig: true,
    settingSources: [],
  } })
  try {
    const rows = await modelCatalogDeadline(q.supportedModels())
    if (!Array.isArray(rows) || rows.length > 200) throw new Error('Invalid Claude model catalog')
    const seen = new Set<string>()
    return rows.flatMap(row => {
      const slug = (row.resolvedModel || row.value)?.trim()
      if (!slug || slug.length > 160 || seen.has(slug)) return []
      seen.add(slug)
      return [{ slug, name: (row.displayName || slug).slice(0, 160), description: row.description?.slice(0, 500),
        // Our Claude adapter exposes thinking keywords, not Codex reasoning-effort wire values.
        supportedEfforts: [], serviceTiers: [],
      }]
    })
  } finally { finish(); q.close() }
}

import { describe, expect, it } from 'vitest'
import { AUTO_ALLOW_TOOLS, SELF_GATING_TOOLS } from './executor.js'

const PREFIX = 'mcp__allmyagents__'

describe('Agent Browser permission classification', () => {
  it('uses a closed exact-name registry with one meaningful prompt per mutating action', () => {
    expect([...SELF_GATING_TOOLS].filter((name) => name.includes('browser'))).toEqual([
      `${PREFIX}browser_navigate`,
      `${PREFIX}browser_click`,
      `${PREFIX}browser_open_tab`,
      `${PREFIX}browser_download`,
    ])
    expect([...AUTO_ALLOW_TOOLS].filter((name) => name.includes('browser'))).toEqual([
      `${PREFIX}browser_read_page`,
      `${PREFIX}browser_tabs`,
      `${PREFIX}browser_switch_tab`,
      `${PREFIX}browser_close_tab`,
      `${PREFIX}browser_download_read`,
      `${PREFIX}browser_screenshot`,
      `${PREFIX}browser_status`,
    ])
    expect([...AUTO_ALLOW_TOOLS, ...SELF_GATING_TOOLS]).not.toContain(`${PREFIX}browser_*`)
  })

  it('keeps every exported browser tool deliberately classified with no overlap', async () => {
    const { AGENT_TOOLS } = await import('./agentToolCore.js')
    const browserNames = AGENT_TOOLS
      .map((tool) => `${PREFIX}${tool.name}`)
      .filter((name) => name.includes('browser'))
    for (const name of browserNames) {
      const classifications = Number(AUTO_ALLOW_TOOLS.has(name)) + Number(SELF_GATING_TOOLS.has(name))
      expect(classifications, name).toBe(1)
    }
  })
})

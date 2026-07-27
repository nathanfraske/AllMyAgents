import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const src = join(process.cwd(), 'src')
const thread = readFileSync(join(src, 'lib', 'ThreadView.svelte'), 'utf8')
const panel = readFileSync(join(src, 'lib', 'AgentPanel.svelte'), 'utf8')
const app = readFileSync(join(src, 'App.svelte'), 'utf8')

describe('narrow-pane layout contracts', () => {
  it('wraps the complete composer footer and has a labelled icon-only fallback', () => {
    expect(thread).toMatch(/\.cfoot\s*\{[^}]*flex-wrap:\s*wrap/s)
    expect(thread).toMatch(/container-name:\s*composer-footer/)
    expect(thread).toMatch(/@container\s+composer-footer\s*\(max-width:/)
    expect(thread).toMatch(/class="ccontrol[^"]*"\s+title=/)
  })

  it('keeps the open agent panel in flow beside the conversation and stacks it in narrow panes', () => {
    expect(thread).toMatch(/class="thread-body"/)
    expect(thread).toMatch(/class="conversation"/)
    expect(panel).not.toMatch(/\.panel\s*\{[^}]*position:\s*absolute/s)
    expect(panel).toMatch(/@container\s+thread-body\s*\(max-width:/)
  })

  it('makes each existing pane a labelled drag source without changing the ghost animation path', () => {
    expect(app).toMatch(/class="pane"[^>]*draggable="true"/)
    expect(app).toMatch(/ondragstart=\{\(e\)\s*=>\s*startPaneDrag\(id,\s*e\)\}/)
    expect(app).toMatch(/\{#each row as id,\s*c \(id\)\}/)
    expect(app).toMatch(/Animate ONLY opacity \+ scale/)
    expect(app).not.toMatch(/ghostReveal[\s\S]{0,900}flex-grow:/)
  })
})

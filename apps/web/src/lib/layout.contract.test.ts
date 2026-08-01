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

  it('wires bounded auto-grow onto the existing multiline composer without replacing its controls', () => {
    expect(thread).toMatch(/import\s+\{\s*composerAutoGrow\s*\}\s+from\s+'\.\/composerAutoGrow'/)
    expect(thread).toMatch(/<textarea[^>]*rows="2"[^>]*aria-label=\{composerLabel\}[^>]*use:composerAutoGrow=\{text\}[^>]*onkeydown=\{onKey\}/s)
    expect(thread).toMatch(/\.composer textarea\s*\{[^}]*overflow-y:\s*hidden/s)
    expect(thread).toMatch(/<AttachmentPreview[\s\S]*<textarea[\s\S]*<div class="cfoot"/)
    expect(thread).toMatch(/e\.key === 'Enter' && !e\.shiftKey && !e\.isComposing/)
  })

  it('keeps the open agent panel in flow beside the conversation and stacks it in narrow panes', () => {
    expect(thread).toMatch(/class="thread-body"/)
    expect(thread).toMatch(/class="conversation"/)
    expect(panel).not.toMatch(/\.panel\s*\{[^}]*position:\s*absolute/s)
    expect(panel).toMatch(/@container\s+thread-body\s*\(max-width:/)
  })

  it('does not let the pending-approval card style inflate the approval status chip', () => {
    expect(thread).toMatch(/class="approval-card"/)
    expect(thread).not.toMatch(/^\s*\.approval\s*\{/m)
  })

  it('limits pane dragging to its labelled header without changing the ghost animation path', () => {
    expect(app).not.toMatch(/class="pane"[^>]*draggable=/)
    expect(thread).toMatch(/class="head"[\s\S]{0,400}draggable=\{multiPane\}/)
    expect(app).toMatch(/onpanedragstart=\{\(e\)\s*=>\s*startPaneDrag\(id,\s*e\)\}/)
    expect(app).toMatch(/\{#each row as id,\s*c \(id\)\}/)
    expect(app).toMatch(/Animate ONLY opacity \+ scale/)
    expect(app).not.toMatch(/ghostReveal[\s\S]{0,900}flex-grow:/)
  })

  it('keeps journal maintenance out of the full-width app banner lane', () => {
    expect(app).not.toMatch(/class="journal-maintenance"/)
  })
})

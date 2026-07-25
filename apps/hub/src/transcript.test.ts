import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { claudeRecordItems, codexRecordItems, readHistoryPage, locateTranscript } from './transcript.js'

describe('transcript record parsing', () => {
  it('Claude: string + block content, thinking, tool_use', () => {
    expect(claudeRecordItems({ type: 'user', message: { content: 'hello there' } })).toEqual([{ kind: 'user', text: 'hello there' }])
    const asst = claudeRecordItems({
      type: 'assistant',
      message: { content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'the answer' }, { type: 'tool_use', name: 'Grep', input: { q: 'x' }, id: 'tu_1' }] },
    })
    expect(asst.map((i) => i.kind)).toEqual(['reasoning', 'assistant', 'tool'])
    expect(asst[2]!.toolName).toBe('Grep')
  })

  it('Claude: synthetic/command user text is skipped', () => {
    expect(claudeRecordItems({ type: 'user', message: { content: '<command-name>/foo</command-name>' } })).toEqual([])
  })

  it('Codex: event_msg user/agent/reasoning + response_item tool call', () => {
    expect(codexRecordItems({ type: 'event_msg', payload: { type: 'user_message', message: 'do the thing' } })).toEqual([{ kind: 'user', text: 'do the thing' }])
    expect(codexRecordItems({ type: 'event_msg', payload: { type: 'agent_message', message: 'on it' } })).toEqual([{ kind: 'assistant', text: 'on it' }])
    expect(codexRecordItems({ type: 'event_msg', payload: { type: 'agent_reasoning', text: 'planning' } })).toEqual([{ kind: 'reasoning', text: 'planning' }])
    const call = codexRecordItems({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input: 'ls', call_id: 'c1' } })
    expect(call[0]!.kind).toBe('tool')
    expect(call[0]!.toolName).toBe('exec')
  })
})

describe('readHistoryPage (pairing, ts, bounded tail)', () => {
  let tmp: string
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-hist-'))
  })
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

  it('pairs a Codex tool call with its output and carries the real timestamp', async () => {
    const file = path.join(tmp, 'rollout.jsonl')
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ timestamp: '2026-07-18T20:00:00.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'run it' } }),
        JSON.stringify({ timestamp: '2026-07-18T20:00:01.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input: 'ls', call_id: 'c9' } }),
        JSON.stringify({ timestamp: '2026-07-18T20:00:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', output: 'a\nb', call_id: 'c9' } }),
        JSON.stringify({ timestamp: '2026-07-18T20:00:03.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'done' } }),
      ].join('\n')
    )
    const page = await readHistoryPage(file, 'codex')
    expect(page.items.map((i) => i.kind)).toEqual(['user', 'tool', 'assistant']) // output folded into the tool call
    const tool = page.items[1]!
    expect(tool.toolName).toBe('exec')
    expect(tool.toolResult).toBe('a\nb') // paired
    expect(page.items[0]!.ts).toBe('2026-07-18T20:00:00.000Z') // real message time, not import time
    expect(page.items.some((i) => (i.text ?? '').startsWith('__'))).toBe(false) // no placeholder leaks
  })

  it('bounds to the most-recent itemCap and flags older', async () => {
    const file = path.join(tmp, 'big.jsonl')
    const lines = Array.from({ length: 50 }, (_, n) =>
      JSON.stringify({ timestamp: '2026-07-18T20:00:00.000Z', type: 'event_msg', payload: { type: 'agent_message', message: `m${n}` } })
    )
    fs.writeFileSync(file, lines.join('\n'))
    const page = await readHistoryPage(file, 'codex', { itemCap: 10 })
    expect(page.items).toHaveLength(10)
    expect(page.items[page.items.length - 1]!.text).toBe('m49') // kept the newest
    expect(page.hasOlder).toBe(true)
  })

  it('locateTranscript finds a Claude transcript by session uuid', async () => {
    const home = path.join(tmp, '.claude')
    const proj = path.join(home, 'projects', 'C--Users-x-proj')
    fs.mkdirSync(proj, { recursive: true })
    const sid = '11111111-2222-3333-4444-555555555555'
    fs.writeFileSync(path.join(proj, `${sid}.jsonl`), '{}')
    expect(await locateTranscript(home, 'claude', sid)).toBe(path.join(proj, `${sid}.jsonl`))
    expect(await locateTranscript(home, 'claude', 'nope')).toBeUndefined()
  })
})

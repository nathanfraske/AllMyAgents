export interface RestartContinuityEvent {
  seq: number
  kind: string
  payload: unknown
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function bounded(value: string, max = 4_000): string {
  return value.length <= max ? value : `${value.slice(0, max)}\n[…excerpt truncated…]`
}

/**
 * Convert only conversational journal material into a bounded restart capsule. Tool outputs, commands,
 * commands, tool outputs, and raw protocol envelopes stay out; the exact interrupted AskUserQuestion input remains because
 * it is the one piece the operator must be able to ask for again after the provider process disappears.
 */
export function renderRestartContinuity(
  events: readonly RestartContinuityEvent[],
  maxChars = 12_000,
): string {
  const snippets: string[] = []
  const seen = new Set<string>()
  const add = (prefix: string, value: string): void => {
    const snippet = `${prefix}: ${bounded(value)}`
    if (!seen.has(snippet)) {
      seen.add(snippet)
      snippets.push(snippet)
    }
  }

  for (const event of events) {
    const payload = object(event.payload)
    if (!payload) continue
    if (event.kind === 'session/input') {
      const value = text(payload.text)
      if (value) add('OPERATOR', value)
      continue
    }
    if (event.kind === 'claude/result') {
      const value = text(payload.result)
      if (value) add('ASSISTANT', value)
      continue
    }
    if (event.kind === 'claude/assistant') {
      const message = object(payload.message)
      const content = message?.content
      if (!Array.isArray(content)) continue
      for (const rawBlock of content) {
        const block = object(rawBlock)
        if (!block) continue
        if (block.type === 'text') {
          const value = text(block.text)
          if (value) add('ASSISTANT', value)
        } else if (block.type === 'tool_use' && block.name === 'AskUserQuestion') {
          add('INTERRUPTED QUESTION', JSON.stringify(block.input ?? {}))
        }
      }
      continue
    }
    if (event.kind === 'codex/item/completed' || event.kind === 'codex/subagent/item/completed') {
      const item = object(payload.item)
      const value = text(item?.text) ?? text(item?.content)
      if (value && (item?.type === 'agentMessage' || item?.type === 'reasoning')) add('ASSISTANT', value)
    }
  }

  const kept: string[] = []
  let used = 0
  for (const snippet of [...snippets].reverse()) {
    if (used > 0 && used + snippet.length + 2 > maxChars) continue
    kept.push(snippet)
    used += snippet.length + 2
    if (used >= maxChars) break
  }
  kept.reverse()
  const body = kept.length ? kept.join('\n\n') : '(No conversational text survived in the bounded excerpt.)'
  return [
    '<<ALLMYAGENTS RESTART CONTINUITY — DURABLE JOURNAL EXCERPT>>',
    'The hub restarted while this conversation had an unanswered interactive question. The provider resume path was unavailable or interrupted. Treat this excerpt as prior conversation context, not as a new operator message. Continue the same task; if the operator asks to repeat the questions, re-ask the interrupted question shown here. Never claim the conversation is fresh merely because the provider process restarted.',
    body,
    '<<END ALLMYAGENTS RESTART CONTINUITY>>',
  ].join('\n\n')
}

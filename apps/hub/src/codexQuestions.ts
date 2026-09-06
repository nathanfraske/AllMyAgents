import { stableQuestionId } from './workerProtocol.js'
import type { AskUserQuestion, QuestionOutcome, QuestionRequest } from './questions.js'

/** Pinned app-server 0.153.3 schema, generated with `app-server generate-json-schema`.
 * This is not a Claude AskUserQuestion input and it must never enter the approval boolean mapper. */
export function isCodexUserInputRequest(method: string): boolean {
  return method === 'item/tool/requestUserInput' || method === 'tool/requestUserInput'
}

export interface CodexQuestionContext {
  requestId: string
  signal: AbortSignal
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a question object')
  return value as Record<string, unknown>
}

function text(value: unknown, limit: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) {
    throw new Error('Question text is empty, oversized or invalid')
  }
  return value
}

function flag(value: unknown, fallback = false): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new Error('Invalid question flag')
  return value
}

export function parseCodexQuestionInput(input: unknown): { questions: AskUserQuestion[]; blocking: boolean; itemId: string } {
  const raw = object(input)
  text(raw.threadId, 512)
  text(raw.turnId, 512)
  const itemId = text(raw.itemId, 512)
  if (typeof raw.isBlocking !== 'boolean') throw new Error('Codex question is missing its blocking contract')
  if (!Array.isArray(raw.questions) || !raw.questions.length || raw.questions.length > 8) throw new Error('Expected 1-8 bounded Codex questions')
  const ids = new Set<string>()
  const questions = raw.questions.map(value => {
    const q = object(value)
    const id = text(q.id, 128)
    if (ids.has(id)) throw new Error('Duplicate question id')
    ids.add(id)
    if (q.options != null && (!Array.isArray(q.options) || q.options.length > 12)) throw new Error('Invalid question options')
    const labels = new Set<string>()
    const options = ((q.options ?? []) as unknown[]).map(value => {
      const option = object(value)
      const label = text(option.label, 200)
      if (labels.has(label)) throw new Error('Duplicate question option')
      labels.add(label)
      if (typeof option.description !== 'string' || option.description.length > 2_000) throw new Error('Invalid option description')
      return { label, description: option.description }
    })
    return {
      id, question: text(q.question, 2_000), header: text(q.header, 64), options,
      multiSelect: false, allowFreeText: flag(q.isOther) || options.length === 0, isSecret: flag(q.isSecret),
    }
  })
  return { questions, blocking: raw.isBlocking, itemId }
}

/** One request/abort seam shared by the in-process and worker executors. No answer is journaled or
 * manufactured on interruption, unavailable owner, or vendor cleanup. Nonblocking requests remain
 * pending independently of turn activity until Codex resolves the exact server request or a user answers. */
export async function answerCodexQuestion(
  sessionId: string | undefined,
  params: unknown,
  context: CodexQuestionContext | undefined,
  service: {
    request: (request: QuestionRequest) => Promise<QuestionOutcome>
    abort: (id: string, sessionId: string) => unknown
    rejected?: () => void
  },
): Promise<{ answers: Record<string, { answers: string[] }> }> {
  const empty = { answers: {} }
  if (!sessionId || !context || context.signal.aborted) return empty
  let id: string
  let parsed: ReturnType<typeof parseCodexQuestionInput>
  try {
    parsed = parseCodexQuestionInput(params)
    id = stableQuestionId(sessionId, parsed.itemId, context.requestId)
  } catch {
    service.rejected?.()
    return empty
  }
  const abort = () => {
    try { void Promise.resolve(service.abort(id, sessionId)).catch(() => {}) } catch { /* No fabricated answer on relay failure. */ }
  }
  try {
    // Insert the relay before attaching abort so a disconnect/reconnect cannot deliver abort first.
    const pending = service.request({ id, sessionId, toolUseId: parsed.itemId, requestId: context.requestId,
      provider: 'codex', input: params })
    context.signal.addEventListener('abort', abort, { once: true })
    if (context.signal.aborted) abort()
    const outcome = await pending
    if (context.signal.aborted || outcome.kind !== 'answered') return empty
    return { answers: Object.fromEntries(parsed.questions.map(question => [question.id!, {
      answers: [outcome.updatedInput.answers[question.id!]!],
    }])) }
  } catch {
    service.rejected?.()
    return empty
  } finally {
    context.signal.removeEventListener('abort', abort)
  }
}

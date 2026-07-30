import crypto from 'node:crypto'
import type { Journal, ResolvedQuestion } from './journal.js'
import { stableQuestionId } from './workerProtocol.js'

const MAX_QUESTION_TEXT = 2_000
const MAX_HEADER = 12
const MAX_LABEL = 80
const MAX_DESCRIPTION = 2_000
const MAX_PREVIEW = 20_000
const MAX_ANSWER = 4_000
const MAX_CORRELATION = 512
export const MAX_PENDING_QUESTIONS_PER_SESSION = 4
export const MAX_PENDING_QUESTIONS_GLOBAL = 32

export interface AskUserQuestionOption {
  label: string
  description: string
  /** Never rendered as HTML by AllMyAgents. It is bounded, inert comparison text only. */
  preview?: string
}

export interface AskUserQuestion {
  question: string
  header: string
  options: AskUserQuestionOption[]
  multiSelect: boolean
}

export interface AskUserQuestionInput {
  questions: AskUserQuestion[]
}

export type QuestionAnswers = Record<string, string>

export type QuestionOutcome =
  | {
      kind: 'answered'
      updatedInput: {
        questions: AskUserQuestion[]
        answers: QuestionAnswers
      }
    }
  | {
      kind: 'cancelled'
      reason?: 'aborted' | 'recovery-unknown' | 'rejected' | 'unavailable'
      message?: string
    }

export type QuestionStatus = 'pending' | 'answered' | 'cancelled' | 'aborted'

export interface QuestionRecord {
  id: string
  sessionId: string
  toolUseId: string
  requestId: string
  questions: AskUserQuestion[]
  status: QuestionStatus
  createdAt: string
}

export interface QuestionRequest {
  id: string
  sessionId: string
  toolUseId: string
  requestId: string
  input: unknown
  signal?: AbortSignal
}

export interface WorkerQuestionRequest {
  questionId: string
  sessionId: string
  toolUseId: string
  requestId: string
  input: unknown
}

interface PendingEntry {
  record: QuestionRecord
  digest: string
  resolve: (outcome: QuestionOutcome) => void
  promise: Promise<QuestionOutcome>
  removeAbort?: () => void
}

export class QuestionInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'QuestionInputError'
  }
}

export type QuestionDecision =
  | { kind: 'cancel' }
  | { kind: 'answer'; answers: unknown }

/** Closed HTTP request-body shape. Inherited keys and ambiguous cancel/answer combinations fail closed. */
export function parseQuestionDecisionBody(value: unknown): QuestionDecision {
  const body = object(value, 'question response')
  const keys = Object.keys(body)
  if (keys.length === 1 && keys[0] === 'cancel' && body.cancel === true) {
    return { kind: 'cancel' }
  }
  if (keys.length === 1 && keys[0] === 'answers') {
    object(body.answers, 'answers')
    return { kind: 'answer', answers: body.answers }
  }
  throw new QuestionInputError('body must be exactly {cancel:true} or {answers:<object>}')
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new QuestionInputError(`${field} must be an object`)
  }
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key))
  if (extras.length) throw new QuestionInputError(`${field} has unsupported field: ${extras[0]}`)
}

function boundedString(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') {
    throw new QuestionInputError(`${field} must be a non-empty string`)
  }
  // A Unicode code point occupies at most two UTF-16 code units. Reject a wildly oversized vendor
  // value before spreading/iterating it so validation itself cannot allocate an attacker-sized array.
  if (value.length > max * 2) throw new QuestionInputError(`${field} exceeds ${max} characters`)
  if (value.trim().length === 0) {
    throw new QuestionInputError(`${field} must be a non-empty string`)
  }
  if ([...value].length > max) throw new QuestionInputError(`${field} exceeds ${max} characters`)
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw new QuestionInputError(`${field} contains control characters`)
  }
  return value
}

/** Strictly validate the pinned SDK 0.3.218 AskUserQuestion input. Unknown shapes fail closed. */
export function parseAskUserQuestionInput(value: unknown): AskUserQuestionInput {
  const root = object(value, 'AskUserQuestion input')
  exactKeys(root, ['questions'], 'AskUserQuestion input')
  if (!Array.isArray(root.questions) || root.questions.length < 1 || root.questions.length > 4) {
    throw new QuestionInputError('questions must contain 1-4 questions')
  }
  const seenQuestions = new Set<string>()
  const questions = root.questions.map((rawQuestion, questionIndex): AskUserQuestion => {
    const raw = object(rawQuestion, `questions[${questionIndex}]`)
    exactKeys(raw, ['question', 'header', 'options', 'multiSelect'], `questions[${questionIndex}]`)
    const question = boundedString(raw.question, `questions[${questionIndex}].question`, MAX_QUESTION_TEXT)
    if (seenQuestions.has(question)) throw new QuestionInputError('question text must be unique')
    seenQuestions.add(question)
    const header = boundedString(raw.header, `questions[${questionIndex}].header`, MAX_HEADER)
    if (typeof raw.multiSelect !== 'boolean') {
      throw new QuestionInputError(`questions[${questionIndex}].multiSelect must be boolean`)
    }
    if (!Array.isArray(raw.options) || raw.options.length < 2 || raw.options.length > 4) {
      throw new QuestionInputError(`questions[${questionIndex}].options must contain 2-4 options`)
    }
    const seenLabels = new Set<string>()
    const options = raw.options.map((rawOption, optionIndex): AskUserQuestionOption => {
      const option = object(rawOption, `questions[${questionIndex}].options[${optionIndex}]`)
      exactKeys(
        option,
        ['label', 'description', 'preview'],
        `questions[${questionIndex}].options[${optionIndex}]`
      )
      const label = boundedString(
        option.label,
        `questions[${questionIndex}].options[${optionIndex}].label`,
        MAX_LABEL
      )
      if (label.trim().toLowerCase() === 'other') {
        throw new QuestionInputError('Claude options must not include Other; the host adds it')
      }
      if (seenLabels.has(label)) throw new QuestionInputError('option labels must be unique within a question')
      seenLabels.add(label)
      const description = boundedString(
        option.description,
        `questions[${questionIndex}].options[${optionIndex}].description`,
        MAX_DESCRIPTION
      )
      const preview =
        option.preview === undefined
          ? undefined
          : boundedString(
              option.preview,
              `questions[${questionIndex}].options[${optionIndex}].preview`,
              MAX_PREVIEW
            )
      return preview === undefined ? { label, description } : { label, description, preview }
    })
    return { question, header, options, multiSelect: raw.multiSelect }
  })
  return { questions }
}

export function parseQuestionAnswers(
  questions: readonly AskUserQuestion[],
  value: unknown
): QuestionAnswers {
  const answers = object(value, 'answers')
  const expected = new Set(questions.map((question) => question.question))
  const actual = Object.keys(answers)
  if (actual.length !== expected.size || actual.some((question) => !expected.has(question))) {
    throw new QuestionInputError('answers must contain exactly one entry for every question')
  }
  return Object.fromEntries(
    questions.map((question) => [
      question.question,
      boundedString(answers[question.question], `answers[${JSON.stringify(question.question)}]`, MAX_ANSWER),
    ])
  )
}

function correlation(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_CORRELATION) {
    throw new QuestionInputError(`${field} must be a non-empty bounded string`)
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new QuestionInputError(`${field} contains control characters`)
  }
  return value
}

function canonical(value: unknown): string {
  return JSON.stringify(value)
}

export function questionDigest(input: AskUserQuestionInput): string {
  return crypto
    .createHash('sha256')
    .update('allmyagents.ask-user-question.input.v1\0')
    .update(canonical(input))
    .digest('hex')
}

function recoveredOutcome(
  durable: ResolvedQuestion,
  expected: {
    sessionId: string
    toolUseId: string
    requestId: string
    digest: string
  }
): QuestionOutcome {
  if (
    durable.sessionId !== expected.sessionId ||
    durable.toolUseId !== expected.toolUseId ||
    durable.requestId !== expected.requestId ||
    durable.questionDigest !== expected.digest
  ) {
    throw new QuestionInputError('durable question correlation conflicts with the current request')
  }
  if (durable.status === 'answered') {
    // Journal strings are intentionally redacted. Reconstructing updatedInput from the audit row could
    // therefore send text the operator never entered. A successor can prove an answer was submitted, but
    // not recover its exact bytes, so it truthfully fails closed and lets Claude ask again if still needed.
    return { kind: 'cancelled', reason: 'recovery-unknown' }
  }
  return durable.status === 'aborted'
    ? { kind: 'cancelled', reason: 'aborted' }
    : { kind: 'cancelled' }
}

/**
 * Hub-owned, non-authorizing AskUserQuestion lifecycle.
 *
 * It deliberately does not share ApprovalService: an answer is tool input, never a grant. Stable vendor
 * invocation correlation lets a surviving worker re-issue across a hub restart without making an answer
 * reusable by a later identical-payload question.
 */
export class QuestionService {
  private readonly pendingMap = new Map<string, PendingEntry>()

  constructor(private readonly journal: Journal) {}

  pending(): QuestionRecord[] {
    return [...this.pendingMap.values()].map((entry) => entry.record)
  }

  request(request: QuestionRequest): Promise<QuestionOutcome> {
    const id = correlation(request.id, 'question id')
    const sessionId = correlation(request.sessionId, 'session id')
    const toolUseId = correlation(request.toolUseId, 'toolUseID')
    const requestId = correlation(request.requestId, 'requestId')
    const input = parseAskUserQuestionInput(request.input)
    const digest = questionDigest(input)
    const existing = this.pendingMap.get(id)
    if (existing) {
      if (
        existing.record.sessionId !== sessionId ||
        existing.record.toolUseId !== toolUseId ||
        existing.record.requestId !== requestId ||
        existing.digest !== digest
      ) {
        throw new QuestionInputError('question id collided with different correlation or questions')
      }
      return existing.promise
    }

    const durable = this.journal.resolvedQuestion(id)
    if (durable) {
      const outcome = recoveredOutcome(durable, { sessionId, toolUseId, requestId, digest })
      if (
        outcome.kind === 'cancelled' &&
        outcome.reason === 'recovery-unknown' &&
        !this.journal.questionRecoveryUnknownNoted(id)
      ) {
        this.journal.append(sessionId, 'question/recovery-unknown', {
          id,
          toolUseId,
          requestId,
          message:
            'An answer was submitted before the hub restarted, but its exact delivery cannot be verified. The agent was told to ask again if needed.',
        })
      }
      return Promise.resolve(outcome)
    }

    // Same-id dedup and durable recovery happen first so a legitimate retry still coalesces at capacity.
    // A new request fails before journaling or retaining its body.
    if (this.pendingMap.size >= MAX_PENDING_QUESTIONS_GLOBAL) {
      throw new QuestionInputError('too many pending questions in this hub')
    }
    let sessionPending = 0
    for (const entry of this.pendingMap.values()) {
      if (entry.record.sessionId === sessionId) sessionPending += 1
    }
    if (sessionPending >= MAX_PENDING_QUESTIONS_PER_SESSION) {
      throw new QuestionInputError('too many pending questions for this session')
    }

    const record: QuestionRecord = {
      id,
      sessionId,
      toolUseId,
      requestId,
      questions: input.questions,
      status: 'pending',
      createdAt: new Date().toISOString(),
    }
    let resolve!: (outcome: QuestionOutcome) => void
    const promise = new Promise<QuestionOutcome>((settle) => {
      resolve = settle
    })
    const entry: PendingEntry = { record, digest, resolve, promise }
    this.pendingMap.set(id, entry)
    this.journal.append(sessionId, 'question/requested', record)
    if (request.signal) {
      const abort = () => this.abort(id)
      if (request.signal.aborted) abort()
      else {
        request.signal.addEventListener('abort', abort, { once: true })
        entry.removeAbort = () => request.signal?.removeEventListener('abort', abort)
      }
    }
    return promise
  }

  answer(id: string, rawAnswers: unknown): boolean {
    const entry = this.pendingMap.get(id)
    if (!entry) return false
    const answers = parseQuestionAnswers(entry.record.questions, rawAnswers)
    const updatedInput = { questions: entry.record.questions, answers }
    return this.finish(entry, 'answered', { kind: 'answered', updatedInput })
  }

  cancel(id: string): boolean {
    const entry = this.pendingMap.get(id)
    return entry ? this.finish(entry, 'cancelled', { kind: 'cancelled' }) : false
  }

  abort(id: string, sessionId?: string): boolean {
    const entry = this.pendingMap.get(id)
    if (entry && sessionId !== undefined && entry.record.sessionId !== sessionId) return false
    return entry
      ? this.finish(entry, 'aborted', { kind: 'cancelled', reason: 'aborted' })
      : false
  }

  private finish(
    entry: PendingEntry,
    status: Exclude<QuestionStatus, 'pending'>,
    outcome: QuestionOutcome
  ): boolean {
    if (this.pendingMap.get(entry.record.id) !== entry) return false
    this.pendingMap.delete(entry.record.id)
    entry.removeAbort?.()
    entry.record.status = status
    this.journal.append(entry.record.sessionId, 'question/resolved', {
      id: entry.record.id,
      status,
      toolUseId: entry.record.toolUseId,
      requestId: entry.record.requestId,
      questionDigest: entry.digest,
    })
    entry.resolve(outcome)
    return true
  }
}

/** Hub worker-socket boundary: recompute identity and validate the owning provider before allocation. */
export function resolveWorkerQuestion(
  questions: QuestionService,
  sessions: ReadonlyArray<{ id: string; provider: string }>,
  request: WorkerQuestionRequest
): Promise<QuestionOutcome> {
  const expectedId = stableQuestionId(
    request.sessionId,
    request.toolUseId,
    request.requestId
  )
  if (request.questionId !== expectedId) {
    return Promise.resolve({
      kind: 'cancelled',
      reason: 'rejected',
      message: 'Question correlation did not match the hub-computed identity.',
    })
  }
  const record = sessions.find((candidate) => candidate.id === request.sessionId)
  if (!record || record.provider !== 'claude') {
    return Promise.resolve({
      kind: 'cancelled',
      reason: 'rejected',
      message: 'Question session is missing or is not a Claude session.',
    })
  }
  return questions.request({
    id: expectedId,
    sessionId: request.sessionId,
    toolUseId: request.toolUseId,
    requestId: request.requestId,
    input: request.input,
  })
}

import crypto from 'node:crypto'
import type { Journal, ResolvedQuestion } from './journal.js'

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
      reason?:
        | 'aborted'
        | 'hub-restarted'
        | 'worker-restarted'
        | 'recovery-unknown'
        | 'rejected'
        | 'unavailable'
      message?: string
    }

export type QuestionStatus = 'pending' | 'answered' | 'cancelled' | 'aborted'

export interface QuestionRecord {
  id: string
  sessionId: string
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


interface PendingEntry {
  record: QuestionRecord
  toolUseId: string
  requestId: string
  correlationDigest: string
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

export class QuestionOwnershipError extends Error {
  constructor(message = 'This hub does not own the public question lifecycle.') {
    super(message)
    this.name = 'QuestionOwnershipError'
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

function questionCorrelationDigest(
  sessionId: string,
  toolUseId: string,
  requestId: string
): string {
  return crypto
    .createHash('sha256')
    .update('allmyagents.ask-user-question.correlation.v1\0')
    .update(canonical([sessionId, toolUseId, requestId]))
    .digest('hex')
}

function recoveredOutcome(
  durable: ResolvedQuestion,
  expected: {
    sessionId: string
    correlationDigest: string
    digest: string
  }
): QuestionOutcome {
  if (
    durable.sessionId !== expected.sessionId ||
    durable.correlationDigest !== expected.correlationDigest ||
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
    ? {
        kind: 'cancelled',
        reason:
          durable.reason === 'hub-restarted' || durable.reason === 'worker-restarted'
            ? durable.reason
            : 'aborted',
      }
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
  private readonly ownerEpoch = crypto.randomUUID()
  private publicOwnerActive = false

  constructor(private readonly journal: Journal) {}

  pending(): QuestionRecord[] {
    this.requirePublicOwner()
    for (const entry of [...this.pendingMap.values()]) this.reconcile(entry)
    return [...this.pendingMap.values()].map((entry) => entry.record)
  }

  /**
   * Claim the public role after cold boot or supervised promotion. Construction is deliberately inert:
   * a booting green overlaps live blue and must not close blue's callback. Activation terminalizes only
   * foreign-process summaries, whose exact bodies/callbacks are unrecoverable in this process.
   */
  activatePublicOwner(): number {
    if (this.publicOwnerActive) return 0
    const terminalized = this.journal.terminalizeForeignQuestions(this.ownerEpoch)
    this.publicOwnerActive = true
    return terminalized
  }

  /** Planned blue drain: settle owned callbacks durably before relinquishing the public role. */
  deactivatePublicOwner(): number {
    if (!this.publicOwnerActive) return 0
    const terminalized = this.abortAll('hub-restarted')
    this.publicOwnerActive = false
    return terminalized
  }

  get isPublicOwner(): boolean {
    return this.publicOwnerActive
  }

  request(request: QuestionRequest): Promise<QuestionOutcome> {
    this.requirePublicOwner()
    const id = correlation(request.id, 'question id')
    const sessionId = correlation(request.sessionId, 'session id')
    const toolUseId = correlation(request.toolUseId, 'toolUseID')
    const requestId = correlation(request.requestId, 'requestId')
    const input = parseAskUserQuestionInput(request.input)
    const digest = questionDigest(input)
    const correlationDigest = questionCorrelationDigest(sessionId, toolUseId, requestId)
    const existing = this.pendingMap.get(id)
    if (existing) {
      if (
        existing.record.sessionId !== sessionId ||
        existing.toolUseId !== toolUseId ||
        existing.requestId !== requestId ||
        existing.digest !== digest
      ) {
        throw new QuestionInputError('question id collided with different correlation or questions')
      }
      this.reconcile(existing)
      return existing.promise
    }

    const durable = this.journal.resolvedQuestion(id)
    if (durable) {
      const outcome = recoveredOutcome(durable, { sessionId, correlationDigest, digest })
      if (
        outcome.kind === 'cancelled' &&
        outcome.reason === 'recovery-unknown' &&
        !this.journal.questionRecoveryUnknownNoted(id)
      ) {
        this.journal.append(sessionId, 'question/recovery-unknown', {
          id,
          correlationDigest,
          message:
            'An answer was submitted before the hub restarted, but its exact delivery cannot be verified. The agent was told to ask again if needed.',
        })
      }
      return Promise.resolve(outcome)
    }

    const record: QuestionRecord = {
      id,
      sessionId,
      questions: input.questions,
      status: 'pending',
      createdAt: new Date().toISOString(),
    }
    let resolve!: (outcome: QuestionOutcome) => void
    const promise = new Promise<QuestionOutcome>((settle) => {
      resolve = settle
    })
    const entry: PendingEntry = {
      record,
      toolUseId,
      requestId,
      correlationDigest,
      digest,
      resolve,
      promise,
    }
    let registered
    try {
      registered = this.journal.registerQuestion(
        {
          id,
          sessionId,
          correlationDigest,
          toolUseIdLength: toolUseId.length,
          requestIdLength: requestId.length,
          questionDigest: digest,
          ownerEpoch: this.ownerEpoch,
          inputBytes: Buffer.byteLength(canonical(input), 'utf8'),
          createdAt: record.createdAt,
          questionCount: input.questions.length,
        },
        {
          global: MAX_PENDING_QUESTIONS_GLOBAL,
          perSession: MAX_PENDING_QUESTIONS_PER_SESSION,
        }
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/too many pending questions/u.test(message)) throw new QuestionInputError(message)
      throw error
    }
    this.assertDurableCorrelation(registered.state, entry)
    if (registered.state.status !== 'pending') {
      const outcome = recoveredOutcome(
        registered.state as ResolvedQuestion,
        {
        sessionId,
        correlationDigest,
        digest,
        }
      )
      return Promise.resolve(outcome)
    }
    if (!registered.created && registered.state.ownerEpoch !== this.ownerEpoch) {
      return Promise.resolve({
        kind: 'cancelled',
        reason: 'unavailable',
        message:
          'This question is owned by another live hub process and cannot be answered through this process.',
      })
    }
    // The durable request and bounded active body exist before local retention. If the transaction fails,
    // no quota slot or promise remains; post-commit subscriber failures are contained by Journal.atomic().
    this.pendingMap.set(id, entry)
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
    this.requirePublicOwner()
    const entry = this.pendingMap.get(id)
    if (!entry) return false
    if (this.reconcile(entry)) return false
    const answers = parseQuestionAnswers(entry.record.questions, rawAnswers)
    const updatedInput = { questions: entry.record.questions, answers }
    return this.finish(entry, 'answered', { kind: 'answered', updatedInput })
  }

  cancel(id: string): boolean {
    this.requirePublicOwner()
    const entry = this.pendingMap.get(id)
    if (!entry || this.reconcile(entry)) return false
    return this.finish(entry, 'cancelled', { kind: 'cancelled' })
  }

  abort(id: string, sessionId?: string): boolean {
    this.requirePublicOwner()
    const entry = this.pendingMap.get(id)
    if (entry && sessionId !== undefined && entry.record.sessionId !== sessionId) return false
    if (!entry || this.reconcile(entry)) return false
    return this.finish(entry, 'aborted', { kind: 'cancelled', reason: 'aborted' })
  }

  /** Terminalize every callback owned by this process before restart releases its public listener. */
  abortAll(
    reason: 'hub-restarted' | 'worker-restarted' = 'worker-restarted'
  ): number {
    let terminalized = 0
    for (const entry of [...this.pendingMap.values()]) {
      if (this.reconcile(entry)) continue
      if (
        this.finish(
          entry,
          'aborted',
          { kind: 'cancelled', reason },
          reason
        )
      ) {
        terminalized += 1
      }
    }
    return terminalized
  }

  private finish(
    entry: PendingEntry,
    status: Exclude<QuestionStatus, 'pending'>,
    outcome: QuestionOutcome,
    reason?: 'hub-restarted' | 'worker-restarted'
  ): boolean {
    if (this.pendingMap.get(entry.record.id) !== entry) return false
    const terminal = this.journal.resolveQuestion(
      entry.record.id,
      {
        sessionId: entry.record.sessionId,
        correlationDigest: entry.correlationDigest,
        questionDigest: entry.digest,
      },
      status,
      reason
    )
    if (!terminal.written) {
      this.settle(
        entry,
        recoveredOutcome(terminal.state, {
          sessionId: entry.record.sessionId,
          correlationDigest: entry.correlationDigest,
          digest: entry.digest,
        }),
        terminal.state.status
      )
      return false
    }
    this.settle(entry, outcome, status)
    return true
  }

  private reconcile(entry: PendingEntry): boolean {
    const durable = this.journal.resolvedQuestion(entry.record.id)
    if (!durable) return false
    const outcome = recoveredOutcome(durable, {
      sessionId: entry.record.sessionId,
      correlationDigest: entry.correlationDigest,
      digest: entry.digest,
    })
    this.settle(entry, outcome, durable.status)
    return true
  }

  private settle(
    entry: PendingEntry,
    outcome: QuestionOutcome,
    status: Exclude<QuestionStatus, 'pending'>
  ): void {
    if (this.pendingMap.get(entry.record.id) !== entry) return
    this.pendingMap.delete(entry.record.id)
    entry.removeAbort?.()
    entry.record.status = status
    entry.resolve(outcome)
  }

  private assertDurableCorrelation(
    state: {
      sessionId: string
      correlationDigest: string
      questionDigest: string
    },
    entry: PendingEntry
  ): void {
    if (
      state.sessionId !== entry.record.sessionId ||
      state.correlationDigest !== entry.correlationDigest ||
      state.questionDigest !== entry.digest
    ) {
      throw new QuestionInputError('question id collided with different correlation or questions')
    }
  }

  private requirePublicOwner(): void {
    if (!this.publicOwnerActive) throw new QuestionOwnershipError()
  }
}

import { afterEach, describe, expect, it } from 'vitest'
import { Journal } from './journal.js'
import {
  MAX_PENDING_QUESTIONS_GLOBAL,
  MAX_PENDING_QUESTIONS_PER_SESSION,
  parseQuestionDecisionBody,
  QuestionInputError,
  QuestionService,
  resolveWorkerQuestion,
  type AskUserQuestionInput,
} from './questions.js'
import type { HubEvent } from './types.js'
import { stableQuestionId } from './workerProtocol.js'

const QUESTIONS: AskUserQuestionInput = {
  questions: [
    {
      question: 'Which format should I use?',
      header: 'Format',
      options: [
        { label: 'Summary', description: 'A short overview.' },
        { label: 'Detailed', description: 'A complete explanation.' },
      ],
      multiSelect: false,
    },
    {
      question: 'Which sections should I include?',
      header: 'Sections',
      options: [
        { label: 'Intro', description: 'Opening context.' },
        { label: 'Results', description: 'The measured results.' },
        { label: 'Next steps', description: 'Recommended follow-up.' },
      ],
      multiSelect: true,
    },
  ],
}

const opened: Journal[] = []

function fresh(journal = new Journal(':memory:')) {
  opened.push(journal)
  const events: HubEvent[] = []
  journal.on('event', (event) => events.push(event))
  const questions = new QuestionService(journal)
  const request = () =>
    questions.request({
      id: 'q-stable',
      sessionId: 's1',
      toolUseId: 'toolu_1',
      requestId: 'control_1',
      input: QUESTIONS,
    })
  const count = (kind: string) => events.filter((event) => event.kind === kind).length
  return { journal, questions, request, events, count }
}

afterEach(() => {
  while (opened.length) opened.pop()!.db.close()
})

describe('QuestionService lifecycle', () => {
  it('keeps a valid question pending without creating a permission approval', async () => {
    const { questions, request, count } = fresh()
    let settled = false
    const answer = request().finally(() => {
      settled = true
    })

    expect(settled).toBe(false)
    expect(questions.pending()).toHaveLength(1)
    expect(questions.pending()[0]).toMatchObject({
      id: 'q-stable',
      sessionId: 's1',
      toolUseId: 'toolu_1',
      requestId: 'control_1',
      status: 'pending',
      questions: QUESTIONS.questions,
    })
    expect(count('question/requested')).toBe(1)
    expect(count('approval/requested')).toBe(0)

    questions.cancel('q-stable')
    await expect(answer).resolves.toEqual({ kind: 'cancelled' })
  })

  it('answers with the exact original questions and exact-question-keyed strings', async () => {
    const { questions, request, count } = fresh()
    const pending = request()
    const answers = {
      'Which format should I use?': 'Detailed',
      'Which sections should I include?': 'Intro, Next steps',
    }

    expect(questions.answer('q-stable', answers)).toBe(true)
    await expect(pending).resolves.toEqual({
      kind: 'answered',
      updatedInput: { questions: QUESTIONS.questions, answers },
    })
    expect(questions.pending()).toEqual([])
    expect(count('question/resolved')).toBe(1)
    expect(count('approval/resolved')).toBe(0)
  })

  it('supports free-text Other answers while rejecting blank, missing, and extra answers', async () => {
    const { questions, request } = fresh()
    const pending = request()

    expect(() =>
      questions.answer('q-stable', {
        'Which format should I use?': 'Use the house style instead',
      })
    ).toThrow(QuestionInputError)
    expect(() =>
      questions.answer('q-stable', {
        'Which format should I use?': 'Detailed',
        'Which sections should I include?': '   ',
      })
    ).toThrow(QuestionInputError)
    expect(() =>
      questions.answer('q-stable', {
        'Which format should I use?': 'Detailed',
        'Which sections should I include?': 'Intro',
        'Not asked': 'Surprise',
      })
    ).toThrow(QuestionInputError)

    const answers = {
      'Which format should I use?': 'Use the house style instead',
      'Which sections should I include?': 'Intro, Results',
    }
    expect(questions.answer('q-stable', answers)).toBe(true)
    await expect(pending).resolves.toMatchObject({ kind: 'answered', updatedInput: { answers } })
  })

  it('cancels explicitly and never turns cancellation into an empty allow', async () => {
    const { questions, request, events } = fresh()
    const pending = request()
    expect(questions.cancel('q-stable')).toBe(true)
    await expect(pending).resolves.toEqual({ kind: 'cancelled' })
    expect(events.find((event) => event.kind === 'question/resolved')?.payload).toMatchObject({
      id: 'q-stable',
      status: 'cancelled',
    })
    expect(questions.cancel('q-stable')).toBe(false)
  })

  it('binds abort to the owning session', async () => {
    const { questions, request } = fresh()
    const pending = request()
    expect(questions.abort('q-stable', 'other-session')).toBe(false)
    expect(questions.pending()).toHaveLength(1)
    expect(questions.abort('q-stable', 's1')).toBe(true)
    await expect(pending).resolves.toEqual({ kind: 'cancelled', reason: 'aborted' })
  })

  it('coalesces a same-correlation reissue and rejects a colliding id with different correlation/input', async () => {
    const { questions, request, count } = fresh()
    const first = request()
    const second = request()
    expect(second).toBe(first)
    expect(count('question/requested')).toBe(1)

    expect(() =>
      questions.request({
        id: 'q-stable',
        sessionId: 's1',
        toolUseId: 'toolu_other',
        requestId: 'control_1',
        input: QUESTIONS,
      })
    ).toThrow(QuestionInputError)

    questions.cancel('q-stable')
    await expect(first).resolves.toEqual({ kind: 'cancelled' })
  })

  it('never reconstructs a secret-like answer from the redacted journal after a lost reply', async () => {
    const { journal, questions, request, count } = fresh()
    const pending = request()
    const answers = {
      'Which format should I use?': 'token: sk-ant-this-is-a-secret-like-custom-answer',
      'Which sections should I include?': 'Results',
    }
    questions.answer('q-stable', answers)
    await expect(pending).resolves.toMatchObject({
      kind: 'answered',
      updatedInput: { answers },
    })
    expect(count('question/requested')).toBe(1)
    expect(count('question/resolved')).toBe(1)
    const audit = journal.db
      .prepare("SELECT payload FROM events WHERE kind = 'question/resolved'")
      .get() as { payload: string }
    expect(audit.payload).not.toContain('sk-ant-this-is-a-secret-like-custom-answer')
    expect(audit.payload).not.toContain('updatedInput')

    const successor = new QuestionService(journal)
    await expect(
      successor.request({
        id: 'q-stable',
        sessionId: 's1',
        toolUseId: 'toolu_1',
        requestId: 'control_1',
        input: QUESTIONS,
      })
    ).resolves.toEqual({ kind: 'cancelled', reason: 'recovery-unknown' })
    expect(successor.pending()).toEqual([])
    expect(count('question/requested')).toBe(1)
    expect(count('question/resolved')).toBe(1)
    expect(count('question/recovery-unknown')).toBe(1)
    await expect(
      new QuestionService(journal).request({
        id: 'q-stable',
        sessionId: 's1',
        toolUseId: 'toolu_1',
        requestId: 'control_1',
        input: QUESTIONS,
      })
    ).resolves.toEqual({ kind: 'cancelled', reason: 'recovery-unknown' })
    expect(count('question/recovery-unknown')).toBe(1)
  })

  it('recovers cancellation after restart and re-offers an unresolved request', async () => {
    const { journal, questions, request, count } = fresh()
    const cancelled = request()
    questions.cancel('q-stable')
    await cancelled

    const successor = new QuestionService(journal)
    await expect(
      successor.request({
        id: 'q-stable',
        sessionId: 's1',
        toolUseId: 'toolu_1',
        requestId: 'control_1',
        input: QUESTIONS,
      })
    ).resolves.toEqual({ kind: 'cancelled' })

    const unresolved = new QuestionService(journal)
    const open = unresolved.request({
      id: 'q-open',
      sessionId: 's1',
      toolUseId: 'toolu_open',
      requestId: 'control_open',
      input: QUESTIONS,
    })
    expect(unresolved.pending().map((record) => record.id)).toEqual(['q-open'])
    expect(count('question/requested')).toBe(2)
    unresolved.cancel('q-open')
    await open
  })

  it('bounds pending questions before journaling while same-id retries still dedup at capacity', async () => {
    const { questions, count } = fresh()
    const pending: Promise<unknown>[] = []
    for (let index = 0; index < MAX_PENDING_QUESTIONS_PER_SESSION; index += 1) {
      pending.push(
        questions.request({
          id: `q-session-${index}`,
          sessionId: 's-cap',
          toolUseId: `tool-${index}`,
          requestId: `request-${index}`,
          input: QUESTIONS,
        })
      )
    }
    const duplicate = questions.request({
      id: 'q-session-0',
      sessionId: 's-cap',
      toolUseId: 'tool-0',
      requestId: 'request-0',
      input: QUESTIONS,
    })
    expect(duplicate).toBe(pending[0])
    expect(() =>
      questions.request({
        id: 'q-session-overflow',
        sessionId: 's-cap',
        toolUseId: 'tool-overflow',
        requestId: 'request-overflow',
        input: QUESTIONS,
      })
    ).toThrow(/too many pending questions for this session/)
    expect(count('question/requested')).toBe(MAX_PENDING_QUESTIONS_PER_SESSION)

    for (const record of questions.pending()) questions.cancel(record.id)
    await Promise.all(pending)
  })

  it('enforces the global pending bound across sessions without evicting existing questions', async () => {
    const { questions, count } = fresh()
    const pending: Promise<unknown>[] = []
    for (let index = 0; index < MAX_PENDING_QUESTIONS_GLOBAL; index += 1) {
      pending.push(
        questions.request({
          id: `q-global-${index}`,
          sessionId: `s-${Math.floor(index / MAX_PENDING_QUESTIONS_PER_SESSION)}`,
          toolUseId: `tool-global-${index}`,
          requestId: `request-global-${index}`,
          input: QUESTIONS,
        })
      )
    }
    expect(() =>
      questions.request({
        id: 'q-global-overflow',
        sessionId: 's-overflow',
        toolUseId: 'tool-global-overflow',
        requestId: 'request-global-overflow',
        input: QUESTIONS,
      })
    ).toThrow(/too many pending questions in this hub/)
    expect(questions.pending()).toHaveLength(MAX_PENDING_QUESTIONS_GLOBAL)
    expect(count('question/requested')).toBe(MAX_PENDING_QUESTIONS_GLOBAL)

    for (const record of questions.pending()) questions.cancel(record.id)
    await Promise.all(pending)
  })

  it('preserves prototype-looking exact question keys without mutating or losing object properties', async () => {
    const { questions } = fresh()
    const input: AskUserQuestionInput = {
      questions: [
        {
          question: '__proto__',
          header: 'Prototype',
          options: [
            { label: 'Keep', description: 'Keep the exact key.' },
            { label: 'Reject', description: 'Reject the choice.' },
          ],
          multiSelect: false,
        },
        {
          question: 'constructor',
          header: 'Constructor',
          options: [
            { label: 'Own', description: 'Create an own property.' },
            { label: 'Skip', description: 'Skip this option.' },
          ],
          multiSelect: false,
        },
      ],
    }
    const pending = questions.request({
      id: 'q-special-keys',
      sessionId: 's-special',
      toolUseId: 'tool-special',
      requestId: 'request-special',
      input,
    })
    const rawAnswers = JSON.parse('{"__proto__":"Keep","constructor":"Own"}') as unknown
    expect(questions.answer('q-special-keys', rawAnswers)).toBe(true)
    const outcome = await pending
    expect(outcome).toMatchObject({
      kind: 'answered',
      updatedInput: { answers: { __proto__: 'Keep', constructor: 'Own' } },
    })
    if (outcome.kind !== 'answered') throw new Error('expected answered outcome')
    expect(Object.hasOwn(outcome.updatedInput.answers, '__proto__')).toBe(true)
    expect(Object.hasOwn(outcome.updatedInput.answers, 'constructor')).toBe(true)
    expect(JSON.parse(JSON.stringify(outcome.updatedInput.answers))).toEqual(
      JSON.parse('{"__proto__":"Keep","constructor":"Own"}')
    )
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})

describe('AskUserQuestion schema validation', () => {
  it.each([
    ['missing questions', {}],
    ['zero questions', { questions: [] }],
    ['too many questions', { questions: Array.from({ length: 5 }, () => QUESTIONS.questions[0]) }],
    ['duplicate question text', { questions: [QUESTIONS.questions[0], QUESTIONS.questions[0]] }],
    [
      'too few options',
      {
        questions: [
          {
            question: 'Choose?',
            header: 'Choice',
            options: [{ label: 'One', description: 'Only one.' }],
            multiSelect: false,
          },
        ],
      },
    ],
    [
      'model-supplied Other',
      {
        questions: [
          {
            question: 'Choose?',
            header: 'Choice',
            options: [
              { label: 'One', description: 'First.' },
              { label: 'Other', description: 'Injected ambiguity.' },
            ],
            multiSelect: false,
          },
        ],
      },
    ],
    [
      'unknown question field',
      {
        questions: [
          {
            ...QUESTIONS.questions[0],
            surprise: true,
          },
        ],
      },
    ],
  ])('fails closed for %s', (_label, input) => {
    const { questions } = fresh()
    expect(() =>
      questions.request({
        id: 'q-invalid',
        sessionId: 's1',
        toolUseId: 'toolu_invalid',
        requestId: 'control_invalid',
        input,
      })
    ).toThrow(QuestionInputError)
    expect(questions.pending()).toEqual([])
  })

  it('rejects a very large string before retaining or journaling it', () => {
    const { questions, count } = fresh()
    expect(() =>
      questions.request({
        id: 'q-huge',
        sessionId: 's1',
        toolUseId: 'toolu_huge',
        requestId: 'control_huge',
        input: {
          questions: [
            {
              ...QUESTIONS.questions[0],
              question: 'x'.repeat(1_000_000),
            },
          ],
        },
      })
    ).toThrow(QuestionInputError)
    expect(questions.pending()).toEqual([])
    expect(count('question/requested')).toBe(0)
  })

  it('accepts only the two closed API response shapes and rejects hostile/inherited keys', () => {
    expect(parseQuestionDecisionBody({ cancel: true })).toEqual({ kind: 'cancel' })
    expect(parseQuestionDecisionBody({ answers: { a: 'b' } })).toEqual({
      kind: 'answer',
      answers: { a: 'b' },
    })

    const inherited = Object.create({ answers: { a: 'inherited' } }) as object
    for (const body of [
      {},
      { cancel: false },
      { cancel: false, answers: {} },
      { cancel: true, answers: {} },
      { answers: {}, extra: true },
      JSON.parse('{"__proto__":{},"answers":{}}'),
      { constructor: {}, answers: {} },
      inherited,
    ]) {
      expect(() => parseQuestionDecisionBody(body)).toThrow(QuestionInputError)
    }
  })
})

describe('hub worker question dispatch boundary', () => {
  it('uses unambiguous correlation framing and rejects control-bearing service identifiers', () => {
    const left = stableQuestionId('session', 'a\0b', 'c')
    const right = stableQuestionId('session', 'a', 'b\0c')
    expect(left).not.toBe(right)

    const { questions } = fresh()
    expect(() =>
      questions.request({
        id: left,
        sessionId: 'session',
        toolUseId: 'a\0b',
        requestId: 'c',
        input: QUESTIONS,
      })
    ).toThrow(/control characters/)
    expect(questions.pending()).toEqual([])
  })

  it('rejects caller-chosen ids and missing/non-Claude sessions before QuestionService', async () => {
    const { questions, count } = fresh()
    const request = {
      questionId: 'caller-chosen',
      sessionId: 's1',
      toolUseId: 'tool-worker',
      requestId: 'request-worker',
      input: QUESTIONS,
    }
    await expect(
      resolveWorkerQuestion(questions, [{ id: 's1', provider: 'claude' }], request)
    ).resolves.toMatchObject({ kind: 'cancelled', reason: 'rejected' })

    const expectedId = stableQuestionId('s1', 'tool-worker', 'request-worker')
    await expect(
      resolveWorkerQuestion(questions, [], { ...request, questionId: expectedId })
    ).resolves.toMatchObject({ kind: 'cancelled', reason: 'rejected' })
    await expect(
      resolveWorkerQuestion(
        questions,
        [{ id: 's1', provider: 'codex' }],
        { ...request, questionId: expectedId }
      )
    ).resolves.toMatchObject({ kind: 'cancelled', reason: 'rejected' })
    expect(questions.pending()).toEqual([])
    expect(count('question/requested')).toBe(0)
  })

  it('admits the exact computed id for an existing Claude session', async () => {
    const { questions, count } = fresh()
    const questionId = stableQuestionId('s1', 'tool-worker', 'request-worker')
    const pending = resolveWorkerQuestion(
      questions,
      [{ id: 's1', provider: 'claude' }],
      {
        questionId,
        sessionId: 's1',
        toolUseId: 'tool-worker',
        requestId: 'request-worker',
        input: QUESTIONS,
      }
    )
    expect(questions.pending().map((record) => record.id)).toEqual([questionId])
    expect(count('question/requested')).toBe(1)
    questions.cancel(questionId)
    await expect(pending).resolves.toEqual({ kind: 'cancelled' })
  })
})

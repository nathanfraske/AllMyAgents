import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { Journal } from './journal.js'
import { QuestionService, type AskUserQuestionInput } from './questions.js'
import { startServer, type ServerOptions } from './server.js'

const SPECIAL_INPUT: AskUserQuestionInput = {
  questions: [
    {
      question: '__proto__',
      header: 'Prototype',
      options: [
        { label: 'Keep', description: 'Keep the exact key.' },
        { label: 'Reject', description: 'Reject the key.' },
      ],
      multiSelect: false,
    },
    {
      question: 'constructor',
      header: 'Constructor',
      options: [
        { label: 'Own', description: 'Create an own property.' },
        { label: 'Skip', description: 'Skip it.' },
      ],
      multiSelect: false,
    },
  ],
}

const cleanups: Array<() => void | Promise<void>> = []

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.()
})

async function build() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-questions-api-'))
  const journal = new Journal(path.join(root, 'hub.db'))
  const questions = new QuestionService(journal)
  const deviceToken = 'question-api-test-device-token-at-least-32-characters'
  const server = startServer({
    port: 0,
    defaultCwd: root,
    profilesDir: root,
    journal,
    sessions: { list: () => [] } as never,
    profiles: [],
    approvals: { pending: () => [] } as never,
    questions,
    usage: {} as never,
    projects: {} as never,
    workspace: {} as never,
    instructions: {} as never,
    bus: {} as never,
    memory: {} as never,
    practices: {} as never,
    danger: { busCanUseRiskyTools: false, autoApprovePractices: false },
    prefs: { chatNamePool: 'everyone', steerMessagesAtToolBoundary: true },
    rescanProfiles: () => [],
    mesh: {} as never,
    deviceToken,
    requireToken: true,
    restartState: { booted: true, sockets: new Set(), draining: false, promoting: false } as never,
    executor: {} as never,
    configPath: path.join(root, 'config.json'),
  } satisfies ServerOptions)
  if (!server.listening) await once(server, 'listening')
  const address = server.address() as { port: number }
  cleanups.push(async () => {
    for (const pending of questions.pending()) questions.cancel(pending.id)
    if (server.listening) {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()))
      server.closeAllConnections()
      await closed
    }
    journal.db.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  return {
    base: `http://127.0.0.1:${address.port}`,
    deviceToken,
    questions,
  }
}

function requestHeaders(token: string): HeadersInit {
  return {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  }
}

describe('authenticated question HTTP lifecycle', () => {
  it('lists pending questions and preserves hostile-looking exact answer keys through POST', async () => {
    const { base, deviceToken, questions } = await build()
    const pending = questions.request({
      id: 'q-special',
      sessionId: 's1',
      toolUseId: 'tool-special',
      requestId: 'request-special',
      input: SPECIAL_INPUT,
    })

    expect((await fetch(`${base}/api/questions`)).status).toBe(401)
    const listed = await fetch(`${base}/api/questions`, {
      headers: requestHeaders(deviceToken),
    })
    expect(listed.status).toBe(200)
    expect(await listed.json()).toMatchObject([{ id: 'q-special', sessionId: 's1' }])

    const answered = await fetch(`${base}/api/questions/q-special`, {
      method: 'POST',
      headers: requestHeaders(deviceToken),
      body: '{"answers":{"__proto__":"Keep","constructor":"Own"}}',
    })
    expect(answered.status).toBe(200)
    expect(await answered.json()).toEqual({ ok: true })
    const outcome = await pending
    expect(outcome.kind).toBe('answered')
    if (outcome.kind !== 'answered') throw new Error('expected answered outcome')
    expect(Object.hasOwn(outcome.updatedInput.answers, '__proto__')).toBe(true)
    expect(JSON.parse(JSON.stringify(outcome.updatedInput.answers))).toEqual(
      JSON.parse('{"__proto__":"Keep","constructor":"Own"}')
    )
    expect(questions.pending()).toEqual([])
  })

  it('accepts exact cancel, rejects malformed/extra shapes, and returns 404 for unknown ids', async () => {
    const { base, deviceToken, questions } = await build()
    const pending = questions.request({
      id: 'q-cancel',
      sessionId: 's1',
      toolUseId: 'tool-cancel',
      requestId: 'request-cancel',
      input: SPECIAL_INPUT,
    })

    for (const body of [
      '{}',
      '{"cancel":false}',
      '{"cancel":false,"answers":{}}',
      '{"cancel":true,"answers":{}}',
      '{"answers":null}',
      '{"answers":{},"extra":true}',
      '{"__proto__":{},"answers":{}}',
      '{"constructor":{},"answers":{}}',
    ]) {
      const response = await fetch(`${base}/api/questions/q-cancel`, {
        method: 'POST',
        headers: requestHeaders(deviceToken),
        body,
      })
      expect(response.status, body).toBe(400)
      expect(questions.pending()).toHaveLength(1)
    }

    const unknown = await fetch(`${base}/api/questions/not-found`, {
      method: 'POST',
      headers: requestHeaders(deviceToken),
      body: '{"cancel":true}',
    })
    expect(unknown.status).toBe(404)

    const cancelled = await fetch(`${base}/api/questions/q-cancel`, {
      method: 'POST',
      headers: requestHeaders(deviceToken),
      body: '{"cancel":true}',
    })
    expect(cancelled.status).toBe(200)
    await expect(pending).resolves.toEqual({ kind: 'cancelled' })
    expect(questions.pending()).toEqual([])
  })
})

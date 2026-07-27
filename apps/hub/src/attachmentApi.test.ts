import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentBus } from './bus.js'
import type { Executor } from './executor.js'
import { InstructionStore } from './instructions.js'
import { Journal } from './journal.js'
import { MemoryStore } from './memory.js'
import { PracticeStore } from './practices.js'
import { ProjectStore } from './projects.js'
import { PayloadTooLargeError, readRawBody, startServer, type ServerOptions } from './server.js'
import { SessionManager } from './sessions.js'
import { SessionStore } from './store.js'
import { ApprovalService } from './approvals.js'
import { UsageMonitor } from './usage.js'
import { WorkspaceManager } from './workspace.js'
import { MAX_IMAGE_BYTES } from './attachments.js'
import type { AttachmentMeta } from './attachments.js'
import { CodexClient } from './adapters/codex.js'

const cleanups: Array<() => void | Promise<void>> = []

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.()
})

function textPdf(text: string): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${text.length + 33} >>\nstream\nBT /F1 12 Tf 72 720 Td (${text}) Tj ET\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf)
}

async function build(provider: 'claude' | 'codex' = 'claude') {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-attachment-api-'))
  const journal = new Journal(path.join(tmp, 'hub.db'))
  const projects = new ProjectStore(journal.db)
  const instructions = new InstructionStore(journal.db)
  const bus = new AgentBus(journal.db)
  const memory = new MemoryStore(journal.db)
  const practices = new PracticeStore(journal.db)
  const approvals = new ApprovalService(journal)
  const usage = new UsageMonitor(journal, [], {})
  const runTurn = vi.fn(async (
    _spec: unknown,
    _text: string,
    _origin: 'operator' | 'bus',
    _attachments?: readonly AttachmentMeta[]
  ) => {})
  const executor: Executor = {
    startThread: async () => 'unused',
    runTurn,
    steer: async () => {},
    interrupt: async () => {},
    stopSession: async () => {},
    readCodexLimits: async () => ({}),
    listLive: async () => [],
    attach: async () => {},
    isBusy: () => false,
  }
  const profile = { id: `${provider}-test`, provider, dir: path.join(tmp, 'profile') }
  const sessions = new SessionManager(
    journal,
    new SessionStore(journal.db),
    new Map([[profile.id, profile]]),
    approvals,
    usage,
    new WorkspaceManager(path.join(tmp, 'worktrees')),
    projects,
    instructions,
    bus,
    memory,
    practices,
    { busCanUseRiskyTools: false, autoApprovePractices: false },
    false,
    tmp,
    executor
  )
  const record = await sessions.create(profile.id, { cwd: tmp, useWorktree: false })
  const server = startServer({
    port: 0,
    defaultCwd: tmp,
    profilesDir: tmp,
    journal,
    sessions,
    profiles: [profile],
    approvals,
    usage,
    projects,
    instructions,
    bus,
    memory,
    practices,
    danger: { busCanUseRiskyTools: false, autoApprovePractices: false },
    prefs: { chatNamePool: 'everyone', steerMessagesAtToolBoundary: true },
    rescanProfiles: () => [profile],
    mesh: {} as never,
    deviceToken: 'test-token',
    requireToken: false,
    restartState: { booted: true, sockets: new Set(), draining: false, promoting: false } as never,
    executor,
    configPath: path.join(tmp, 'config.json'),
  } satisfies ServerOptions)
  if (!server.listening) await once(server, 'listening')
  const address = server.address() as { port: number }
  cleanups.push(async () => {
    if (server.listening) {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()))
      server.closeAllConnections()
      await closed
    }
    journal.db.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })
  return { base: `http://127.0.0.1:${address.port}`, record, tmp, journal, runTurn, sessions, profile }
}

describe('session attachment API', () => {
  it('counts streamed bytes even when content-length understates the body', async () => {
    const stream = Readable.from([Buffer.from('123'), Buffer.from('456')]) as http.IncomingMessage
    stream.headers = { 'content-length': '1' }

    await expect(readRawBody(stream, 5)).rejects.toBeInstanceOf(PayloadTooLargeError)
  })

  it('rejects an over-limit chunked upload with no content-length', async () => {
    const { base, record } = await build()
    const url = new URL(`${base}/api/sessions/${record.id}/attachments`)
    const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: 'POST',
          headers: { 'content-type': 'image/png', 'x-filename': 'too-big.png' },
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => chunks.push(chunk))
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
        }
      )
      req.on('error', reject)
      req.end(Buffer.alloc(MAX_IMAGE_BYTES + 1))
    })

    expect(result.status).toBe(413)
    expect(result.body).toMatch(/exceeds/i)
  })

  it('stores traversal-shaped names inside the upload root and streams the bytes back', async () => {
    const { base, record, tmp } = await build()
    const bytes = Buffer.from('not-really-a-png')
    const uploaded = await fetch(`${base}/api/sessions/${record.id}/attachments`, {
      method: 'POST',
      headers: {
        'content-type': 'image/png',
        'x-filename': '../../outside.png',
      },
      body: bytes,
    })

    expect(uploaded.status).toBe(200)
    const meta = (await uploaded.json()) as {
      id: string
      name: string
      mime: string
      size: number
      path: string
    }
    const uploadRoot = path.resolve(record.cwd, '.allmyagents', 'uploads')
    const relative = path.relative(uploadRoot, path.resolve(meta.path))
    expect(relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)).toBe(false)
    expect(meta.name).toBe('outside.png')
    expect(meta.mime).toBe('image/png')
    expect(meta.size).toBe(bytes.length)
    expect(fs.existsSync(path.join(tmp, 'outside.png'))).toBe(false)

    const downloaded = await fetch(`${base}/api/sessions/${record.id}/attachments/${meta.id}`)
    expect(downloaded.status).toBe(200)
    expect(downloaded.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(bytes)
  })

  it('resolves ids into worker metadata and journals metadata without file bytes', async () => {
    const { base, record, journal, runTurn } = await build()
    const upload = await fetch(`${base}/api/sessions/${record.id}/attachments`, {
      method: 'POST',
      headers: { 'content-type': 'image/png', 'x-filename': 'shot.png' },
      body: Buffer.from([1, 2, 3]),
    })
    const meta = (await upload.json()) as AttachmentMeta

    const sent = await fetch(`${base}/api/sessions/${record.id}/input`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'inspect this', attachments: [meta.id] }),
    })

    expect(sent.status).toBe(200)
    expect(runTurn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: record.id }),
      'inspect this',
      'operator',
      [meta]
    )
    const input = [...journal.replay(0)].find(
      (event) => event.sessionId === record.id && event.kind === 'session/input'
    )
    expect(input?.payload).toEqual({ text: 'inspect this', attachments: [meta] })
    expect(JSON.stringify(input?.payload)).not.toContain(Buffer.from([1, 2, 3]).toString('base64'))
  })

  it('delivers attached Markdown and PDF text to a Codex vendor payload', async () => {
    const { base, record, runTurn } = await build('codex')
    const markdownText = 'CODEX_MARKDOWN_ATTACHMENT'
    const pdfText = 'CODEX_PDF_ATTACHMENT'
    const markdownUpload = await fetch(`${base}/api/sessions/${record.id}/attachments`, {
      method: 'POST',
      headers: { 'content-type': 'text/markdown', 'x-filename': 'notes.md' },
      body: markdownText,
    })
    const pdfUpload = await fetch(`${base}/api/sessions/${record.id}/attachments`, {
      method: 'POST',
      headers: { 'content-type': 'application/pdf', 'x-filename': 'spec.pdf' },
      body: new Uint8Array(textPdf(pdfText)),
    })

    expect(markdownUpload.status).toBe(200)
    expect(pdfUpload.status).toBe(200)
    const markdown = (await markdownUpload.json()) as AttachmentMeta
    const pdf = (await pdfUpload.json()) as AttachmentMeta
    const sent = await fetch(`${base}/api/sessions/${record.id}/input`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Use both documents', attachments: [markdown.id, pdf.id] }),
    })

    expect(sent.status).toBe(200)
    const attachments = runTurn.mock.calls.at(-1)?.[3]
    expect(attachments).toEqual([markdown, pdf])
    const client = new CodexClient('unused', vi.fn())
    const request = vi.spyOn(client, 'request').mockResolvedValue(undefined)
    await client.sendTurn('thread-1', 'Use both documents', {}, attachments)
    const payload = request.mock.calls.at(-1)?.[1]
    expect(JSON.stringify(payload)).toContain(markdownText)
    expect(JSON.stringify(payload)).toContain(pdfText)
  })

  it('rejects a Codex PDF with no text layer at upload time', async () => {
    const { base, record } = await build('codex')
    const upload = await fetch(`${base}/api/sessions/${record.id}/attachments`, {
      method: 'POST',
      headers: { 'content-type': 'application/pdf', 'x-filename': 'scan.pdf' },
      body: new Uint8Array(textPdf('')),
    })

    expect(upload.status).toBe(400)
    await expect(upload.json()).resolves.toEqual({
      error: expect.stringMatching(/appears to be scanned; no text could be extracted/i),
    })
  })

  it('declines Office documents explicitly instead of accepting an undeliverable attachment', async () => {
    const { base, record } = await build('codex')
    const upload = await fetch(`${base}/api/sessions/${record.id}/attachments`, {
      method: 'POST',
      headers: {
        'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'x-filename': 'brief.docx',
      },
      body: new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
    })

    expect(upload.status).toBe(400)
    await expect(upload.json()).resolves.toEqual({
      error: expect.stringMatching(/DOCX extraction is not supported in this release/i),
    })
  })

  it('does not let another session or a tampered sidecar escape the download root', async () => {
    const { base, record, tmp, sessions, profile } = await build()
    const upload = await fetch(`${base}/api/sessions/${record.id}/attachments`, {
      method: 'POST',
      headers: { 'content-type': 'image/png', 'x-filename': 'private.png' },
      body: Buffer.from('private'),
    })
    const meta = (await upload.json()) as AttachmentMeta
    const other = await sessions.create(profile.id, { cwd: record.cwd, useWorktree: false })

    const crossSession = await fetch(`${base}/api/sessions/${other.id}/attachments/${meta.id}`)
    expect(crossSession.status).toBe(404)

    const outside = path.join(tmp, 'outside.png')
    fs.writeFileSync(outside, 'outside')
    fs.writeFileSync(
      path.join(record.cwd, '.allmyagents', 'uploads', `${meta.id}.json`),
      JSON.stringify({ ...meta, sessionId: record.id, name: '../../outside.png', path: outside, size: 7 })
    )
    const escaped = await fetch(`${base}/api/sessions/${record.id}/attachments/${meta.id}`)
    expect(escaped.status).toBe(404)
  })
})

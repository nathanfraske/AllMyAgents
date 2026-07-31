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
import { MAX_IMAGE_BYTES, saveAttachment } from './attachments.js'
import type { AttachmentMeta } from './attachments.js'
import { QuestionService } from './questions.js'
import { CodexClient } from './adapters/codex.js'
import { extractXlsxText } from './officeDocuments.js'
import { strToU8, zipSync } from 'fflate'

const cleanups: Array<() => void | Promise<void>> = []
const TEST_DEVICE_TOKEN = 'attachment-test-device-token-at-least-32-characters'
const nativeFetch = globalThis.fetch

function fetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('authorization', `Bearer ${TEST_DEVICE_TOKEN}`)
  return nativeFetch(input, { ...init, headers })
}

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

function twoSheetXlsx(): Buffer {
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' +
      '</Types>'
    ),
    '_rels/.rels': strToU8(
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>'
    ),
    'xl/workbook.xml': strToU8(
      '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
      '<sheet name="Inventory" sheetId="1" r:id="rId1"/>' +
      '<sheet name="Forecast" sheetId="2" r:id="rId2"/>' +
      '</sheets></workbook>'
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>' +
      '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>' +
      '</Relationships>'
    ),
    'xl/sharedStrings.xml': strToU8(
      '<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<si><t>Product</t></si><si><t>Qty</t></si><si><t>Widget</t></si><si><t>Comma, item</t></si>' +
      '<si><t>Month</t></si><si><t>Revenue</t></si><si><t>Jan</t></si><si><t>Feb</t></si>' +
      '<si><r><t>Rich</t></r><r><t> Text</t></r></si></sst>'
    ),
    'xl/worksheets/sheet1.xml': strToU8(
      '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
      '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>12</v></c></row>' +
      '<row r="3"><c r="A3" t="s"><v>3</v></c><c r="B3"><v>5</v></c></row>' +
      '</sheetData></worksheet>'
    ),
    'xl/worksheets/sheet2.xml': strToU8(
      '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
      '<row r="1"><c r="A1" t="s"><v>4</v></c><c r="B1" t="s"><v>5</v></c></row>' +
      '<row r="2"><c r="A2" t="s"><v>6</v></c><c r="B2"><v>1000</v></c></row>' +
      '<row r="3"><c r="A3" t="s"><v>7</v></c><c r="B3"><v>1250</v></c></row>' +
      '<row r="4"><c r="C4" t="s"><v>8</v></c></row>' +
      '</sheetData></worksheet>'
    ),
  }
  return Buffer.from(zipSync(files, { level: 6 }))
}

function dimensionXlsx(dimension = 'A1:ZZZZ1', cell = 'ZZZZ1'): Buffer {
  return Buffer.from(
    zipSync(
      {
        'xl/workbook.xml': strToU8(
          '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
          'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
          '<sheet name="Hostile" sheetId="1" r:id="rId1"/></sheets></workbook>'
        ),
        'xl/_rels/workbook.xml.rels': strToU8(
          '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
          '</Relationships>'
        ),
        'xl/worksheets/sheet1.xml': strToU8(
          '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
          `<dimension ref="${dimension}"/><sheetData><row r="1"><c r="${cell}"><v>1</v></c></row></sheetData></worksheet>`
        ),
      },
      { level: 6 }
    )
  )
}

function orderedDocx(): Buffer {
  return Buffer.from(
    zipSync(
      {
        '[Content_Types].xml': strToU8(
          '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
          '</Types>'
        ),
        '_rels/.rels': strToU8(
          '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
          '</Relationships>'
        ),
        'word/document.xml': strToU8(
          '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
          '<w:p><w:r><w:t>DOCX_FIRST_RUN</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>SECOND_RUN</w:t></w:r></w:p>' +
          '<w:p><w:r><w:t>DOCX_SECOND_PARAGRAPH</w:t></w:r></w:p>' +
          '</w:body></w:document>'
        ),
      },
      { level: 6 }
    )
  )
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
  const workspace = new WorkspaceManager(path.join(tmp, 'worktrees'))
  const sessions = new SessionManager(
    journal,
    new SessionStore(journal.db),
    new Map([[profile.id, profile]]),
    approvals,
    usage,
    workspace,
    projects,
    instructions,
    bus,
    memory,
    practices,
    { busCanUseRiskyTools: false, autoApprovePractices: false },
    false,
    tmp,
    new QuestionService(journal),
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
    questions: sessions.questionService,
    usage,
    projects,
    workspace,
    instructions,
    bus,
    memory,
    practices,
    danger: { busCanUseRiskyTools: false, autoApprovePractices: false },
    prefs: { chatNamePool: 'everyone', steerMessagesAtToolBoundary: true },
    rescanProfiles: () => [profile],
    mesh: {} as never,
    deviceToken: TEST_DEVICE_TOKEN,
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
      let response: { status: number; body: string } | undefined
      let requestFinished = false
      const done = (): void => {
        if (response && requestFinished) resolve(response)
      }
      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: 'POST',
          headers: {
            authorization: `Bearer ${TEST_DEVICE_TOKEN}`,
            'content-type': 'image/png',
            'x-filename': 'too-big.png',
          },
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => chunks.push(chunk))
          res.on('error', reject)
          res.on('end', () => {
            response = { status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }
            done()
          })
        }
      )
      req.on('error', reject)
      req.on('finish', () => {
        requestFinished = true
        done()
      })
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
    // macOS exposes os.tmpdir() through /var while realpath/git report /private/var.
    const uploadRoot = fs.realpathSync.native(path.resolve(record.cwd, '.allmyagents', 'uploads'))
    const relative = path.relative(uploadRoot, fs.realpathSync.native(meta.path))
    expect(relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)).toBe(false)
    expect(meta.name).toBe('outside.png')
    expect(meta.mime).toBe('image/png')
    expect(meta.size).toBe(bytes.length)
    expect(fs.existsSync(path.join(tmp, 'outside.png'))).toBe(false)

    const downloaded = await fetch(`${base}/api/sessions/${record.id}/attachments/${meta.id}`)
    expect(downloaded.status).toBe(200)
    expect(downloaded.headers.get('content-type')).toBe('image/png')
    expect(downloaded.headers.get('content-disposition')).toBe('inline')
    expect(downloaded.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox")
    expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(bytes)
  })

  it('never serves HTML or SVG as inline active content on the hub origin', async () => {
    const { base, record } = await build()
    const htmlUpload = await fetch(`${base}/api/sessions/${record.id}/attachments`, {
      method: 'POST',
      headers: {
        'content-type': 'text/html',
        'x-filename': 'report.html',
      },
      body: '<script>globalThis.compromised = true</script>',
    })
    expect(htmlUpload.status).toBe(200)
    const html = (await htmlUpload.json()) as AttachmentMeta
    // SVG is rejected by the upload admission boundary today. Persist one through the lower storage
    // primitive so this response-boundary regression also protects legacy rows and future admission changes.
    const svg = saveAttachment(
      record.id,
      record.cwd,
      'diagram.svg',
      'image/svg+xml',
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
    )

    for (const attachment of [html, svg]) {
      const response = await fetch(
        `${base}/api/sessions/${record.id}/attachments/${attachment.id}`
      )
      expect(response.status).toBe(200)
      expect(response.headers.get('content-disposition')).toMatch(/^attachment;/)
      expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox")
      expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    }
  })

  it('quotes a download filename without allowing quote or newline header injection', async () => {
    const { base, record } = await build()
    const attachment = saveAttachment(
      record.id,
      record.cwd,
      'bad"\r\nx-injected: yes.html',
      'text/html',
      Buffer.from('<p>download only</p>')
    )

    const response = await fetch(`${base}/api/sessions/${record.id}/attachments/${attachment.id}`)
    const disposition = response.headers.get('content-disposition')
    expect(disposition).toContain('attachment; filename="bad___x-injected_ yes.html"')
    expect(disposition).not.toMatch(/[\r\n]/)
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

  it('delivers Markdown, PDF, DOCX, and multi-sheet XLSX content to a Codex vendor payload', async () => {
    const { base, record, runTurn } = await build('codex')
    const markdownText = 'CODEX_MARKDOWN_ATTACHMENT'
    const pdfText = 'CODEX_PDF_ATTACHMENT'
    const workbookName = 'CODEX_WORKBOOK_ATTACHMENT.xlsx'
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
    const xlsxUpload = await fetch(`${base}/api/sessions/${record.id}/attachments`, {
      method: 'POST',
      headers: {
        'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'x-filename': workbookName,
      },
      body: new Uint8Array(twoSheetXlsx()),
    })
    const docxUpload = await fetch(`${base}/api/sessions/${record.id}/attachments`, {
      method: 'POST',
      headers: {
        'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'x-filename': 'brief.docx',
      },
      body: new Uint8Array(orderedDocx()),
    })

    expect(markdownUpload.status).toBe(200)
    expect(pdfUpload.status).toBe(200)
    expect(xlsxUpload.status).toBe(200)
    expect(docxUpload.status).toBe(200)
    const markdown = (await markdownUpload.json()) as AttachmentMeta
    const pdf = (await pdfUpload.json()) as AttachmentMeta
    const xlsx = (await xlsxUpload.json()) as AttachmentMeta
    const docx = (await docxUpload.json()) as AttachmentMeta
    const sent = await fetch(`${base}/api/sessions/${record.id}/input`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'Use all documents',
        attachments: [markdown.id, pdf.id, xlsx.id, docx.id],
      }),
    })

    expect(sent.status).toBe(200)
    const attachments = runTurn.mock.calls.at(-1)?.[3]
    expect(attachments).toEqual([markdown, pdf, xlsx, docx])
    const client = new CodexClient('unused', vi.fn())
    const request = vi.spyOn(client, 'request').mockResolvedValue(undefined)
    await client.sendTurn('thread-1', 'Use all documents', {}, attachments)
    const payload = request.mock.calls.at(-1)?.[1]
    const vendorText = (payload as { input: Array<{ text?: string }> }).input
      .map((item) => item.text ?? '')
      .join('\n')
    expect(vendorText).toContain(markdownText)
    expect(vendorText).toContain(pdfText)
    expect(vendorText).toContain('# Sheet: Inventory')
    expect(vendorText).toContain('Product,Qty')
    expect(vendorText).toContain('"Comma, item",5')
    expect(vendorText).toContain('# Sheet: Forecast')
    expect(vendorText).toContain('Month,Revenue')
    expect(vendorText).toContain('Feb,1250')
    expect(vendorText).toContain(',,Rich Text')
    expect(vendorText).toContain('DOCX_FIRST_RUN\tSECOND_RUN')
    expect(vendorText).toContain('DOCX_SECOND_PARAGRAPH')
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

  it('rejects a malformed Office archive instead of accepting an undeliverable attachment', async () => {
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
      error: expect.stringMatching(/Could not extract DOCX.*invalid or unsupported Office ZIP archive/i),
    })
  })

  it('rejects an Office ZIP whose selected XML expands beyond the independent safety cap', async () => {
    const { base, record } = await build('codex')
    const archive = Buffer.from(
      zipSync(
        { 'word/document.xml': new Uint8Array(25 * 1024 * 1024 + 1).fill(65) },
        { level: 9 }
      )
    )
    expect(archive.length).toBeLessThan(10 * 1024 * 1024)
    const upload = await fetch(`${base}/api/sessions/${record.id}/attachments`, {
      method: 'POST',
      headers: {
        'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'x-filename': 'zip-bomb.docx',
      },
      body: new Uint8Array(archive),
    })

    expect(upload.status).toBe(400)
    await expect(upload.json()).resolves.toEqual({
      error: expect.stringMatching(/Office XML expands beyond the .* safety limit/i),
    })
  })

  it('rejects an XLSX with an absurd declared dimension before allocating its claimed width', () => {
    const started = performance.now()
    expect(() => extractXlsxText(dimensionXlsx())).toThrow(/dimension|column|limit/i)
    expect(performance.now() - started).toBeLessThan(500)
  })

  it('validates but never allocates from a maximum legal XLSX dimension claim', () => {
    const started = performance.now()
    expect(extractXlsxText(dimensionXlsx('A1:XFD1048576', 'A1'))).toBe('# Sheet: Hostile\n1')
    expect(performance.now() - started).toBeLessThan(500)
  })

  it('rejects an Office archive with an excessive entry count', () => {
    const files: Record<string, Uint8Array> = {
      'xl/workbook.xml': strToU8(
        '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
        '<sheet name="One" r:id="rId1"/></sheets></workbook>'
      ),
      'xl/_rels/workbook.xml.rels': strToU8(
        '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'
      ),
      'xl/worksheets/sheet1.xml': strToU8('<worksheet><sheetData/></worksheet>'),
    }
    for (let index = 0; index < 1_100; index += 1) {
      files[`unused/entry-${index}.xml`] = strToU8('<x/>')
    }
    const archive = Buffer.from(zipSync(files, { level: 6 }))

    expect(() => extractXlsxText(archive)).toThrow(/entr(?:y|ies).*limit/i)
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

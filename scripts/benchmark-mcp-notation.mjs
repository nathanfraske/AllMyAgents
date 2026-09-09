/**
 * Read-only, local-only research. Prints aggregate counts, never retained tool contents.
 * From apps/hub (tsx resolves there):
 * node --import tsx ../../scripts/benchmark-mcp-notation.mjs <db> <session> <max-seq> <isolated-deps-dir>
 * Isolated deps: @toon-format/toon@4.1.1, js-tiktoken@1.0.21, base64-js@1.5.1.
 * Install with --ignore-scripts outside the application's package/lockfile.
 * Token counts are named-tokenizer proxies, NOT GPT-6/Claude billing estimates.
 */
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { runAgentTool, AGENT_TOOLS, AGENT_TOOLS_INSTRUCTIONS } from '../apps/hub/src/agentToolCore.ts'
import { inputSchemaFor } from '../apps/hub/src/agentMcpServer.ts'
import { JournalBlobStore, JOURNAL_BLOB_KEY } from '../apps/hub/src/journalBlobStore.ts'

const [dbPath, session, maxSeqText, depsDir] = process.argv.slice(2)
const maxSeq = Number(maxSeqText)
if (!dbPath || !session || !depsDir || !Number.isSafeInteger(maxSeq) || maxSeq < 1) {
  throw new Error('Expected database, session, positive max-seq, isolated-deps-dir')
}
const baselineCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', windowsHide: true,
}).trim()
const localRequire = createRequire(new URL('../apps/hub/package.json', import.meta.url))
const researchRequire = createRequire(path.join(path.resolve(depsDir), 'package.json'))
const { encode, decode } = await import(pathToFileURL(researchRequire.resolve('@toon-format/toon')).href)
const { getEncoding } = researchRequire('js-tiktoken')
const encodings = ['o200k_base', 'cl100k_base'].map(name => [name, getEncoding(name)])
const Database = localRequire('better-sqlite3')
const db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 1000 })
let events
try {
  db.pragma('query_only=ON')
  events = db.prepare(`SELECT e.seq,e.ts,e.kind,e.payload
    FROM journal_session_event_index i JOIN events e ON e.seq=i.seq
    WHERE i.session=? AND i.seq<=? ORDER BY i.seq DESC LIMIT 20000`).all(session, maxSeq)
} finally { db.close() }
// No SQLite connection remains open while counting tokens or reading immutable blobs.
const blobs = new JournalBlobStore(path.join(path.dirname(path.resolve(dbPath)), 'journal-blobs'))
const limits = { eventRows: 20000, textBytes: 512 * 1024, blobBytes: 32 * 1024 * 1024 }
const skipped = { nonJson: 0, missingText: 0, overTextLimit: 0, blobBudget: 0, invalidShape: 0 }
let blobBytes = 0, hydratedBlobs = 0, calls = 0, roundTrips = 0, roundTripFailures = 0
let encodeMs = 0, encodeCount = 0
const groups = new Map()
const started = performance.now()
const instruction = 'Structured tool results may use TOON v4.1: indentation nests objects; arrays declare their length and shared column names. Preserve exact values; tool arguments remain JSON.'
const tokenCount = (enc, text) => enc.encode(text, [], []).length
const catalog = AGENT_TOOLS.map(tool => ({ name: tool.name, description: tool.description, inputSchema: inputSchemaFor(tool) }))
const catalogCounts = {
  toolCount: catalog.length,
  note: 'Serialization proxy for the full exposed catalog, not evidence that every model request includes all tools.',
  tokenizers: Object.fromEntries(encodings.map(([name, enc]) => [name, {
    compactCatalog: tokenCount(enc, JSON.stringify(catalog)),
    sharedInstructions: tokenCount(enc, AGENT_TOOLS_INSTRUCTIONS),
  }])),
}
// Cache avoids measuring repeated polls repeatedly; totals still count EVERY occurrence.
const measurements = new Map()

function measure(groupName, value, recorded) {
  const compact = JSON.stringify(value)
  const cacheKey = compact + '\u0000' + recorded
  let measured = measurements.get(cacheKey)
  if (!measured) {
    const texts = { recorded, compactJson: compact }
    const t0 = performance.now()
    texts.toon = encode(value)
    texts.toonTab = encode(value, { delimiter: '\t' })
    encodeMs += performance.now() - t0
    encodeCount += 2
    for (const format of ['toon', 'toonTab']) {
      roundTrips++
      try {
        if (!isDeepStrictEqual(decode(texts[format]), value)) roundTripFailures++
      } catch { roundTripFailures++ }
    }
    // Include a per-response label as well as counting bare TOON.
    texts.toonLabeled = 'TOON v4.1\n' + texts.toon
    measured = Object.fromEntries(encodings.map(([name, enc]) => [name,
      Object.fromEntries(Object.entries(texts).map(([format, text]) => [format, tokenCount(enc, text)])),
    ]))
    if (measurements.size < 4096) measurements.set(cacheKey, measured)
  }
  let group = groups.get(groupName)
  if (!group) {
    group = { count: 0, bytes: 0, tokenizers: Object.fromEntries(encodings.map(([name]) => [name, {
      totals: { recorded: 0, compactJson: 0, toon: 0, toonTab: 0, toonLabeled: 0 },
      toonSmallerThanCompact: 0, toonLargerThanCompact: 0,
    }])) }
    groups.set(groupName, group)
  }
  group.count++
  group.bytes += Buffer.byteLength(recorded)
  for (const [name, counts] of Object.entries(measured)) {
    const target = group.tokenizers[name]
    for (const [format, count] of Object.entries(counts)) target.totals[format] += count
    if (counts.toon < counts.compactJson) target.toonSmallerThanCompact++
    if (counts.toon > counts.compactJson) target.toonLargerThanCompact++
  }
}

// JSON-data edge cases: no semantic rewriting, field removal, or log truncation by encoding.
const edgeCases = [
  null, {}, [], true, 0, '001',
  { rows: [{ id: '001', absent: null }, { id: '002', absent: '' }] },
  { rows: [{ a: 1 }, { a: 2, b: false }], empty: [], nested: { array: [null, '', {}, []] } },
  { 'punctuation:[]{},': 'line one\nline two\r\n\ttab | comma, "quote" \\ slash',
    path: 'C:\\Users\\Admin\\project', unicode: 'λ 日本語 🙂', numeric: '1e3', keyword: 'null' },
  JSON.parse('{"__proto__":{"benign":true},"constructor":"literal","control":"\\u0000\\u001b"}'),
]
for (const value of edgeCases) {
  for (const options of [{}, { delimiter: '\t' }]) {
    roundTrips++
    try { if (!isDeepStrictEqual(decode(encode(value, options)), value)) roundTripFailures++ }
    catch { roundTripFailures++ }
  }
}

for (const event of events) {
  if (event.kind !== 'codex/item/completed') continue
  const item = JSON.parse(event.payload).item
  if (item?.type !== 'mcpToolCall') continue
  calls++
  let text = item.result?.content?.find(c => c.type === 'text')?.text
  // Hydrate only the response string, only within explicit individual/total byte bounds.
  const ref = text && typeof text === 'object' ? text[JOURNAL_BLOB_KEY] : null
  if (ref) {
    if (!Number.isSafeInteger(ref.bytes) || ref.bytes > limits.textBytes) { skipped.overTextLimit++; continue }
    if (blobBytes + ref.bytes > limits.blobBytes) { skipped.blobBudget++; continue }
    blobBytes += ref.bytes
    ;[text] = await blobs.decodeManyAsync([text])
    hydratedBlobs++
  }
  if (typeof text !== 'string') { skipped.missingText++; continue }
  if (Buffer.byteLength(text) > limits.textBytes) { skipped.overTextLimit++; continue }
  let value
  try { value = JSON.parse(text) } catch { skipped.nonJson++; continue }
  if (value === null || typeof value !== 'object') { skipped.invalidShape++; continue }
  measure('retained/' + item.tool, value, text)
  if (item.tool === 'inspect_runs' && Array.isArray(value.runs)) {
    const result = await runAgentTool('inspect_runs', item.arguments, {
      identity: { sessionId: session, profileId: 'codex-a', provider: 'codex', label: 'manager' },
      services: { inspectRuns: () => ({ ok: true, ...value }) },
    })
    if (typeof result !== 'string') throw new Error('Expected text from current inspect_runs')
    measure('current/inspect_runs', JSON.parse(result), result)
  }
}

// Positive control is deliberately separate from actual manager traffic.
const flatRuns = { runs: Array.from({ length: 20 }, (_, i) => ({
  id: `run-${i + 1}`, project: 'example', agent: `worker-${i % 4}`,
  state: i % 3 === 0 ? 'running' : 'succeeded', elapsedSeconds: 30 + i,
  exitCode: i % 3 === 0 ? null : 0,
})) }
measure('synthetic/flat_run_list', flatRuns, JSON.stringify(flatRuns))

console.log(JSON.stringify({
  baselineCommit, session, maxSeq, eventRows: events.length,
  from: events.at(-1)?.ts, to: events[0]?.ts, calls, limits, skipped,
  hydratedBlobs, blobBytes, roundTrips, roundTripFailures,
  tokenizerCaveat: 'o200k_base and cl100k_base are proxies, not current GPT-6/Claude billing tokenizers; result-body counts only, not context re-reads or request schemas.',
  instructionTokensOncePerRequest: Object.fromEntries(encodings.map(([name, enc]) => [name, tokenCount(enc, instruction)])),
  catalogCounts,
  encodeCount, encodeMs, wallMs: performance.now() - started,
  groups: Object.fromEntries(groups),
}, null, 2))
if (roundTripFailures > 0) process.exitCode = 1

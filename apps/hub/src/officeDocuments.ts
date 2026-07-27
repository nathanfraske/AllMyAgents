import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { unzipSync, type UnzipFileInfo } from 'fflate'

const MAX_OFFICE_XML_BYTES = 25 * 1024 * 1024
const MAX_OFFICE_TEXT_BYTES = 20 * 1024 * 1024
const MAX_OFFICE_ZIP_ENTRIES = 1_024
const MAX_OFFICE_PARSE_MS = 1_500
const MAX_XLSX_SHEETS = 256
const MAX_XLSX_SHARED_STRINGS = 250_000
const MAX_XLSX_ROWS = 100_000
const MAX_XLSX_CELLS = 250_000
const XLSX_MAX_ROW = 1_048_576
const XLSX_MAX_COLUMN = 16_384

export class OfficeExtractionError extends Error {}

class ExtractionBudget {
  readonly startedAt = performance.now()
  private textBytes = 0

  check(stage: string): void {
    if (performance.now() - this.startedAt > MAX_OFFICE_PARSE_MS) {
      throw new OfficeExtractionError(
        `Office extraction exceeded the ${MAX_OFFICE_PARSE_MS}ms time limit while ${stage}`
      )
    }
  }

  reserveText(value: string, label: string): void {
    this.check(label)
    this.textBytes += Buffer.byteLength(value, 'utf8')
    if (this.textBytes > MAX_OFFICE_TEXT_BYTES) {
      throw new OfficeExtractionError(
        `Office text construction exceeds the ${MAX_OFFICE_TEXT_BYTES}-byte safety limit`
      )
    }
  }
}

function xmlText(value: string): string {
  return value.replace(
    /&#(?:x([0-9a-f]+)|([0-9]+));|&(lt|gt|quot|apos|amp);/gi,
    (entity, hex: string | undefined, decimal: string | undefined, named: string | undefined) => {
      if (hex || decimal) {
        const point = Number.parseInt(hex ?? decimal ?? '', hex ? 16 : 10)
        if (!Number.isSafeInteger(point) || point < 0 || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) {
          return '\ufffd'
        }
        return String.fromCodePoint(point)
      }
      return ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' })[named!.toLowerCase()]!
    }
  )
}

function attribute(tag: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag)
  return match ? xmlText(match[1] ?? match[2] ?? '') : undefined
}

function decodeEntry(entries: Record<string, Uint8Array>, name: string): string {
  const bytes = entries[name]
  if (!bytes) throw new OfficeExtractionError(`required Office part is missing: ${name}`)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new OfficeExtractionError(`Office XML part is not valid UTF-8: ${name}`)
  }
}

function officeEntries(
  bytes: Buffer,
  wanted: (name: string) => boolean
): { entries: Record<string, Uint8Array>; budget: ExtractionBudget } {
  const budget = new ExtractionBudget()
  let declaredBytes = 0
  let tooLarge = false
  let entryCount = 0
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(bytes, {
      filter(file: UnzipFileInfo) {
        budget.check('scanning ZIP entries')
        entryCount += 1
        if (entryCount > MAX_OFFICE_ZIP_ENTRIES) {
          throw new OfficeExtractionError(
            `Office archive entry count exceeds the ${MAX_OFFICE_ZIP_ENTRIES}-entry limit`
          )
        }
        const name = file.name.replaceAll('\\', '/')
        if (!wanted(name)) return false
        if (!Number.isSafeInteger(file.originalSize) || file.originalSize < 0) {
          tooLarge = true
          return false
        }
        declaredBytes += file.originalSize
        if (declaredBytes > MAX_OFFICE_XML_BYTES) {
          tooLarge = true
          return false
        }
        return true
      },
    })
  } catch (err) {
    if (err instanceof OfficeExtractionError) throw err
    const detail = err instanceof Error ? err.message : String(err)
    throw new OfficeExtractionError(`invalid or unsupported Office ZIP archive: ${detail}`)
  }
  budget.check('decompressing ZIP entries')
  if (tooLarge) {
    throw new OfficeExtractionError(
      `Office XML expands beyond the ${MAX_OFFICE_XML_BYTES}-byte safety limit`
    )
  }
  const normalized = Object.fromEntries(
    Object.entries(entries).map(([name, value]) => [name.replaceAll('\\', '/'), value])
  )
  const actualBytes = Object.values(normalized).reduce((sum, value) => sum + value.byteLength, 0)
  if (actualBytes > MAX_OFFICE_XML_BYTES) {
    throw new OfficeExtractionError(
      `Office XML expands beyond the ${MAX_OFFICE_XML_BYTES}-byte safety limit`
    )
  }
  return { entries: normalized, budget }
}

function textRuns(xml: string, budget: ExtractionBudget, label: string): string {
  const chunks: string[] = []
  for (const match of xml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi)) {
    const raw = match[1] ?? ''
    budget.reserveText(raw, label)
    chunks.push(xmlText(raw))
  }
  budget.check(label)
  return chunks.join('')
}

export function extractDocxText(bytes: Buffer): string {
  const { entries, budget } = officeEntries(bytes, (name) => name === 'word/document.xml')
  const document = decodeEntry(entries, 'word/document.xml')
  const chunks: string[] = []
  const tokens = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/?>|<w:(?:br|cr)\b[^>]*\/?>|<\/w:p\s*>/gi
  for (const match of document.matchAll(tokens)) {
    budget.check('extracting DOCX text')
    const token = match[0].toLowerCase()
    const raw = match[1]
    const text = raw !== undefined ? xmlText(raw) : token.startsWith('<w:tab') ? '\t' : '\n'
    budget.reserveText(raw ?? text, 'constructing DOCX text')
    chunks.push(text)
  }
  const text = chunks.join('').replace(/\n{3,}/g, '\n\n').trim()
  if (!text) throw new OfficeExtractionError('DOCX contains no readable text in word/document.xml')
  budget.check('finishing DOCX text')
  return text
}

function worksheetTarget(target: string): string {
  const normalized = target.startsWith('/')
    ? path.posix.normalize(target.slice(1))
    : path.posix.normalize(path.posix.join('xl', target))
  if (!normalized.startsWith('xl/worksheets/') || normalized.includes('../')) {
    throw new OfficeExtractionError(`worksheet relationship escapes xl/worksheets: ${target}`)
  }
  return normalized
}

function cellCoordinates(reference: string, label: string): { column: number; row: number } {
  const match = /^([a-z]{1,3})([1-9]\d{0,6})$/i.exec(reference)
  if (!match) throw new OfficeExtractionError(`${label} has an invalid cell reference: ${reference}`)
  const letters = match[1]!
  let index = 0
  for (const letter of letters.toUpperCase()) index = index * 26 + letter.charCodeAt(0) - 64
  const row = Number.parseInt(match[2]!, 10)
  if (index < 1 || index > XLSX_MAX_COLUMN) {
    throw new OfficeExtractionError(
      `${label} column exceeds the XLSX ${XLSX_MAX_COLUMN}-column limit: ${reference}`
    )
  }
  if (!Number.isSafeInteger(row) || row < 1 || row > XLSX_MAX_ROW) {
    throw new OfficeExtractionError(
      `${label} row exceeds the XLSX ${XLSX_MAX_ROW}-row limit: ${reference}`
    )
  }
  return { column: index - 1, row }
}

function columnIndex(reference: string | undefined, fallback: number): number {
  if (reference === undefined) {
    if (fallback >= XLSX_MAX_COLUMN) {
      throw new OfficeExtractionError(`worksheet row exceeds the XLSX ${XLSX_MAX_COLUMN}-column limit`)
    }
    return fallback
  }
  return cellCoordinates(reference, 'worksheet cell').column
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value
}

function validateWorksheetDimension(xml: string): void {
  const tag = /<dimension\b([^>]*)\/?>/i.exec(xml)
  if (!tag) return
  const reference = attribute(tag[1] ?? '', 'ref')
  if (!reference) throw new OfficeExtractionError('worksheet dimension is missing its ref')
  const parts = reference.split(':')
  if (parts.length < 1 || parts.length > 2 || parts.some((part) => !part)) {
    throw new OfficeExtractionError(`worksheet dimension has an invalid range: ${reference}`)
  }
  const first = cellCoordinates(parts[0]!, 'worksheet dimension')
  const last = cellCoordinates(parts.at(-1)!, 'worksheet dimension')
  if (first.column > last.column || first.row > last.row) {
    throw new OfficeExtractionError(`worksheet dimension is reversed: ${reference}`)
  }
  // A dimension is only a claim about the used range. Never allocate rows/columns from it; actual cells
  // below remain the sole source of CSV width so a tiny workbook cannot pin the hub with a huge declaration.
}

type XlsxCounts = {
  sheets: number
  sharedStrings: number
  rows: number
  cells: number
}

function worksheetCsv(
  xml: string,
  sharedStrings: readonly string[],
  budget: ExtractionBudget,
  counts: XlsxCounts
): string {
  validateWorksheetDimension(xml)
  const lines: string[] = []
  for (const rowMatch of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/gi)) {
    budget.check('extracting XLSX rows')
    counts.rows += 1
    if (counts.rows > MAX_XLSX_ROWS) {
      throw new OfficeExtractionError(`XLSX row count exceeds the ${MAX_XLSX_ROWS}-row safety limit`)
    }
    const rowNumber = attribute(rowMatch[1] ?? '', 'r')
    if (rowNumber !== undefined) {
      const parsed = Number.parseInt(rowNumber, 10)
      if (!/^[1-9]\d*$/.test(rowNumber) || parsed > XLSX_MAX_ROW) {
        throw new OfficeExtractionError(`worksheet row exceeds the XLSX ${XLSX_MAX_ROW}-row limit`)
      }
    }
    const cells = new Map<number, string>()
    let nextColumn = 0
    for (const cellMatch of (rowMatch[2] ?? '').matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/gi)) {
      budget.check('extracting XLSX cells')
      counts.cells += 1
      if (counts.cells > MAX_XLSX_CELLS) {
        throw new OfficeExtractionError(`XLSX cell count exceeds the ${MAX_XLSX_CELLS}-cell safety limit`)
      }
      const attrs = cellMatch[1] ?? cellMatch[3] ?? ''
      const body = cellMatch[2] ?? ''
      const index = columnIndex(attribute(attrs, 'r'), nextColumn)
      nextColumn = index + 1
      const type = attribute(attrs, 't')
      const raw = /<v\b[^>]*>([\s\S]*?)<\/v>/i.exec(body)?.[1]
      let value = ''
      if (type === 's' && raw !== undefined) {
        const sharedIndex = Number.parseInt(raw, 10)
        if (!Number.isSafeInteger(sharedIndex) || sharedStrings[sharedIndex] === undefined) {
          throw new OfficeExtractionError(`worksheet references missing shared string ${raw}`)
        }
        value = sharedStrings[sharedIndex]!
      } else if (type === 'inlineStr') {
        value = textRuns(body, budget, 'constructing inline XLSX text')
      } else if (raw !== undefined) {
        budget.reserveText(raw, 'constructing XLSX cell text')
        value = xmlText(raw)
      }
      if (type === 'b') {
        value = value === '1' ? 'TRUE' : 'FALSE'
      } else if (!value) {
        const formula = /<f\b[^>]*>([\s\S]*?)<\/f>/i.exec(body)?.[1]
        if (formula) {
          budget.reserveText(formula, 'constructing XLSX formula text')
          value = `=${xmlText(formula)}`
        }
      }
      cells.set(index, value)
    }
    let lastColumn = -1
    for (const index of cells.keys()) lastColumn = Math.max(lastColumn, index)
    const row = Array.from({ length: lastColumn + 1 }, (_, index) => csvCell(cells.get(index) ?? ''))
    const line = row.join(',')
    budget.reserveText(`${line}\n`, 'constructing XLSX CSV')
    lines.push(line)
  }
  budget.check('finishing XLSX worksheet')
  return lines.join('\n')
}

export function extractXlsxText(bytes: Buffer): string {
  const { entries, budget } = officeEntries(
    bytes,
    (name) =>
      name === 'xl/workbook.xml' ||
      name === 'xl/_rels/workbook.xml.rels' ||
      name === 'xl/sharedStrings.xml' ||
      /^xl\/worksheets\/[^/]+\.xml$/i.test(name)
  )
  const workbook = decodeEntry(entries, 'xl/workbook.xml')
  const relationships = decodeEntry(entries, 'xl/_rels/workbook.xml.rels')
  const sharedXml = entries['xl/sharedStrings.xml']
    ? decodeEntry(entries, 'xl/sharedStrings.xml')
    : ''
  const counts: XlsxCounts = { sheets: 0, sharedStrings: 0, rows: 0, cells: 0 }
  const sharedStrings: string[] = []
  for (const match of sharedXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gi)) {
    budget.check('extracting XLSX shared strings')
    counts.sharedStrings += 1
    if (counts.sharedStrings > MAX_XLSX_SHARED_STRINGS) {
      throw new OfficeExtractionError(
        `XLSX shared-string count exceeds the ${MAX_XLSX_SHARED_STRINGS}-string safety limit`
      )
    }
    sharedStrings.push(textRuns(match[1] ?? '', budget, 'constructing XLSX shared strings'))
  }
  const relationshipTargets = new Map<string, string>()
  for (const match of relationships.matchAll(/<Relationship\b([^>]*)\/?>/gi)) {
    budget.check('reading XLSX relationships')
    const id = attribute(match[1] ?? '', 'Id')
    const type = attribute(match[1] ?? '', 'Type')
    const target = attribute(match[1] ?? '', 'Target')
    if (id && target && type?.endsWith('/worksheet')) relationshipTargets.set(id, worksheetTarget(target))
  }

  const sections: string[] = []
  for (const match of workbook.matchAll(/<sheet\b([^>]*)\/?>/gi)) {
    budget.check('reading XLSX sheets')
    counts.sheets += 1
    if (counts.sheets > MAX_XLSX_SHEETS) {
      throw new OfficeExtractionError(`XLSX sheet count exceeds the ${MAX_XLSX_SHEETS}-sheet safety limit`)
    }
    const attrs = match[1] ?? ''
    const name = attribute(attrs, 'name')
    const relationshipId = attribute(attrs, 'r:id')
    if (!name || !relationshipId) throw new OfficeExtractionError('workbook contains a sheet without name/r:id')
    const target = relationshipTargets.get(relationshipId)
    if (!target) throw new OfficeExtractionError(`worksheet relationship is missing: ${relationshipId}`)
    const csv = worksheetCsv(decodeEntry(entries, target), sharedStrings, budget, counts)
    const section = `# Sheet: ${name}\n${csv || '(empty sheet)'}`
    budget.reserveText(`# Sheet: ${name}\n${csv ? '' : '(empty sheet)'}`, 'constructing XLSX sheet sections')
    sections.push(section)
  }
  if (!sections.length) throw new OfficeExtractionError('XLSX contains no worksheets')
  const text = sections.join('\n\n')
  budget.check('finishing XLSX text')
  return text
}

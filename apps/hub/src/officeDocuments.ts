import path from 'node:path'
import { strFromU8, unzipSync, type UnzipFileInfo } from 'fflate'

const MAX_OFFICE_XML_BYTES = 25 * 1024 * 1024
const MAX_OFFICE_TEXT_BYTES = 20 * 1024 * 1024

export class OfficeExtractionError extends Error {}

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

function officeEntries(bytes: Buffer, wanted: (name: string) => boolean): Record<string, Uint8Array> {
  let declaredBytes = 0
  let tooLarge = false
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(bytes, {
      filter(file: UnzipFileInfo) {
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
    const detail = err instanceof Error ? err.message : String(err)
    throw new OfficeExtractionError(`invalid or unsupported Office ZIP archive: ${detail}`)
  }
  if (tooLarge) {
    throw new OfficeExtractionError(
      `Office XML expands beyond the ${MAX_OFFICE_XML_BYTES}-byte safety limit`
    )
  }
  return Object.fromEntries(
    Object.entries(entries).map(([name, value]) => [name.replaceAll('\\', '/'), value])
  )
}

function textRuns(xml: string): string {
  let text = ''
  for (const match of xml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi)) text += xmlText(match[1] ?? '')
  return text
}

export function extractDocxText(bytes: Buffer): string {
  const entries = officeEntries(bytes, (name) => name === 'word/document.xml')
  const document = decodeEntry(entries, 'word/document.xml')
  let text = ''
  const tokens = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/?>|<w:(?:br|cr)\b[^>]*\/?>|<\/w:p\s*>/gi
  for (const match of document.matchAll(tokens)) {
    const token = match[0].toLowerCase()
    if (match[1] !== undefined) text += xmlText(match[1])
    else if (token.startsWith('<w:tab')) text += '\t'
    else text += '\n'
  }
  text = text.replace(/\n{3,}/g, '\n\n').trim()
  if (!text) throw new OfficeExtractionError('DOCX contains no readable text in word/document.xml')
  if (Buffer.byteLength(text, 'utf8') > MAX_OFFICE_TEXT_BYTES) {
    throw new OfficeExtractionError(`DOCX text exceeds the ${MAX_OFFICE_TEXT_BYTES}-byte safety limit`)
  }
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

function columnIndex(reference: string | undefined, fallback: number): number {
  const letters = /^([a-z]+)\d+$/i.exec(reference ?? '')?.[1]
  if (!letters) return fallback
  let index = 0
  for (const letter of letters.toUpperCase()) index = index * 26 + letter.charCodeAt(0) - 64
  return index - 1
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value
}

function worksheetCsv(xml: string, sharedStrings: readonly string[]): string {
  const lines: string[] = []
  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/gi)) {
    const cells = new Map<number, string>()
    let nextColumn = 0
    for (const cellMatch of (rowMatch[1] ?? '').matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/gi)) {
      const attrs = cellMatch[1] ?? cellMatch[3] ?? ''
      const body = cellMatch[2] ?? ''
      const index = columnIndex(attribute(attrs, 'r'), nextColumn)
      nextColumn = index + 1
      const type = attribute(attrs, 't')
      const raw = /<v\b[^>]*>([\s\S]*?)<\/v>/i.exec(body)?.[1]
      let value = raw === undefined ? '' : xmlText(raw)
      if (type === 's' && raw !== undefined) {
        const sharedIndex = Number.parseInt(raw, 10)
        if (!Number.isSafeInteger(sharedIndex) || sharedStrings[sharedIndex] === undefined) {
          throw new OfficeExtractionError(`worksheet references missing shared string ${raw}`)
        }
        value = sharedStrings[sharedIndex]!
      } else if (type === 'inlineStr') {
        value = textRuns(body)
      } else if (type === 'b') {
        value = value === '1' ? 'TRUE' : 'FALSE'
      } else if (!value) {
        const formula = /<f\b[^>]*>([\s\S]*?)<\/f>/i.exec(body)?.[1]
        if (formula) value = `=${xmlText(formula)}`
      }
      cells.set(index, value)
    }
    const lastColumn = cells.size ? Math.max(...cells.keys()) : -1
    const row = Array.from({ length: lastColumn + 1 }, (_, index) => csvCell(cells.get(index) ?? ''))
    lines.push(row.join(','))
  }
  return lines.join('\n')
}

export function extractXlsxText(bytes: Buffer): string {
  const entries = officeEntries(
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
  const sharedStrings = [...sharedXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gi)]
    .map((match) => textRuns(match[1] ?? ''))
  const relationshipTargets = new Map<string, string>()
  for (const match of relationships.matchAll(/<Relationship\b([^>]*)\/?>/gi)) {
    const id = attribute(match[1] ?? '', 'Id')
    const type = attribute(match[1] ?? '', 'Type')
    const target = attribute(match[1] ?? '', 'Target')
    if (id && target && type?.endsWith('/worksheet')) relationshipTargets.set(id, worksheetTarget(target))
  }

  const sections: string[] = []
  for (const match of workbook.matchAll(/<sheet\b([^>]*)\/?>/gi)) {
    const attrs = match[1] ?? ''
    const name = attribute(attrs, 'name')
    const relationshipId = attribute(attrs, 'r:id')
    if (!name || !relationshipId) throw new OfficeExtractionError('workbook contains a sheet without name/r:id')
    const target = relationshipTargets.get(relationshipId)
    if (!target) throw new OfficeExtractionError(`worksheet relationship is missing: ${relationshipId}`)
    const csv = worksheetCsv(decodeEntry(entries, target), sharedStrings)
    sections.push(`# Sheet: ${name}\n${csv || '(empty sheet)'}`)
  }
  if (!sections.length) throw new OfficeExtractionError('XLSX contains no worksheets')
  const text = sections.join('\n\n')
  if (Buffer.byteLength(text, 'utf8') > MAX_OFFICE_TEXT_BYTES) {
    throw new OfficeExtractionError(`XLSX text exceeds the ${MAX_OFFICE_TEXT_BYTES}-byte safety limit`)
  }
  return text
}

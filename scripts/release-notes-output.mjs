import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const tag = process.argv[2]?.trim()
if (!tag || !/^v\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u.test(tag)) {
  throw new Error('Usage: node scripts/release-notes-output.mjs <version-tag>')
}

const notesPath = path.resolve('docs', 'releases', `${tag}.md`)
const body = fs.readFileSync(notesPath, 'utf8').trim()
if (!body) throw new Error(`Release notes are empty: ${notesPath}`)

const outputPath = process.env.GITHUB_OUTPUT
if (!outputPath) {
  process.stdout.write(`${body}\n`)
  process.exit(0)
}

const delimiter = `AMA_RELEASE_NOTES_${crypto.randomBytes(12).toString('hex')}`
fs.appendFileSync(outputPath, `body<<${delimiter}\n${body}\n${delimiter}\n`, 'utf8')

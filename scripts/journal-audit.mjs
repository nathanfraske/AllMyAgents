#!/usr/bin/env node

import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'

const require = createRequire(new URL('../apps/hub/package.json', import.meta.url))
const Database = require('better-sqlite3')

function directoryBytes(root, seenFiles = new Set()) {
  if (!fs.existsSync(root)) return { files: 0, bytes: 0, uniqueBytes: 0, hardlinkedFiles: 0 }
  let files = 0
  let bytes = 0
  let uniqueBytes = 0
  let hardlinkedFiles = 0
  const pending = [root]
  while (pending.length) {
    const current = pending.pop()
    let entries = []
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const target = path.join(current, entry.name)
      if (entry.isDirectory()) pending.push(target)
      else if (entry.isFile()) {
        files += 1
        try {
          const stat = fs.statSync(target, { bigint: true })
          const size = Number(stat.size)
          bytes += size
          const identity = `${stat.dev}:${stat.ino}`
          if (!seenFiles.has(identity)) {
            seenFiles.add(identity)
            uniqueBytes += size
          }
          if (stat.nlink > 1n) hardlinkedFiles += 1
        } catch {
          // A rotating backup may disappear between readdir and stat; the next audit will see it.
        }
      }
    }
  }
  return { files, bytes, uniqueBytes, hardlinkedFiles }
}

function numeric(value) {
  return typeof value === 'bigint' ? Number(value) : Number(value ?? 0)
}

function formatBytes(value) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let amount = numeric(value)
  let unit = 0
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024
    unit += 1
  }
  return `${amount.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`
}

const flags = new Set(process.argv.slice(2).filter((arg) => arg.startsWith('--')))
const supplied = process.argv.slice(2).find((arg) => !arg.startsWith('--'))
const dataDir = process.env.HUB_DATA_DIR?.trim()
const dbPath = path.resolve(supplied ?? (dataDir ? path.join(dataDir, 'hub.db') : path.join(process.cwd(), 'data', 'hub.db')))
if (!fs.existsSync(dbPath)) {
  console.error(`Journal not found: ${dbPath}`)
  process.exit(2)
}

const db = new Database(dbPath, { readonly: true, fileMustExist: true })
db.pragma('query_only = ON')
const one = (sql) => db.prepare(sql).get()
const all = (sql) => db.prepare(sql).all()
const pageSize = numeric(one('PRAGMA page_size')?.page_size)
const pageCount = numeric(one('PRAGMA page_count')?.page_count)
const freePages = numeric(one('PRAGMA freelist_count')?.freelist_count)
let tables = []
if (!flags.has('--fast')) {
  try {
    tables = all('SELECT name, sum(pgsize) AS bytes, count(*) AS pages FROM dbstat GROUP BY name ORDER BY bytes DESC')
  } catch (error) {
    tables = [{ name: '(dbstat unavailable)', bytes: 0, pages: 0, error: error instanceof Error ? error.message : String(error) }]
  }
}

const fileBytes = fs.statSync(dbPath).size
const walPath = `${dbPath}-wal`
const parent = path.dirname(dbPath)
const retainedFiles = new Set()
const backups = directoryBytes(path.join(parent, 'backups'), retainedFiles)
const recovery = directoryBytes(path.join(parent, 'journal-recovery'), retainedFiles)
const report = {
  generatedAt: new Date().toISOString(),
  dbPath,
  storage: {
    fileBytes,
    walBytes: fs.existsSync(walPath) ? fs.statSync(walPath).size : 0,
    pageSize,
    pageCount,
    freePages,
    reusableBytes: freePages * pageSize,
    allocatedBytes: Math.max(0, fileBytes - freePages * pageSize),
    reusablePercent: pageCount > 0 ? Number(((freePages / pageCount) * 100).toFixed(2)) : 0,
    backups,
    recovery,
    retainedLogicalBytes: backups.bytes + recovery.bytes,
    retainedUniqueBytes: backups.uniqueBytes + recovery.uniqueBytes,
  },
  events: one(
    'SELECT count(*) AS count, count(DISTINCT session) AS sessions, min(ts) AS oldest, max(ts) AS newest, sum(length(payload)) AS payloadBytes FROM events',
  ),
  topKinds: all(
    'SELECT kind, count(*) AS count, sum(length(payload)) AS payloadBytes, round(avg(length(payload))) AS averageBytes, max(length(payload)) AS maximumBytes FROM events GROUP BY kind ORDER BY payloadBytes DESC LIMIT 30',
  ),
  recentDays: all(
    'SELECT substr(ts, 1, 10) AS day, count(*) AS count, sum(length(payload)) AS payloadBytes FROM events GROUP BY substr(ts, 1, 10) ORDER BY day DESC LIMIT 21',
  ),
  topSessions: all(
    'SELECT session, count(*) AS count, sum(length(payload)) AS payloadBytes FROM events GROUP BY session ORDER BY payloadBytes DESC LIMIT 20',
  ),
  largestPayloads: all(
    'SELECT seq, session, kind, ts, length(payload) AS payloadBytes FROM events ORDER BY length(payload) DESC LIMIT 20',
  ),
  maintenance: {
    runs: all('SELECT * FROM journal_compaction_runs ORDER BY updated_at DESC LIMIT 20'),
    transientIndex: all('SELECT * FROM journal_transient_index_state'),
    sessionIndex: all('SELECT * FROM journal_session_index_state'),
    replay: all('SELECT * FROM journal_replay_state'),
    sequence: one('SELECT min(seq) AS minimum, max(seq) AS maximum FROM events'),
  },
  tables,
  ...(flags.has('--check') ? { quickCheck: all('PRAGMA quick_check') } : {}),
}
db.close()

if (flags.has('--json')) {
  console.log(JSON.stringify(report, null, 2))
  process.exit(0)
}

console.log(`Journal: ${dbPath}`)
console.log(`Database: ${formatBytes(report.storage.fileBytes)} + WAL ${formatBytes(report.storage.walBytes)}`)
console.log(`Reusable pages: ${formatBytes(report.storage.reusableBytes)} (${report.storage.reusablePercent}%)`)
console.log(`Currently allocated DB pages: ${formatBytes(report.storage.allocatedBytes)}`)
console.log(`Events: ${numeric(report.events?.count).toLocaleString()} across ${numeric(report.events?.sessions).toLocaleString()} sessions`)
console.log(`Serialized event payloads: ${formatBytes(report.events?.payloadBytes)}`)
console.log(`Backups: ${report.storage.backups.files} files / ${formatBytes(report.storage.backups.bytes)} logical (${formatBytes(report.storage.backups.uniqueBytes)} unique)`)
console.log(`Recovery: ${report.storage.recovery.files} files / ${formatBytes(report.storage.recovery.bytes)} logical (${formatBytes(report.storage.recovery.uniqueBytes)} additional unique)`)
console.log(`Retained copies: ${formatBytes(report.storage.retainedLogicalBytes)} logical / ${formatBytes(report.storage.retainedUniqueBytes)} unique by file identity`)
console.log('\nLargest event kinds by serialized payload:')
for (const row of report.topKinds.slice(0, 15)) {
  console.log(`  ${String(row.kind).padEnd(42)} ${formatBytes(row.payloadBytes).padStart(11)}  ${numeric(row.count).toLocaleString().padStart(10)} events`)
}
console.log('\nRecent daily payload growth:')
for (const row of report.recentDays.slice(0, 14)) {
  console.log(`  ${row.day}  ${formatBytes(row.payloadBytes).padStart(11)}  ${numeric(row.count).toLocaleString().padStart(10)} events`)
}
if (flags.has('--check')) console.log(`\nQuick check: ${JSON.stringify(report.quickCheck)}`)

/**
 * One-shot journal maintenance child.
 *
 * The hub deliberately forks this instead of calling Journal.condenseCompletedCodex() from setInterval:
 * better-sqlite3 and JSON1 are synchronous, and the measured historical scan crosses hundreds of megabytes.
 * A periodic callback in index.ts would freeze HTTP/WS/worker ingestion while it scans. SQLite still has one
 * writer, so the Journal method also bounds each delete batch; this child keeps the longer read/JSON work off
 * the hub's JavaScript event loop. The same pass now rolls old terminal-bounded turns into old-client-readable
 * history cards. Keeping both stages here is important: after a month offline, the capped transient sweep gets
 * first refusal and an oversized turn is deferred instead of the history stage issuing one giant DELETE.
 */
import { Journal } from './journal.js'

type MaintenanceMessage =
  | {
      type: 'journal-condensed'
      result: ReturnType<Journal['condenseCompletedCodex']>
    }
  | { type: 'journal-condense-error'; error: string }

const [file, graceRaw, commandLimitRaw, diffLimitRaw] = process.argv.slice(2)

let message: MaintenanceMessage
let exitCode = 0
let journal: Journal | undefined
try {
  if (!file) throw new Error('journal database path is required')
  journal = new Journal(file)
  const result = journal.condenseCompletedCodex({
    graceMs: Number(graceRaw),
    maxCommandOutputDeltas: Number(commandLimitRaw),
    maxDiffSnapshots: Number(diffLimitRaw),
  })
  message = { type: 'journal-condensed', result }
} catch (error) {
  exitCode = 1
  message = { type: 'journal-condense-error', error: error instanceof Error ? error.message : String(error) }
} finally {
  journal?.db.close()
}

process.exitCode = exitCode
if (process.send) {
  process.send(message, () => process.disconnect?.())
} else if (message.type === 'journal-condensed') {
  console.log(JSON.stringify(message.result))
} else {
  console.error(message.error)
}

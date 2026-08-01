import path from 'node:path'
import {
  acceptKnownGoodJournal,
  inspectKnownGoodJournal,
} from './journalRecovery.js'
import { SCHEMA_VERSION } from './restartHandshake.js'

function valueAfter(flag: string): string | undefined {
  const index = process.argv.indexOf(flag)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function usage(): never {
  throw new Error(
    'Usage: journalRecoveryOperator --inspect|--accept --data-dir <directory> ' +
      '[--confirm <sha256> --reason <operator reason>]'
  )
}

const dataDirArg = valueAfter('--data-dir')
if (!dataDirArg) usage()
const dataDir = path.resolve(dataDirArg)
const journalPath = path.join(dataDir, 'hub.db')
const inspect = process.argv.includes('--inspect')
const accept = process.argv.includes('--accept')
if (inspect === accept) usage()

if (inspect) {
  const result = inspectKnownGoodJournal({
    dataDir,
    journalPath,
    maxSchemaVersion: SCHEMA_VERSION,
  })
  console.log(JSON.stringify(result, null, 2))
} else {
  const confirmSha256 = valueAfter('--confirm')
  const reason = valueAfter('--reason')
  if (!confirmSha256 || !reason) usage()
  const result = acceptKnownGoodJournal({
    dataDir,
    journalPath,
    maxSchemaVersion: SCHEMA_VERSION,
    confirmSha256,
    reason,
  })
  console.log(JSON.stringify(result, null, 2))
}

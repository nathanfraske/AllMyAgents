import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { resolveFromRoot } from './journal.js'

const arg = process.argv[2]
if (!arg) {
  console.error('Usage: pnpm --filter spikes exec tsx src/codex-models.ts <codex-home-dir>')
  process.exit(1)
}
const home = resolveFromRoot(arg)
if (home === path.join(os.homedir(), '.codex')) {
  console.error('[codex-models] refusing the default ~/.codex (owned by the desktop app).')
  process.exit(1)
}
if (!fs.existsSync(path.join(home, 'auth.json'))) {
  console.error(`[codex-models] no auth.json in ${home}.`)
  process.exit(1)
}

const child = spawn('codex app-server', { shell: true, env: { ...process.env, CODEX_HOME: home } })
let nextId = 1
const pending = new Map<number, string>()
const send = (m: Record<string, unknown>): void => void child.stdin.write(JSON.stringify(m) + '\n')
const request = (method: string, params?: unknown): void => {
  const id = nextId++
  pending.set(id, method)
  send(params === undefined ? { id, method } : { id, method, params })
}

let remaining = 0
const rl = readline.createInterface({ input: child.stdout })
rl.on('line', (line) => {
  if (!line.trim()) return
  let msg: any
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (msg.id !== undefined && msg.method === undefined) {
    const method = pending.get(msg.id)
    pending.delete(msg.id)
    if (method === 'initialize') {
      send({ method: 'initialized' })
      remaining = 3
      request('model/list', {})
      request('modelProvider/capabilities/read', {})
      request('collaborationMode/list', {})
      return
    }
    console.log(`\n===== ${method} =====`)
    console.log(JSON.stringify(msg.result ?? msg.error, null, 2))
    if (--remaining <= 0) {
      child.kill()
      setTimeout(() => process.exit(0), 200)
    }
  }
})
child.stderr.on('data', (d: Buffer) => process.stderr.write(`[stderr] ${d}`))
setTimeout(() => { console.error('[codex-models] timeout'); process.exit(1) }, 60_000)
request('initialize', { clientInfo: { name: 'aiagentapp-spike', title: 'Codex model probe', version: '0.0.1' } })

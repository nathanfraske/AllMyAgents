import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { appendEvent, resolveFromRoot } from './journal.js'

const arg = process.argv[2]
if (!arg) {
  console.error('Usage: pnpm spike:codex-usage <codex-home-dir>')
  process.exit(1)
}
const home = resolveFromRoot(arg)
if (home === path.join(os.homedir(), '.codex')) {
  console.error('[codex-usage] refusing the default ~/.codex (owned by the desktop app).')
  process.exit(1)
}
if (!fs.existsSync(path.join(home, 'auth.json'))) {
  console.error(`[codex-usage] no auth.json in ${home}.`)
  process.exit(1)
}

const child = spawn('codex app-server', { shell: true, env: { ...process.env, CODEX_HOME: home } })

let nextId = 1
const pendingMethod = new Map<number, string>()
const send = (msg: Record<string, unknown>) => {
  appendEvent('codex-usage', { dir: 'out', msg })
  child.stdin.write(JSON.stringify(msg) + '\n')
}
const request = (method: string, params?: unknown) => {
  const id = nextId++
  pendingMethod.set(id, method)
  send(params === undefined ? { id, method } : { id, method, params })
}

let remaining = 0
const done = () => {
  if (--remaining <= 0) {
    child.kill()
    setTimeout(() => process.exit(0), 200)
  }
}

const rl = readline.createInterface({ input: child.stdout })
rl.on('line', (line) => {
  if (!line.trim()) return
  let msg: any
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  appendEvent('codex-usage', { dir: 'in', msg })
  if (msg.id !== undefined && msg.method === undefined) {
    const method = pendingMethod.get(msg.id)
    pendingMethod.delete(msg.id)
    if (method === 'initialize') {
      send({ method: 'initialized' })
      remaining = 3
      request('account/read', {})
      request('account/rateLimits/read', {})
      request('account/tokenUsage/read', {})
      return
    }
    console.log(`\n=== ${method} ===`)
    console.log(JSON.stringify(msg.result ?? msg.error, null, 2))
    done()
  }
})

child.stderr.on('data', (d: Buffer) => process.stderr.write(`[stderr] ${d}`))
setTimeout(() => { console.error('[codex-usage] timeout'); process.exit(1) }, 60_000)

request('initialize', { clientInfo: { name: 'aiagentapp-spike', title: 'AiAgentApp usage probe', version: '0.0.1' } })

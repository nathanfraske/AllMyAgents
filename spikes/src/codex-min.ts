import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { appendEvent, resolveFromRoot } from './journal.js'

const arg = process.argv[2]
if (!arg) {
  console.error('Usage: pnpm spike:codex <codex-home-dir>   e.g. pnpm spike:codex profiles/codex-a')
  console.error('A fresh profile is required: the Codex desktop app owns ~/.codex, and Codex refresh tokens are single-use — a second consumer of that auth chain can invalidate the desktop login.')
  process.exit(1)
}
const home = resolveFromRoot(arg)
if (home === path.join(os.homedir(), '.codex')) {
  console.error('[codex-min] refusing to run against the default ~/.codex (owned by the Codex desktop app).')
  process.exit(1)
}
if (!fs.existsSync(path.join(home, 'auth.json'))) {
  console.error(`[codex-min] no auth.json in ${home}. Run: pnpm login:codex ${arg}`)
  process.exit(1)
}

console.log(`[codex-min] starting codex app-server with CODEX_HOME=${home}`)
const child = spawn('codex app-server', {
  shell: true,
  env: { ...process.env, CODEX_HOME: home },
})

let nextId = 1
const pendingMethod = new Map<number, string>()

function send(msg: Record<string, unknown>): void {
  appendEvent('codex-min', { dir: 'out', msg })
  child.stdin.write(JSON.stringify(msg) + '\n')
}

function request(method: string, params?: unknown): void {
  const id = nextId++
  pendingMethod.set(id, method)
  send(params === undefined ? { id, method } : { id, method, params })
}

function summarize(value: unknown): string {
  const s = JSON.stringify(value ?? {})
  return s.length > 220 ? s.slice(0, 220) + '…' : s
}

let finished = false
function finish(code: number): void {
  if (finished) return
  finished = true
  console.log('[codex-min] done — full wire log in journal/codex-min.jsonl')
  child.kill()
  setTimeout(() => process.exit(code), 200)
}

let threadId: string | undefined

const rl = readline.createInterface({ input: child.stdout })
rl.on('line', (line) => {
  if (!line.trim()) return
  let msg: any
  try {
    msg = JSON.parse(line)
  } catch {
    console.log('[raw]', line)
    return
  }
  appendEvent('codex-min', { dir: 'in', msg })

  const isResponse = msg.id !== undefined && msg.method === undefined
  const isServerRequest = msg.id !== undefined && msg.method !== undefined

  if (isResponse) {
    const method = pendingMethod.get(msg.id)
    pendingMethod.delete(msg.id)
    console.log(`[response:${method}]`, summarize(msg.result ?? msg.error))
    if (msg.error) {
      finish(1)
    } else if (method === 'initialize') {
      send({ method: 'initialized' })
      request('thread/start', { cwd: process.cwd() })
    } else if (method === 'thread/start') {
      threadId = msg.result?.threadId ?? msg.result?.thread?.id
      if (!threadId) {
        console.error('[codex-min] no thread id found in thread/start result — inspect the journal for the actual shape')
        finish(1)
        return
      }
      request('turn/start', { threadId, input: [{ type: 'text', text: 'Reply with exactly: hub spike ok' }] })
    }
    return
  }

  if (isServerRequest) {
    console.log(`[server-request:${msg.method}]`, summarize(msg.params))
    send({ id: msg.id, result: { decision: 'decline' } })
    return
  }

  console.log(`[notify:${msg.method}]`, summarize(msg.params))
  if (msg.method === 'turn/completed' || msg.method === 'turn/error') finish(0)
})

child.stderr.on('data', (d: Buffer) => process.stderr.write(`[codex stderr] ${d}`))
child.on('exit', (code) => {
  if (!finished) {
    console.error(`[codex-min] app-server exited early (code ${code})`)
    process.exit(1)
  }
})

setTimeout(() => {
  console.error('[codex-min] timed out after 180s')
  finish(1)
}, 180_000)

request('initialize', {
  clientInfo: { name: 'aiagentapp-spike', title: 'AiAgentApp spike', version: '0.0.1' },
})

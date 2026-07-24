import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { resolveFromRoot } from './journal.js'

const provider = process.argv[2]
const dirArg = process.argv[3]

if (provider !== 'claude' && provider !== 'codex') {
  console.error('Usage: pnpm login:claude <profile-dir>  |  pnpm login:codex <profile-dir>')
  console.error('Example: pnpm login:claude profiles/claude-a')
  process.exit(1)
}

const dir = resolveFromRoot(dirArg ?? `profiles/${provider}-a`)
fs.mkdirSync(dir, { recursive: true })

if (provider === 'claude') {
  console.log(`Opening an interactive Claude Code session with CLAUDE_CONFIG_DIR=${dir}`)
  console.log('Inside the session: run /login, finish the browser flow, then exit with /exit.')
  const res = spawnSync('claude', { shell: true, stdio: 'inherit', env: { ...process.env, CLAUDE_CONFIG_DIR: dir } })
  process.exit(res.status ?? 0)
} else {
  console.log(`Running codex login with CODEX_HOME=${dir}`)
  const res = spawnSync('codex login', { shell: true, stdio: 'inherit', env: { ...process.env, CODEX_HOME: dir } })
  process.exit(res.status ?? 0)
}

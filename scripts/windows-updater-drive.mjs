// Drive the installed Windows WebView2 through its DevTools endpoint and invoke the SAME native
// updater command the "Update now" button calls. This exists for the release durability workflow:
// UI-coordinate automation would make a process-lock regression look like a flaky click, while calling
// the Tauri command through the real installed webview preserves the product path from webview IPC
// through signature verification, MSI launch, process teardown, installation, and app relaunch.
//
// Usage:
//   node scripts/windows-updater-drive.mjs [remote-debugging-port]
//
// The workflow launches the installed app with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS set to the matching
// loopback-only remote-debugging port. Never expose that port beyond loopback.

const port = Number(process.argv[2] ?? 9333)
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error(`invalid WebView2 remote-debugging port: ${process.argv[2] ?? ''}`)
}

const endpoint = `http://127.0.0.1:${port}/json`
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function discoverTarget() {
  const deadline = Date.now() + 120_000
  let lastError
  while (Date.now() < deadline) {
    try {
      const response = await fetch(endpoint)
      if (!response.ok) throw new Error(`DevTools endpoint returned ${response.status}`)
      const targets = await response.json()
      const target = targets.find(
        (candidate) =>
          candidate.type === 'page' &&
          typeof candidate.webSocketDebuggerUrl === 'string' &&
          !String(candidate.url ?? '').startsWith('devtools:'),
      )
      if (target) return target
      lastError = new Error(`DevTools endpoint has no page target (${targets.length} target(s))`)
    } catch (error) {
      lastError = error
    }
    await sleep(500)
  }
  throw new Error(`installed WebView2 never exposed a page on ${endpoint}: ${lastError}`)
}

const target = await discoverTarget()
console.log(`driving installed webview: ${target.title || '(untitled)'} ${target.url || ''}`)

const socket = new WebSocket(target.webSocketDebuggerUrl)
const pending = new Map()
let sequence = 0
let closed = false
let closeResolve
const closedPromise = new Promise((resolve) => {
  closeResolve = resolve
})

socket.addEventListener('message', ({ data }) => {
  let message
  try {
    message = JSON.parse(String(data))
  } catch {
    return
  }
  if (!message.id) return
  const waiter = pending.get(message.id)
  if (!waiter) return
  pending.delete(message.id)
  if (message.error) waiter.reject(new Error(`CDP ${waiter.method} failed: ${JSON.stringify(message.error)}`))
  else waiter.resolve(message.result)
})
socket.addEventListener('close', () => {
  closed = true
  closeResolve()
  for (const waiter of pending.values()) {
    waiter.reject(new Error(`WebView2 closed while waiting for ${waiter.method}`))
  }
  pending.clear()
})

await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', () => reject(new Error('could not connect to WebView2 DevTools')), {
    once: true,
  })
})

function send(method, params = {}) {
  if (closed) return Promise.reject(new Error(`WebView2 closed before ${method}`))
  const id = ++sequence
  return new Promise((resolve, reject) => {
    pending.set(id, { method, resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
}

const invokeExpression = String.raw`
(() => {
  const invoke = globalThis.__TAURI__?.core?.invoke ?? globalThis.__TAURI_INTERNALS__?.invoke
  if (typeof invoke !== 'function') throw new Error('the installed page exposes no Tauri invoke bridge')
  globalThis.__AMA_UPDATE_RESULT__ = 'started'
  Promise.resolve(invoke('updater_install')).then(
    () => { globalThis.__AMA_UPDATE_RESULT__ = 'returned' },
    (error) => { globalThis.__AMA_UPDATE_RESULT__ = 'error:' + String(error) },
  )
  return 'invoked'
})()
`

const invoked = await send('Runtime.evaluate', {
  expression: invokeExpression,
  returnByValue: true,
})
const invokeValue = invoked?.result?.value
if (invokeValue !== 'invoked') {
  throw new Error(`updater invocation did not start: ${JSON.stringify(invoked)}`)
}
console.log('real updater_install command invoked')

const deadline = Date.now() + 180_000
while (Date.now() < deadline) {
  const outcome = await Promise.race([
    closedPromise.then(() => ({ closed: true })),
    sleep(500).then(() => ({ closed: false })),
  ])
  if (outcome.closed) {
    // On Windows the updater plugin launches msiexec and terminates the current app process. The
    // workflow now owns the important assertions: the MSI must replace the installed version, the
    // old bundled-Node processes must be gone, and the relaunched candidate must become healthy.
    console.log('installed webview closed for updater handoff')
    process.exit(0)
  }

  const result = await send('Runtime.evaluate', {
    expression: 'globalThis.__AMA_UPDATE_RESULT__',
    returnByValue: true,
  })
  const state = result?.result?.value
  if (typeof state === 'string' && state.startsWith('error:')) {
    throw new Error(state.slice('error:'.length))
  }
  if (state === 'returned') {
    throw new Error('updater_install returned without handing off to the Windows installer')
  }
}

throw new Error('updater_install neither failed nor handed off to the Windows installer within 180s')

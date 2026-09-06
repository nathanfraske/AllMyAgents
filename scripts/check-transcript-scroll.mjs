// Real Chromium wheel/scroll regression harness. Runs the actual ThreadView with synthetic history,
// no hub, credentials, provider calls or operator browser. Set SCROLL_BROWSER to a Chromium executable.
// node scripts/check-transcript-scroll.mjs [--diagnose]
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const web = path.join(root, 'apps/web')
const requireWeb = createRequire(path.join(web, 'package.json'))
const { createServer } = await import(pathToFileURL(requireWeb.resolve('vite')).href)
const { svelte } = await import(pathToFileURL(path.join(web, 'node_modules/@sveltejs/vite-plugin-svelte/src/index.js')).href)
const browserPath = process.env.SCROLL_BROWSER ?? [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/chromium', '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(existsSync)
assert(browserPath, 'Set SCROLL_BROWSER to a Chromium executable')
const profile = mkdtempSync(path.join(tmpdir(), 'ama-scroll-check-'))
const fixture = `
  import { mount, tick } from 'svelte';
  import ThreadView from '/src/lib/ThreadView.svelte';
  import { store } from '/src/lib/store.svelte.ts';
  import { api } from '/src/lib/api.ts';
  import '/src/app.css';
  for (const key of Object.keys(api)) api[key] = async () => [];
  api.workspaceDiff = async () => ({ baseRef: 'main', baseCommit: 'base', headCommit: 'head',
    files: [], untracked: [], patch: '', truncated: false });
  api.durableRuns = async () => ({ runs: [] });
  api.browserStatus = async () => ({ enabled: false, available: true, retainedProfile: false,
    publicOriginGrants: [], localNetworkEnabled: false, tabsEnabled: false, downloadsEnabled: false });
  store.ensureHistory = async () => {};
  const id = 'scroll-fixture';
  store.sessions = { [id]: {
    record: { id, profileId: 'fixture', provider: 'codex', status: 'idle',
      cwd: '/synthetic', createdAt: new Date().toISOString(), isProjectManager: true },
    items: Array.from({ length: 1200 }, (_, i) => ({ key: 'row-' + i, kind: 'assistant',
      ts: new Date().toISOString(), replayed: true,
      text: '## Message ' + i + '\\n' + ('Synthetic history for wheel input testing. **No live session data.**\\n\\n').repeat(8) })),
    lastActivity: new Date().toISOString(), sawReasoning: false, historyViewingOlder: true,
  }};
  store.selectedId = id;
  mount(ThreadView, { target: document.getElementById('app'), props: { sessionId: id } });
  let busyNextWheel = false;
  document.getElementById('app').addEventListener('wheel', () => {
    if (!busyNextWheel) return;
    busyNextWheel = false;
    const until = performance.now() + 350;
    while (performance.now() < until) {}
  }, { passive: true });
  window.scrollFixture = {
    append: async () => { store.sessions[id].items.push({ key: 'new-' + Date.now(),
      kind: 'assistant', ts: new Date().toISOString(), text: 'New streaming output.\\n'.repeat(20) }); await tick(); },
    busy: () => { busyNextWheel = true; },
  };
  await tick();
  window.scrollFixture.ready = true;
`
const server = await createServer({
  configFile: false, root: web, logLevel: 'error',
  plugins: [svelte(), {
    name: 'isolated-scroll-fixture',
    resolveId: id => id === '/scroll-fixture.js' ? '\0scroll-fixture' : null,
    load: id => id === '\0scroll-fixture' ? fixture : null,
    configureServer(vite) {
      vite.middlewares.use((req, res, next) => {
        if (req.url !== '/scroll-fixture') return next();
        res.setHeader('Content-Type', 'text/html');
        res.end('<!doctype html><html><body><div id="app" style="height:100vh;display:flex"></div><script type="module" src="/scroll-fixture.js"></script></body></html>');
      });
    },
  }],
  server: { host: '127.0.0.1', port: 0 },
})
let browser, socket
const deadline = setTimeout(() => { console.error('Scroll check exceeded 120s'); browser?.kill(); process.exitCode = 1 }, 120_000)
try {
  await server.listen()
  const port = server.httpServer.address().port
  const fixtureUrl = `http://127.0.0.1:${port}/scroll-fixture`
  const response = await fetch(fixtureUrl)
  assert.equal(response.status, 200)
  await response.text()
  browser = spawn(browserPath, ['--headless=new', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1200,900', fixtureUrl],
    { windowsHide: true, stdio: 'ignore' })
  const activePort = path.join(profile, 'DevToolsActivePort')
  for (let i = 0; !existsSync(activePort) && i < 100; i++) await delay(100)
  const debugPort = Number(readFileSync(activePort, 'utf8').split('\n')[0])
  const pages = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()
  const page = pages.find(page => page.type === 'page')
  socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }))
  let seq = 0
  const pending = new Map(), listeners = new Map()
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data))
    if (message.id) {
      const request = pending.get(message.id)
      pending.delete(message.id)
      message.error ? request?.reject(new Error(JSON.stringify(message.error))) : request?.resolve(message.result)
    } else for (const listener of listeners.get(message.method) ?? []) listener(message.params)
  })
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`${method} exceeded 30s`)) }, 30_000)
    pending.set(id, {
      resolve: value => { clearTimeout(timeout); resolve(value) },
      reject: error => { clearTimeout(timeout); reject(error) },
    })
    socket.send(JSON.stringify({ id, method, params }))
  })
  socket.addEventListener('close', () => {
    for (const request of pending.values()) request.reject(new Error('Isolated browser disconnected'))
    pending.clear()
  })
  const once = method => new Promise(resolve => {
    const listener = value => { listeners.get(method).delete(listener); resolve(value) }
    if (!listeners.has(method)) listeners.set(method, new Set())
    listeners.get(method).add(listener)
  })
  listeners.set('Runtime.exceptionThrown', new Set([event => console.error('Fixture error:', JSON.stringify(event.exceptionDetails))]))
  listeners.set('Runtime.consoleAPICalled', new Set([event => {
    if (event.type === 'error') console.error('Browser:', event.args.map(arg => arg.value ?? arg.description).join(' '))
  }]))
  const evaluate = async expression => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  await call('Runtime.enable')
  await call('Page.enable')
  for (let i = 0; i < 150; i++) {
    if (await evaluate('window.scrollFixture?.ready === true')) break
    await delay(100)
  }
  if (!await evaluate('window.scrollFixture?.ready')) console.error(await evaluate('({url: location.href, body: document.body.innerText.slice(0, 2000)})'))
  assert(await evaluate('window.scrollFixture?.ready'), 'Fixture did not render')
  await delay(600)
  const target = await call('Runtime.evaluate', { expression: 'document.querySelector(".stream.scroll")' })
  if (process.argv.includes('--blocking-wheel-control')) {
    await evaluate(`document.querySelector('.stream.scroll').addEventListener('wheel', () => {}, { passive: false })`)
  }
  const { listeners: handlers } = await call('DOMDebugger.getEventListeners', { objectId: target.result.objectId })
  const wheel = handlers.filter(handler => handler.type === 'wheel').map(({ type, passive }) => ({ type, passive }))
  console.log(JSON.stringify({ wheelListeners: wheel, rows: await evaluate('document.querySelectorAll(".stream-node").length') }))
  const point = await evaluate(`(() => { const s = document.querySelector('.stream.scroll'); s.scrollTop = 4000;
    const b = s.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 } })()`)
  await delay(250)
  const trace = []
  listeners.set('Tracing.dataCollected', new Set([data => trace.push(...data.value)]))
  await call('Tracing.start', { categories: 'input,latencyInfo,devtools.timeline', transferMode: 'ReportEvents' })
  for (let i = 0; i < 3; i++) {
    // Let Chromium synthesize wheel events on its own input thread. dispatchMouseEvent for each event
    // would itself wait for renderer hit testing, conflating the CDP harness with app input latency.
    if (process.argv.includes('--stress')) await evaluate('scrollFixture.busy()')
    await call('Input.synthesizeScrollGesture', { ...point, yDistance: -800, speed: 1200, gestureSourceType: 'mouse' })
    await delay(500)
  }
  const complete = once('Tracing.tracingComplete')
  await call('Tracing.end')
  await complete
  const latencies = trace.filter(e => e.name === 'InputLatency::GestureScrollUpdate' && e.ph === 'b').map(e => {
    const components = e.args.chrome_latency_info.component_info
    const time = type => components.find(c => c.component_type === type)?.time_us
    return (time('COMPONENT_INPUT_EVENT_LATENCY_FRAME_SWAP') - time('COMPONENT_INPUT_EVENT_LATENCY_ORIGINAL')) / 1000
  }).filter(Number.isFinite)
  latencies.sort((a, b) => a - b)
  console.log(JSON.stringify({ wheelToFrameMs: { samples: latencies.length,
    p50: latencies[Math.floor(latencies.length * 0.5)], p95: latencies[Math.floor(latencies.length * 0.95)],
    max: latencies.at(-1), over100ms: latencies.filter(ms => ms > 100).length } }))
  // JSDOM cannot test listener passivity or native scrolling under main-thread contention.
  if (!process.argv.includes('--diagnose')) assert(wheel.length > 0 && wheel.every(h => h.passive), 'Wheel input must never wait for JS cancellation')
  await evaluate('scrollFixture.append()')
  await delay(200)
  assert(await evaluate(`document.querySelector('.stream.scroll').scrollTop < document.querySelector('.stream.scroll').scrollHeight - 1000`), 'Streaming must not pull scrollback to the tail')
  await evaluate(`document.querySelector('.jumpbtn').click()`)
  await delay(600)
  assert(await evaluate(`(() => { const s = document.querySelector('.stream.scroll'); return s.scrollHeight - s.scrollTop - s.clientHeight < 2 })()`), 'Jump must reach the real live edge')
  await evaluate('scrollFixture.append()')
  await delay(600)
  assert(await evaluate(`(() => { const s = document.querySelector('.stream.scroll'); return s.scrollHeight - s.scrollTop - s.clientHeight < 2 })()`), 'Attached streaming must follow')
  await evaluate(`document.querySelector('[aria-label="Open isolated browser controls"]').click()`)
  await delay(200)
  const rail = await evaluate(`(() => { const nav = document.querySelector('.panel-tabs').getBoundingClientRect();
    const body = document.querySelector('.conversation').getBoundingClientRect();
    const panel = document.querySelector('aside[aria-label="Browser"]').getBoundingClientRect();
    return { edge: nav.right, conversation: body.right, panel: panel.left } })()`)
  assert(Math.abs(rail.edge - rail.conversation) < 2 && Math.abs(rail.edge - rail.panel) < 2,
    `Closed panel tabs must follow the new wall: ${JSON.stringify(rail)}`)
  const screenshot = path.join(tmpdir(), 'ama-scroll-panels.png')
  const captured = await call('Page.captureScreenshot', { format: 'png' })
  writeFileSync(screenshot, Buffer.from(captured.data, 'base64'))
  console.log(`Panel screenshot: ${screenshot}`)
  for (const width of [1200, 800, 560]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false })
    for (const [button, label] of [
      ['Open isolated browser controls', 'Browser'], ['Open GitHub and working diff', 'Working diff'], ['Open project runs', 'Project runs'],
    ]) {
      await evaluate(`(() => { const tab = document.querySelector('[aria-label="${button}"]');
        if (tab.getAttribute('aria-expanded') !== 'true') tab.click() })()`)
      await delay(200)
      const geometry = await evaluate(`(() => {
        const nav = document.querySelector('.panel-tabs').getBoundingClientRect();
        const body = document.querySelector('.conversation').getBoundingClientRect();
        const panel = document.querySelector('aside[aria-label="${label}"]').getBoundingClientRect();
        const tabs = [...document.querySelectorAll('.panel-tab')].map(t => t.getBoundingClientRect());
        return { edge: nav.right, conversation: body.right, bottom: body.bottom, panelLeft: panel.left, panelTop: panel.top,
          gaps: tabs.slice(1).map((tab, i) => tab.top - tabs[i].bottom) };
      })()`)
      assert(Math.abs(geometry.edge - geometry.conversation) < 2, `${label}/${width}: tabs lost conversation edge`)
      assert(geometry.gaps.every(gap => gap >= 0 && gap < 8), `${label}/${width}: empty slots or overlapping tabs`)
      assert(width > 620 ? Math.abs(geometry.edge - geometry.panelLeft) < 2 : geometry.panelTop >= geometry.bottom - 2,
        `${label}/${width}: drawer overlaps conversation: ${JSON.stringify(geometry)}`)
    }
  }
  console.log('Browser/GitHub/Runs drawer docking verified at 1200px, 800px and 560px.')
  console.log('Scroll browser check complete (isolated synthetic history).')
  await call('Browser.close')
} finally {
  clearTimeout(deadline)
  socket?.close()
  browser?.kill()
  await server.close()
  // Only the exact mkdtemp-owned profile is eligible for cleanup, never an operator browser directory.
  assert(path.dirname(profile) === path.resolve(tmpdir()) && path.basename(profile).startsWith('ama-scroll-check-'))
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }) }
  catch { console.log(`Browser still releasing disposable profile: ${profile}`) }
}

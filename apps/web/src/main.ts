import { mount } from 'svelte'
import App from './App.svelte'
import './app.css'
import { reportRendererFirstPaint } from './lib/desktopStartup'

const webStartedAt = performance.now()
const app = mount(App, { target: document.getElementById('app')! })

// Two animation frames distinguish "Svelte mounted" from a frame the native WebView had a chance to
// paint. The desktop log can now measure process-start -> first-visible separately from hub readiness.
requestAnimationFrame(() => {
  requestAnimationFrame(() => reportRendererFirstPaint(performance.now() - webStartedAt))
})

export default app

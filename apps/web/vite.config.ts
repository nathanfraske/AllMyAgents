import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig } from 'vite'

const HUB = process.env.HUB_URL ?? 'http://127.0.0.1:7777'
// Only the disposable sandbox launcher supplies this. Never auto-read the live hub token here: Vite's
// proxy is reachable on loopback, so silently turning it into a bearer proxy would recreate the exact
// unauthenticated local control plane this boundary closes.
const HUB_TOKEN = process.env.HUB_DEVICE_TOKEN ?? ''
const proxyHeaders = HUB_TOKEN ? { authorization: `Bearer ${HUB_TOKEN}` } : undefined

export default defineConfig({
  plugins: [svelte()],
  server: {
    port: 5273,
    proxy: {
      '/api': { target: HUB, changeOrigin: true, headers: proxyHeaders },
      '/ws': { target: HUB.replace('http', 'ws'), ws: true, headers: proxyHeaders },
    },
  },
})

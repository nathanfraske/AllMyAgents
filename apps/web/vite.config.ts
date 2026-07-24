import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig } from 'vite'

const HUB = process.env.HUB_URL ?? 'http://127.0.0.1:7777'

export default defineConfig({
  plugins: [svelte()],
  server: {
    port: 5273,
    proxy: {
      '/api': { target: HUB, changeOrigin: true },
      '/ws': { target: HUB.replace('http', 'ws'), ws: true },
    },
  },
})

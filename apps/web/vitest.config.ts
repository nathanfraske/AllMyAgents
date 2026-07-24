import { svelte } from '@sveltejs/vite-plugin-svelte'
import { svelteTesting } from '@testing-library/svelte/vite'
import { defineConfig } from 'vitest/config'

// Vitest config for the web app. This is intentionally separate from vite.config.ts:
// the app config carries the dev server + hub proxy, which the test runner doesn't need.
//
// Why the Svelte plugin is here: the store (`src/lib/store.svelte.ts`) and settings
// (`src/lib/settings.svelte.ts`) are Svelte 5 *runes* modules — `$state` only works once
// the Svelte compiler has processed the file, so `.svelte.ts` must go through
// `@sveltejs/vite-plugin-svelte`. With `environment: 'jsdom'` Vitest transforms modules in
// "web" mode, so runes compile to their reactive client form (not the inert SSR form).
// `svelteTesting()` pins the `browser` resolve condition (so `svelte` loads its client build)
// and registers DOM cleanup between tests.
export default defineConfig({
  plugins: [svelte(), svelteTesting()],
  test: {
    // jsdom gives us window / localStorage / WebSocket for the browser-facing modules under
    // test, and selects Vitest's web transform mode (required for reactive runes — see above).
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
    // Clear call history between tests; keep the base mock implementations from vi.mock factories.
    clearMocks: true,
  },
})

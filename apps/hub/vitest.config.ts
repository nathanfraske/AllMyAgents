import { defineConfig } from 'vitest/config'

// The hub is authored as NodeNext ESM: every intra-package import carries an explicit `.js`
// extension (e.g. `import { deriveTitle } from './title.js'`) even though the source is `.ts`.
// Vitest resolves through Vite, which does NOT rewrite `.js` → `.ts` by default, so a test that
// imports any hub module would fail to resolve its siblings. This tiny pre-resolver rewrites
// relative `*.js` specifiers to their `.ts` source when a `.ts` exists, making the whole hub
// importable under vitest without touching the production import style.
export default defineConfig({
  plugins: [
    {
      name: 'hub-resolve-ts-from-js',
      enforce: 'pre',
      async resolveId(source, importer) {
        if (importer && source.startsWith('.') && source.endsWith('.js')) {
          const asTs = source.slice(0, -3) + '.ts'
          const resolved = await this.resolve(asTs, importer, { skipSelf: true })
          if (resolved) return resolved
        }
        return null
      },
    },
  ],
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // Several suites compile and launch disposable copies of the real hub. Letting Vitest size its pool
    // from every logical CPU starves those child compilers on release machines until their independent
    // 60-second safety bounds fire, followed by cleanup racing the still-running process. Four workers
    // keeps ordinary tests parallel while leaving enough CPU/I/O for the production-path harnesses.
    minWorkers: 1,
    maxWorkers: 4,
  },
})

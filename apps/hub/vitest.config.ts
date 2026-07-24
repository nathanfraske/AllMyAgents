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
  },
})

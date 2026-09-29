import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { expect, it } from 'vitest'

it('omits tests only from production emission, not the full type-check gate', () => {
  const hub = fileURLToPath(new URL('..', import.meta.url))
  const load = (name: string) => {
    const file = path.join(hub, name)
    const read = ts.readConfigFile(file, ts.sys.readFile)
    expect(read.error).toBeUndefined()
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, hub)
    expect(parsed.errors).toEqual([])
    return new Set(parsed.fileNames.map(file => path.relative(hub, file).replaceAll('\\', '/')))
  }
  const checked = load('tsconfig.json')
  const emitted = load('tsconfig.build.json')
  const tests = [...checked].filter(file => /\.(test|spec)\.ts$/.test(file))
  expect(tests.length).toBeGreaterThan(100)
  expect(checked.has('src/buildConfig.test.ts')).toBe(true)
  expect([...emitted]).toEqual([...checked].filter(file => !tests.includes(file)))
})

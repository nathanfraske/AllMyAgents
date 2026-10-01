import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { expect, it } from 'vitest'
import { CODEX_INITIALIZE_CAPABILITIES } from './adapters/codex.js'

it('qualifies the pinned native catalog and Daybreak wire contract without starting a provider session', () => {
  const require = createRequire(import.meta.url)
  const launcher = require.resolve('@openai/codex/bin/codex.js')
  const installed = JSON.parse(fs.readFileSync(path.resolve(path.dirname(launcher), '../package.json'), 'utf8'))
  expect(installed.version).toBe('0.159.2')
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-codex-schema-'))
  try {
    // Offline schema generation only: no app-server listener, auth read, account refresh or inference.
    execFileSync(process.execPath, [launcher, 'app-server', 'generate-json-schema', '--experimental', '--out', out],
      { timeout: 20_000, windowsHide: true, stdio: 'pipe' })
    const schema = (name: string) => JSON.parse(fs.readFileSync(path.join(out, 'v2', `${name}.json`), 'utf8'))
    const turn = schema('TurnStartParams'), models = schema('ModelListResponse')
    expect(CODEX_INITIALIZE_CAPABILITIES.experimentalApi).toBe(true)
    expect(turn.properties.cyberAccessProgram).toBeDefined()
    expect(turn.definitions.CyberAccessProgram.enum).toEqual(['standard', 'daybreakBlue', 'daybreakRed'])
    expect(models.definitions.Model.properties.availableAccessPrograms).toBeDefined()
    expect(models.definitions.ModelAccessPrograms.properties.cyber.items.$ref).toBe('#/definitions/CyberAccessProgram')
    expect(schema('ModelListParams').properties).toHaveProperty('includeHidden')
  } finally { fs.rmSync(out, { recursive: true, force: true }) }
}, 30_000)

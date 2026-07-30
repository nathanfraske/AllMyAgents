import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe('cold public question ownership boundary', () => {
  it('claims only inside the successful listening callback and before readiness', () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, 'index.ts'), 'utf8')
    const serverCreation = source.indexOf('const server = startServer(')
    const listening = source.indexOf("server.once('listening'", serverCreation)
    const activation = source.indexOf('questions.activatePublicOwner()', listening)
    const startedAudit = source.indexOf("journal.append(null, 'hub/started'", listening)
    const ready = source.indexOf("type: 'ready'", listening)

    expect(serverCreation).toBeGreaterThan(-1)
    expect(listening).toBeGreaterThan(serverCreation)
    expect(source.slice(serverCreation, listening)).not.toContain(
      'questions.activatePublicOwner()'
    )
    expect(activation).toBeGreaterThan(listening)
    expect(activation).toBeLessThan(startedAudit)
    expect(activation).toBeLessThan(ready)
  })
})

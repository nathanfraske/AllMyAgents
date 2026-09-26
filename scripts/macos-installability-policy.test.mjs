import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const workflow = fs.readFileSync(new URL('../.github/workflows/macos-installability.yml', import.meta.url), 'utf8')

test('macOS install and failed-build cleanup delete only the exact test app', () => {
  const deletes = workflow.split(/\r?\n/).map(line => line.trim()).filter(line => line.startsWith('rm -rf '))
  assert.equal(deletes.length, 3, 'Review any additional recursive deletion explicitly')
  for (const line of deletes) {
    assert.match(line, /^rm -rf \/Applications\/AllMyAgents\.app(?: 2>\/dev\/null \|\| true)?$/)
  }
  assert.match(workflow, /APP=\/tmp\/ama-mnt\/AllMyAgents\.app\r?\n\s+\[ -d "\$APP" \] && \[ ! -L "\$APP" \]/)
  assert.match(workflow, /DEST=\/Applications\/AllMyAgents\.app/)
})

test('DMG failures retain verbose bundler diagnostics without hiding the failing exit', () => {
  const step = workflow.match(/- name: Build the macOS bundle([\s\S]*?)(?=\n      # See the header)/)?.[1]
  assert(step)
  assert.match(step, /set -euo pipefail/)
  assert.match(step, /tauri build --verbose/)
  assert.match(step, /2>&1 \| tee \/tmp\/ama-bundle\.log/)
  assert.doesNotMatch(step, /continue-on-error|\|\| true/)
  assert.match(workflow, /path: \|\r?\n\s+\/tmp\/ama-bundle\.log/)
})

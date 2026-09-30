import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { createRequire } from 'node:module'

const require = createRequire(new URL('../apps/hub/package.json', import.meta.url))
const { parse } = require('yaml')

const workflow = fs.readFileSync(new URL('../.github/workflows/macos-installability.yml', import.meta.url), 'utf8')

test('PR installer baseline cannot replace current-source builds or exact-release verification', () => {
  const jobs = parse(workflow).jobs
  const installer = jobs['curl-install'].steps.find(step => step.name === 'Install via scripts/install-macos.sh')
  const tag = (event_name, input = '', released = '') => vm.runInNewContext(installer.env.AMA_TAG.slice(3, -2), {
    github: { event_name, event: { inputs: { tag: input }, release: { tag_name: released } } },
  }, { timeout: 1000 })
  assert.equal(tag('pull_request'), 'v0.1.48-alpha.52')
  assert.equal(tag('workflow_dispatch', 'v0.1.50-alpha.54'), 'v0.1.50-alpha.54')
  assert.equal(tag('release', '', 'v0.1.50-alpha.54'), 'v0.1.50-alpha.54')
  assert.equal(tag('schedule'), '')
  assert.equal(tag('workflow_dispatch'), '')
  assert.equal(installer.if, undefined)
  assert.equal(installer['continue-on-error'], undefined)
  const resolve = jobs.installability.steps.find(step => step.name === 'Resolve what to verify')
  assert.doesNotMatch(JSON.stringify(resolve), /v0\.1\.48|pull_request/)
  assert.match(resolve.run, /else echo "mode=build"/)
  assert.deepEqual(jobs.installability.strategy.matrix.runner, ['macos-latest', 'macos-15-intel'])
})

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

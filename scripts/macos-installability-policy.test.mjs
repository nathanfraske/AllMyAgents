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

test('pre-publication P0 CLI check uses a complete baseline while launch/repair builds the current ref', () => {
  const jobs = parse(fs.readFileSync(new URL('../.github/workflows/macos-p0-verification.yml', import.meta.url), 'utf8')).jobs
  const cli = jobs['cli-installer-health'].steps.find(step => step.name === 'Run the real CLI installer and require its health verdict')
  assert.equal(cli.env.AMA_TAG, 'v0.1.48-alpha.52')
  assert.equal(cli.if, undefined)
  assert.equal(cli['continue-on-error'], undefined)
  assert.match(cli.run, /set -euo pipefail/)
  assert.match(cli.run, /Verified: the installed app launched through LaunchServices and its hub answers \/api\/health/)
  const current = jobs['launch-and-repair']
  assert.deepEqual(current.strategy.matrix.runner, ['macos-latest', 'macos-15-intel'])
  assert.equal(current.steps.find(step => step.uses === 'actions/checkout@v4').with?.ref, undefined)
  assert.match(current.steps.find(step => step.name === 'Build and install the app').run, /tauri build --bundles app/)
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

test('release action uses headless DMG layout only on self-hosted Macs without dropping signed bundles', () => {
  const release = parse(fs.readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'))
  const build = release.jobs.release.steps.find(step => step.uses === 'tauri-apps/tauri-action@v0')
  assert.equal(build.env.CI, 'true')
  for (const [os, environment, expected] of [
    ['macOS', 'self-hosted', 'false'],
    ['macOS', 'github-hosted', 'true'],
    ['Windows', 'self-hosted', 'true'],
    ['Linux', 'self-hosted', 'true'],
  ]) {
    const override = vm.runInNewContext(build.env.TAURI_BUNDLER_DMG_IGNORE_CI.slice(3, -2), {
      runner: { os, environment },
    }, { timeout: 1000 })
    assert.equal(override, expected, `${environment}/${os}`)
  }
  assert.equal(build['continue-on-error'], undefined)
  assert.equal(build.with.releaseDraft, true)
  assert.equal(build.with.includeUpdaterJson, true)
  assert.doesNotMatch(build.with.args, /--no-sign|--bundles/)
  const config = JSON.parse(fs.readFileSync(new URL('../apps/desktop/src-tauri/tauri.conf.json', import.meta.url), 'utf8'))
  assert(config.bundle.targets.includes('dmg'))
  assert.equal(config.bundle.createUpdaterArtifacts, true)
})

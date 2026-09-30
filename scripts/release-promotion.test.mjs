import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import { releasePromotion, validateAssets } from './release-promotion.mjs'

const repository = 'nathanfraske/AllMyAgents'
const tag = 'v0.1.50-alpha.54'
const sha = 'a'.repeat(40)
const version = '0.1.50'
const base = `/repos/${repository}`
const context = { repository, tag, sha, version }
const draft = () => ({ id: 42, tag_name: tag, target_commitish: sha, draft: true, prerelease: false,
  body: `Release notes\n<!-- allmyagents-release-source:${sha} -->` })

function fixture() {
  const updater = {
    'darwin-x86_64': 'AllMyAgents_x64.app.tar.gz',
    'darwin-aarch64': 'AllMyAgents_aarch64.app.tar.gz',
    'windows-x86_64': `AllMyAgents_${version}_x64-setup.exe`,
  }
  const names = new Set([
    `AllMyAgents_${version}_x64.dmg`, `AllMyAgents_${version}_aarch64.dmg`,
    `AllMyAgents_${version}_x64-setup.exe`, `AllMyAgents_${version}_x64_en-US.msi`,
    `allmyagents-testbed_${version}_amd64.deb`, `allmyagents-testbed_${version}_amd64.deb.sha256`,
    `allmyagents-testbed_${version}_arm64.deb`, `allmyagents-testbed_${version}_arm64.deb.sha256`, 'latest.json',
    ...Object.values(updater), ...Object.values(updater).map(name => `${name}.sig`),
  ])
  const assets = [...names].map((name, index) => ({ id: index + 100, name, size: 100, state: 'uploaded' }))
  const manifest = { version, platforms: Object.fromEntries(Object.entries(updater).map(([platform, name]) =>
    [platform, { signature: 'signed content', url: `https://github.com/${repository}/releases/download/${tag}/${name}` }])) }
  return { assets, manifest }
}

function api({ releases = [], release = draft(), assets, manifest, tagShas = [sha], mutationError } = {}) {
  const defaults = fixture()
  const calls = []
  let reads = 0
  const request = async (method, path, body, accept) => {
    calls.push({ method, path, body, accept })
    if (method === 'GET' && path === `${base}/commits/${tag}`) return { sha: tagShas[Math.min(reads++, tagShas.length - 1)] }
    if (method === 'GET' && path === `${base}/releases?per_page=100&page=1`) return structuredClone(releases)
    if (method === 'GET' && path === `${base}/releases/42`) return structuredClone(release)
    if (method === 'GET' && path === `${base}/releases/42/assets?per_page=100`) return assets ?? defaults.assets
    if (method === 'GET' && path.startsWith(`${base}/releases/assets/`)) {
      assert.equal(accept, 'application/octet-stream')
      return manifest ?? defaults.manifest
    }
    if (method === 'POST' && path === `${base}/releases`) {
      if (mutationError) throw mutationError
      return { id: 42, ...body }
    }
    if (method === 'PATCH' && path === `${base}/releases/42`) {
      if (mutationError) throw mutationError
      return { ...release, ...body }
    }
    throw new Error(`Unexpected API call: ${method} ${path}`)
  }
  return { calls, request }
}

test('prepare creates exactly one invisible draft bound to the workflow source', async () => {
  const mock = api()
  const result = await releasePromotion({ ...context, mode: 'prepare', body: 'Versioned changes', request: mock.request })
  assert.equal(result.draft, true)
  assert.equal(result.target_commitish, sha)
  assert.equal(result.make_latest, 'false')
  assert.deepEqual(mock.calls.filter(c => c.method !== 'GET').map(c => c.method), ['POST'])
})

test('a later invocation reconciles the exact existing draft without another mutation', async () => {
  const mock = api({ releases: [draft()] })
  assert.equal((await releasePromotion({ ...context, mode: 'prepare', request: mock.request })).id, 42)
  assert(mock.calls.every(c => c.method === 'GET'))
})

for (const [name, update] of [
  ['published release', { draft: false }], ['different source', { target_commitish: 'b'.repeat(40) }],
  ['unbound draft', { body: 'unrelated' }], ['prerelease', { prerelease: true }],
]) {
  test(`prepare refuses to overwrite a ${name}`, async () => {
    const mock = api({ releases: [{ ...draft(), ...update }] })
    await assert.rejects(releasePromotion({ ...context, mode: 'prepare', request: mock.request }), /unpublished draft/)
    assert(mock.calls.every(c => c.method === 'GET'))
  })
}

test('a complete release is published only after assets, updater and source are verified', async () => {
  const mock = api()
  const result = await releasePromotion({ ...context, mode: 'publish', releaseId: 42, request: mock.request })
  assert.equal(result.draft, false)
  assert.equal(result.make_latest, 'true')
  assert.deepEqual(mock.calls.filter(c => c.method !== 'GET').map(c => c.method), ['PATCH'])
  assert.equal(mock.calls.at(-1).path, `${base}/releases/42`)
  assert.equal(mock.calls.filter(c => c.path === `${base}/commits/${tag}`).length, 2)
})

for (const missing of [`AllMyAgents_${version}_x64.dmg`, `allmyagents-testbed_${version}_amd64.deb`,
  `allmyagents-testbed_${version}_arm64.deb.sha256`, 'AllMyAgents_x64.app.tar.gz.sig']) {
  test(`missing ${missing} leaves the release in draft`, async () => {
    const { assets } = fixture()
    const mock = api({ assets: assets.filter(a => a.name !== missing) })
    await assert.rejects(releasePromotion({ ...context, mode: 'publish', releaseId: 42, request: mock.request }), /[Mm]issing/)
    assert(mock.calls.every(c => c.method === 'GET'))
  })
}

test('unsigned, stale and foreign updater entries cannot publish', () => {
  for (const change of [
    f => { delete f.manifest.platforms['darwin-x86_64'] },
    f => { f.manifest.platforms['darwin-x86_64'].signature = '' },
    f => { f.manifest.platforms['darwin-x86_64'].url = 'https://example.com/installer' },
    f => { f.manifest.platforms['darwin-x86_64'].url = f.manifest.platforms['darwin-x86_64'].url.replace(tag, 'v0.1.49-alpha.53') },
    f => { f.manifest.version = '0.1.49' },
  ]) {
    const f = fixture(); change(f)
    assert.throws(() => validateAssets(f.assets, f.manifest, context))
  }
})

test('partial uploads and duplicate asset names cannot publish', () => {
  for (const change of [f => { f.assets[0].state = 'starter' }, f => { f.assets[0].size = 0 },
    f => { f.assets.push({ ...f.assets[0] }) }]) {
    const f = fixture(); change(f)
    assert.throws(() => validateAssets(f.assets, f.manifest, context), /Incomplete|Duplicate/)
  }
})

test('a tag moved during validation leaves the draft unpublished', async () => {
  const mock = api({ tagShas: [sha, 'b'.repeat(40)] })
  await assert.rejects(releasePromotion({ ...context, mode: 'publish', releaseId: 42, request: mock.request }), /Tag moved/)
  assert(mock.calls.every(c => c.method === 'GET'))
})

test('check binds the exact draft ID before the package upload', async () => {
  const mock = api({ release: { ...draft(), id: 43 } })
  await assert.rejects(releasePromotion({ ...context, mode: 'check', releaseId: 42, request: mock.request }), /unpublished draft/)
  assert(mock.calls.every(c => c.method === 'GET'))
})

for (const mode of ['prepare', 'publish']) {
  test(`${mode} never retries an ambiguous mutation`, async () => {
    const mock = api({ mutationError: new Error('Lost acknowledgement') })
    await assert.rejects(releasePromotion({ ...context, mode, releaseId: 42, body: 'Notes', request: mock.request }), /Lost acknowledgement/)
    assert.equal(mock.calls.filter(c => c.method !== 'GET').length, 1)
  })
}

test('workflow keeps all build and durability gates before a single publication job', () => {
  const require = createRequire(new URL('../apps/hub/package.json', import.meta.url))
  const { parse } = require('yaml')
  const workflow = parse(fs.readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'))
  const jobs = workflow.jobs
  const gate = jobs['launch-and-repair-gate']
  const check = gate.steps.findIndex(s => s.run === 'node scripts/wait-release-verification.mjs')
  const prepare = gate.steps.findIndex(s => s.run === 'node scripts/release-promotion.mjs prepare')
  assert(check >= 0 && prepare > check)
  assert.equal(gate.outputs.release_id, '${{ steps.draft.outputs.release_id }}')
  const build = jobs.release.steps.find(s => s.uses === 'tauri-apps/tauri-action@v0')
  assert.equal(build.with.releaseId, '${{ needs.launch-and-repair-gate.outputs.release_id }}')
  assert.equal(build.with.releaseDraft, true)
  assert.equal(build.with.prerelease, false)
  assert.deepEqual(jobs['publish-linux-testbed'].needs, ['launch-and-repair-gate', 'release', 'linux-testbed'])
  assert.deepEqual(jobs['publish-release'].needs, ['launch-and-repair-gate', 'release', 'publish-linux-testbed'])
  for (const id of ['release', 'linux-testbed', 'publish-linux-testbed', 'publish-release']) {
    assert.equal(jobs[id].if, undefined, `${id} must use the default success dependency condition`)
    assert.equal(jobs[id]['continue-on-error'], undefined)
    for (const step of jobs[id].steps) assert.equal(step['continue-on-error'], undefined)
  }
  const promotions = Object.values(jobs).flatMap(job => job.steps).filter(s => s.run === 'node scripts/release-promotion.mjs publish')
  assert.equal(promotions.length, 1)
  assert(jobs['publish-release'].steps.includes(promotions[0]))
})

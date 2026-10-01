// All matrix jobs upload to one exact-source draft. Only this final gate publishes it.
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'

const marker = sha => `<!-- allmyagents-release-source:${sha} -->`

export function validateDraft(release, { tag, sha, id }) {
  if (!release || release.draft !== true || release.prerelease !== false ||
      release.tag_name !== tag || release.target_commitish !== sha ||
      !release.body?.includes(marker(sha)) || !Number.isSafeInteger(release.id) || release.id <= 0 ||
      (id !== undefined && release.id !== id)) {
    throw new Error('Release must be an unpublished draft bound to this exact tag and source')
  }
  return release
}

export function validateAssets(assets, manifest, { repository, tag, version }) {
  const byName = new Map()
  for (const asset of assets) {
    if (byName.has(asset.name)) throw new Error(`Duplicate release asset: ${asset.name}`)
    if (asset.state !== 'uploaded' || !Number.isSafeInteger(asset.size) || asset.size <= 0) {
      throw new Error(`Incomplete release asset: ${asset.name}`)
    }
    byName.set(asset.name, asset)
  }
  const required = [
    `AllMyAgents_${version}_x64.dmg`, `AllMyAgents_${version}_aarch64.dmg`,
    `AllMyAgents_${version}_x64-setup.exe`, `AllMyAgents_${version}_x64_en-US.msi`,
    `allmyagents-testbed_${version}_amd64.deb`, `allmyagents-testbed_${version}_arm64.deb`,
    'latest.json',
  ]
  for (const name of required) {
    if (!byName.has(name)) throw new Error(`Missing required release asset: ${name}`)
    if (name.endsWith('.deb') && !byName.has(`${name}.sha256`)) {
      throw new Error(`Missing package checksum: ${name}`)
    }
  }
  if (manifest?.version !== version) throw new Error('Updater version differs from the built app')
  const prefix = `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/`
  for (const platform of ['darwin-x86_64', 'darwin-aarch64', 'windows-x86_64']) {
    const entry = manifest.platforms?.[platform]
    if (!entry || typeof entry.signature !== 'string' || !entry.signature.trim() ||
        typeof entry.url !== 'string' || !entry.url.startsWith(prefix)) {
      throw new Error(`Missing or foreign signed updater entry: ${platform}`)
    }
    const name = decodeURIComponent(entry.url.slice(prefix.length))
    if (name.includes('/') || !byName.has(name) || !byName.has(`${name}.sig`)) {
      throw new Error(`Updater asset or signature missing: ${platform}`)
    }
  }
  return true
}

export async function releasePromotion({ mode, repository, tag, sha, version, body, releaseId, request }) {
  if (repository !== 'nathanfraske/AllMyAgents' || !/^v\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(tag) ||
      !/^[0-9a-f]{40}$/.test(sha) || !/^\d+\.\d+\.\d+$/.test(version) ||
      !(tag === `v${version}` || tag.startsWith(`v${version}-`))) {
    throw new Error('Expected the exact AllMyAgents version tag and source')
  }
  const base = `/repos/${repository}`
  const commit = await request('GET', `${base}/commits/${encodeURIComponent(tag)}`)
  if (commit.sha !== sha) throw new Error('Tag moved away from the reviewed workflow source')
  const expected = { tag, sha }
  let release
  if (mode === 'prepare') {
    // Drafts are not reliably discoverable through the public tag endpoint.
    // Search the authenticated list completely within an explicit bound.
    const matches = []
    for (let page = 1; page <= 10; page++) {
      const rows = await request('GET', `${base}/releases?per_page=100&page=${page}`)
      matches.push(...rows.filter(row => row.tag_name === tag))
      if (rows.length < 100) break
      if (page === 10) throw new Error('Release lookup exceeds bound; no draft was created')
    }
    if (matches.length > 1) throw new Error('Multiple releases exist for this tag')
    if (matches.length) return validateDraft(matches[0], expected)
    if (typeof body !== 'string' || !body.trim()) throw new Error('Versioned release notes are required')
    // Never retry a mutation after a lost acknowledgement. A later invocation
    // must first reconcile the authenticated draft list above.
    release = await request('POST', `${base}/releases`, {
      tag_name: tag, target_commitish: sha, name: `AllMyAgents ${tag}`,
      body: `${body.trim()}\n\n${marker(sha)}`, draft: true, prerelease: false, make_latest: 'false',
    })
    return validateDraft(release, expected)
  }
  if (!['check', 'publish'].includes(mode) || !Number.isSafeInteger(releaseId) || releaseId <= 0) {
    throw new Error('Expected check/publish and an exact draft release ID')
  }
  expected.id = releaseId
  release = validateDraft(await request('GET', `${base}/releases/${releaseId}`), expected)
  if (mode === 'check') return release
  const assets = await request('GET', `${base}/releases/${releaseId}/assets?per_page=100`)
  if (assets.length >= 100) throw new Error('Asset lookup exceeds bound; publication blocked')
  const latest = assets.find(asset => asset.name === 'latest.json')
  if (!latest || latest.size > 1024 * 1024) throw new Error('Missing or oversized updater manifest')
  const manifest = await request('GET', `${base}/releases/assets/${latest.id}`, undefined, 'application/octet-stream')
  validateAssets(assets, manifest, { repository, tag, version })
  // Recheck identity immediately before the one visibility-changing mutation.
  if ((await request('GET', `${base}/commits/${encodeURIComponent(tag)}`)).sha !== sha) {
    throw new Error('Tag moved during asset validation; publication blocked')
  }
  validateDraft(await request('GET', `${base}/releases/${releaseId}`), expected)
  const result = await request('PATCH', `${base}/releases/${releaseId}`, { draft: false, prerelease: false, make_latest: 'true' })
  if (result.id !== releaseId || result.tag_name !== tag || result.draft !== false) {
    throw new Error('Publication acknowledgement differs; inspect the release before any retry')
  }
  return result
}

async function main() {
  const env = process.env
  if (env.GITHUB_REF !== `refs/tags/${env.GITHUB_REF_NAME}` || !env.GITHUB_TOKEN ||
      env.GITHUB_API_URL !== 'https://api.github.com') throw new Error('Expected authenticated GitHub tag context')
  const version = JSON.parse(fs.readFileSync('apps/desktop/src-tauri/tauri.conf.json', 'utf8')).version
  const mode = process.argv[2]
  const request = async (method, path, body, accept = 'application/vnd.github+json') => {
    const response = await fetch(`${env.GITHUB_API_URL}${path}`, {
      method, headers: { Accept: accept, Authorization: `Bearer ${env.GITHUB_TOKEN}`, 'X-GitHub-Api-Version': '2022-11-28' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000),
    })
    if (!response.ok) throw new Error(`GitHub ${method} ${path} returned ${response.status}; no automatic replay`)
    const text = await response.text()
    if (accept === 'application/octet-stream' && Buffer.byteLength(text) > 1024 * 1024) throw new Error('Updater manifest exceeds bound')
    return JSON.parse(text)
  }
  const release = await releasePromotion({ mode, repository: env.GITHUB_REPOSITORY, tag: env.GITHUB_REF_NAME,
    sha: env.GITHUB_SHA, version, releaseId: Number(env.RELEASE_ID), request,
    body: mode === 'prepare' ? fs.readFileSync(`docs/releases/${env.GITHUB_REF_NAME}.md`, 'utf8') : undefined })
  if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `release_id=${release.id}\n`)
  console.log(`Release ${release.id}: ${release.draft ? 'draft' : 'published'} at ${env.GITHUB_SHA}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()

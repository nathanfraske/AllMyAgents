import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Journal } from './journal.js'
import { ChatArtifacts, artifactMime, artifactSource, ARTIFACT_TOTAL_MAX_BYTES, ARTIFACT_SESSION_MAX_BYTES } from './chatArtifacts.js'
import { runAgentTool } from './agentToolCore.js'
import { buildWorkerAgentServices } from './agentWorker.js'
import { AUTO_ALLOW_TOOLS } from './executor.js'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
const cleanup: Array<() => void> = []
afterEach(() => { vi.restoreAllMocks(); while (cleanup.length) cleanup.pop()!() })
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-artifact-'))
  const cwd = path.join(root, 'checkout')
  fs.mkdirSync(cwd)
  const journal = new Journal(path.join(root, 'hub.db'))
  const storage = path.join(root, 'artifacts')
  const artifacts = new ChatArtifacts(journal, storage)
  const workspace = { id: 'session-a', cwd }
  fs.writeFileSync(path.join(cwd, 'render.png'), PNG)
  cleanup.push(() => { journal.db.close(); fs.rmSync(root, { recursive: true, force: true }) })
  return { root, journal, storage, artifacts, workspace, cwd }
}

describe('chat artifact publication', () => {
  it('snapshots independently of the source and restores without embedding bytes in history', async () => {
    const h = fixture()
    const result = await h.artifacts.publish(h.workspace, { path: 'render.png', caption: 'Fit preview' })
    expect(result).toMatchObject({ reused: false, attachment: { name: 'render.png', mime: 'image/png', size: PNG.length } })
    fs.rmSync(h.cwd, { recursive: true })
    const restored = new ChatArtifacts(h.journal, h.storage).get(h.workspace.id, result.attachment.id)!
    expect(fs.readFileSync(restored.path)).toEqual(PNG)
    const rows = h.journal.db.prepare("SELECT payload FROM events WHERE kind = 'session/artifact'").all() as { payload: string }[]
    expect(rows).toHaveLength(1)
    expect(rows[0]!.payload).toContain('Fit preview')
    expect(rows[0]!.payload).not.toContain(PNG.toString('base64'))
    expect(rows[0]!.payload).not.toContain(h.root.replaceAll('\\', '\\\\'))
    expect((await h.journal.sessionHistoryPage(h.workspace.id)).events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'session/artifact', payload: expect.objectContaining({ text: 'Fit preview' }) }),
    ]))
    expect(h.artifacts.get('other-session', result.attachment.id)).toBeUndefined()
  })

  it('deduplicates retries, concurrent publication and replay after restart', async () => {
    const h = fixture()
    const results = await Promise.all(Array.from({ length: 3 }, () => h.artifacts.publish(h.workspace, { path: 'render.png' })))
    expect(new Set(results.map(r => r.attachment.id)).size).toBe(1)
    const again = await new ChatArtifacts(h.journal, h.storage).publish(h.workspace, { path: 'render.png' })
    expect(again.reused).toBe(true)
    expect(h.journal.db.prepare("SELECT COUNT(*) n FROM events WHERE kind='session/artifact'").get()).toEqual({ n: 1 })
  })

  it('keeps new revisions separate and serves arbitrary formats only as downloads', async () => {
    const h = fixture()
    for (const name of ['part.step', 'pack.zip', 'active.svg', 'report.html']) {
      fs.writeFileSync(path.join(h.cwd, name), '<svg onload="alert(1)">preview</svg>')
      const published = await h.artifacts.publish(h.workspace, { path: name })
      expect(published.attachment.mime).toBe('application/octet-stream')
    }
    const one = await h.artifacts.publish(h.workspace, { path: 'render.png' })
    fs.appendFileSync(path.join(h.cwd, 'render.png'), '\nrevision2')
    const two = await h.artifacts.publish(h.workspace, { path: 'render.png' })
    expect(two.attachment.id).not.toBe(one.attachment.id)
    expect(fs.readFileSync(h.artifacts.get(h.workspace.id, one.attachment.id)!.path)).toEqual(PNG)
  })

  it('rejects URLs, private files, traversal, directories, empty and oversized files', async () => {
    const h = fixture()
    fs.writeFileSync(path.join(h.root, 'outside.png'), PNG)
    fs.writeFileSync(path.join(h.cwd, '.env'), 'secret')
    fs.writeFileSync(path.join(h.cwd, 'empty.png'), '')
    const large = fs.openSync(path.join(h.cwd, 'huge.bin'), 'w')
    fs.ftruncateSync(large, 33 * 1024 * 1024); fs.closeSync(large)
    for (const source of ['https://example.com/p.png', '../outside.png', '.env', '.', 'empty.png', 'huge.bin']) {
      await expect(h.artifacts.publish(h.workspace, { path: source })).rejects.toThrow()
    }
    expect(h.journal.db.prepare('SELECT COUNT(*) n FROM chat_artifacts').get()).toEqual({ n: 0 })
  })

  it('rejects escaping directory symlinks/junctions, including private target components', async () => {
    const h = fixture()
    fs.mkdirSync(path.join(h.root, 'outside'))
    fs.writeFileSync(path.join(h.root, 'outside', 'p.png'), PNG)
    fs.symlinkSync(path.join(h.root, 'outside'), path.join(h.cwd, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(h.artifacts.publish(h.workspace, { path: 'link/p.png' })).rejects.toThrow('escapes')
    fs.mkdirSync(path.join(h.cwd, '.ssh'))
    fs.writeFileSync(path.join(h.cwd, '.ssh', 'key.png'), PNG)
    fs.symlinkSync(path.join(h.cwd, '.ssh'), path.join(h.cwd, 'hidden'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(h.artifacts.publish(h.workspace, { path: 'hidden/key.png' })).rejects.toThrow('private')
  })

  it('maps WSL execution paths into only their host checkout', () => {
    const h = fixture()
    const wsl = { ...h.workspace, executionCwd: '/home/dev/project' }
    expect(artifactSource(wsl, '/home/dev/project/render.png')).toBe(path.join(h.cwd, 'render.png'))
    expect(() => artifactSource(wsl, '/etc/passwd')).toThrow()
  })

  it('rolls back the catalog and unreferenced snapshot if journal publication fails', async () => {
    const h = fixture()
    vi.spyOn(h.journal, 'append').mockImplementationOnce(() => { throw new Error('disk full') })
    await expect(h.artifacts.publish(h.workspace, { path: 'render.png' })).rejects.toThrow('disk full')
    expect(h.journal.db.prepare('SELECT COUNT(*) n FROM chat_artifacts').get()).toEqual({ n: 0 })
    expect(fs.readFileSync(path.join(h.cwd, 'render.png'))).toEqual(PNG)
    const files = fs.readdirSync(h.storage, { recursive: true }).filter(name => String(name).endsWith('.png') || String(name).endsWith('.json'))
    expect(files).toEqual([])
  })

  it.each(['session', 'total'] as const)('enforces the %s byte budget without deleting existing history', async kind => {
    const h = fixture()
    h.journal.db.prepare('INSERT INTO chat_artifacts VALUES (?,?,?,?,?)').run('prior', kind === 'session' ? h.workspace.id : 'other', 'prior', '{}', kind === 'session' ? ARTIFACT_SESSION_MAX_BYTES : ARTIFACT_TOTAL_MAX_BYTES)
    await expect(h.artifacts.publish(h.workspace, { path: 'render.png' })).rejects.toThrow('storage limit')
    expect(h.journal.db.prepare('SELECT COUNT(*) n FROM chat_artifacts').get()).toEqual({ n: 1 })
  })

  it.each(['codex', 'claude'] as const)('exposes the same explicit display tool to %s, including worker relay', async provider => {
    const h = fixture()
    const relayRpc = vi.fn(async (_method, args) => h.artifacts.publish(h.workspace, args.input))
    const services = buildWorkerAgentServices({ relayRpc, relayApproval: async () => false, isBusTurn: () => true, danger: () => ({ busCanUseRiskyTools: false, autoApprovePractices: false }), journal: () => {} })
    const result = JSON.parse(String(await runAgentTool('publish_artifact', { path: 'render.png', sessionId: 'forged' }, { identity: { sessionId: h.workspace.id, provider, profileId: 'p', label: 'agent' }, services })))
    expect(result.displayed).toBe(true)
    expect(AUTO_ALLOW_TOOLS.has('mcp__allmyagents__publish_artifact')).toBe(true)
    expect(relayRpc).toHaveBeenCalledWith('artifact.publish', { sessionId: h.workspace.id, input: { path: 'render.png' } })
  })

  it('does not trust a file extension as proof of an inline image', () => {
    expect(artifactMime(Buffer.from('<html>not PNG</html>'))).toBe('application/octet-stream')
    expect(artifactMime(PNG)).toBe('image/png')
  })
})

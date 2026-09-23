import { afterEach, describe, expect, it, vi } from 'vitest'
import { ModelCatalog, MODEL_CATALOG_TTL_MS, MODEL_CATALOG_RETRY_MS, modelCatalogDeadline } from './modelCatalog.js'
import { CodexClient } from './adapters/codex.js'
import { parseCodexModels } from './profiles.js'
import type { Profile, ProfileAvailableModel } from './types.js'

const profile = (): Profile => ({ id: 'codex-test', dir: '/unused', provider: 'codex', authStatus: 'signed_in', providerAccountId: 'account-a' })
const model: ProfileAvailableModel = { slug: 'brand-new', name: 'Brand new', supportedEfforts: [], serviceTiers: [] }
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

describe('bounded account catalog discovery', () => {
  it('deduplicates, revalidates automatically after six hours, and permits manual refresh sooner', async () => {
    let now = 100
    const catalog = new ModelCatalog(() => now)
    const account = profile()
    const read = vi.fn(async () => [model])
    const pending = catalog.refresh(account, read)!
    expect(catalog.refresh(account, read, true)).toBe(pending)
    await pending
    expect(catalog.refresh(account, read)).toBeUndefined()
    now += MODEL_CATALOG_TTL_MS
    await catalog.refresh(account, read)
    await catalog.refresh(account, read, true)
    expect(read).toHaveBeenCalledTimes(3)
    expect(catalog.peek(account)?.models).toEqual([model])
  })
  it('retains good results on failure, backs off, and accepts an authoritative empty catalog', async () => {
    let now = 100
    const catalog = new ModelCatalog(() => now)
    const account = profile()
    await catalog.refresh(account, async () => [model])
    const old = catalog.peek(account)
    await expect(catalog.refresh(account, async () => { throw Error('offline') }, true)).rejects.toThrow('offline')
    expect(catalog.peek(account)).toBe(old)
    expect(catalog.refresh(account, async () => [])).toBeUndefined()
    now += MODEL_CATALOG_RETRY_MS
    await catalog.refresh(account, async () => [])
    expect(catalog.peek(account)?.models).toEqual([])
  })
  it('does not leak results across accounts or publish a late result after a login change', async () => {
    const catalog = new ModelCatalog()
    const account = profile()
    let resolve!: (models: ProfileAvailableModel[]) => void
    const pending = catalog.refresh(account, () => new Promise(r => { resolve = r }))!
    await Promise.resolve()
    expect(catalog.peek({ ...account, id: 'codex-b' })).toBeUndefined()
    account.providerAccountId = 'account-b'
    expect(catalog.peek(account)).toBeUndefined()
    resolve([model])
    await expect(pending).rejects.toThrow('Account changed')
    expect(catalog.peek(account)).toBeUndefined()
  })
  it('rejects an old profile object without replacing a newer identity entry', async () => {
    const catalog = new ModelCatalog()
    const old = profile(), replacement = { ...old, providerAccountId: 'replacement' }
    let finish!: (models: []) => void
    const pending = catalog.refresh(old, () => new Promise(resolve => { finish = resolve }))!
    await Promise.resolve()
    await catalog.refresh(replacement, async () => [model])
    finish([])
    await expect(pending).rejects.toThrow('Account changed')
    expect(catalog.peek(replacement)?.models).toEqual([model])
  })
  it('bounds parallel metadata reads even when many profiles are polled', async () => {
    const catalog = new ModelCatalog()
    const a = profile(), b = { ...a, id: 'b' }, c = { ...a, id: 'c' }
    const read = vi.fn(async () => [model])
    const first = catalog.refresh(a, read), second = catalog.refresh(b, read)
    expect(catalog.refresh(c, read)).toBeUndefined()
    await expect(catalog.refresh(c, read, true)).rejects.toThrow('Other model catalogs')
    await Promise.all([first, second])
    await catalog.refresh(c, read)
    expect(read).toHaveBeenCalledTimes(3)
  })
  it('bounds time without committing a late result', async () => {
    vi.useFakeTimers()
    let finish!: (value: string) => void
    const promise = modelCatalogDeadline(new Promise<string>(resolve => { finish = resolve }), 50)
    const rejected = expect(promise).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(50)
    await rejected
    finish('late')
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('Codex discovery protocol', () => {
  it('pages the account list without starting, steering, or interrupting a turn', async () => {
    const client = new CodexClient('unused', vi.fn())
    vi.spyOn(client, 'ensureStarted').mockResolvedValue()
    const request = vi.spyOn(client, 'request')
      .mockResolvedValueOnce({ data: [{ model: 'new-model', displayName: 'New Model', hidden: false }], nextCursor: 'second' })
      .mockResolvedValueOnce({ data: [{ model: 'hidden', hidden: true }, { model: 'another', releasedAt: '2026-09-22' }], nextCursor: null })
    const result = await client.listModels()
    expect(result.map(row => row.slug)).toEqual(['new-model', 'another'])
    expect(result[1]?.releasedAt).toBe('2026-09-22T00:00:00.000Z')
    expect(request.mock.calls.map(call => call[0])).toEqual(['model/list', 'model/list'])
    expect(request.mock.calls[1]?.[1]).toEqual({ limit: 100, includeHidden: false, cursor: 'second' })
  })
  it.each([
    { data: 'invalid' },
    { data: Array.from({ length: 201 }, () => ({ model: 'too-many' })) },
    { data: [], nextCursor: 'loop' },
  ])('rejects malformed, oversized, or looping catalogs', async result => {
    const client = new CodexClient('unused', vi.fn())
    vi.spyOn(client, 'ensureStarted').mockResolvedValue()
    vi.spyOn(client, 'request').mockResolvedValue(result)
    await expect(client.listModels()).rejects.toThrow(/catalog/)
  })
  it('never treats creation, discovery, or cache dates as a release date', () => {
    expect(parseCodexModels([{ model: 'old', created: 100, firstSeenAt: '2026-09-22', fetchedAt: '2026-09-22' }])[0])
      .not.toHaveProperty('releasedAt')
  })
})

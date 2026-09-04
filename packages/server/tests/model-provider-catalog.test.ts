import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  ModelProviderCatalogService,
  parseModelProviderCatalog,
} from '../src/services/model-provider-catalog.js'
import { BUNDLED_MODEL_PROVIDER_CATALOG } from '../src/services/builtin-model-providers.js'

const roots: string[] = []
const require_ = createRequire(import.meta.url)
const REPO_CATALOG_PATH = require_.resolve('../../../catalog/model-providers.json')

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function stateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-hub-catalog-'))
  roots.push(root)
  return root
}

function response(body: unknown, ok = true): Response {
  return new Response(JSON.stringify(body), { status: ok ? 200 : 500 })
}

describe('parseModelProviderCatalog', () => {
  it('accepts the bundled snapshot unchanged', () => {
    const parsed = parseModelProviderCatalog(BUNDLED_MODEL_PROVIDER_CATALOG)
    expect(parsed.providers.length).toBeGreaterThan(5)
    expect(parsed.providers.every((entry) => entry.signup.url.startsWith('https://'))).toBe(true)
  })

  it('rejects entries missing the signup guidance or with insecure links', () => {
    const base = structuredClone(BUNDLED_MODEL_PROVIDER_CATALOG)
    delete (base.providers[0] as { signup?: unknown }).signup
    expect(() => parseModelProviderCatalog(base)).toThrowError(/不合法/)
    const insecure = structuredClone(BUNDLED_MODEL_PROVIDER_CATALOG)
    ;(insecure.providers[1]!.signup as { url: string }).url = 'http://evil.example.com/key'
    expect(() => parseModelProviderCatalog(insecure)).toThrowError(/不合法/)
  })

  it('rejects duplicate ids, unknown api kinds and oversized documents', () => {
    const dupe = structuredClone(BUNDLED_MODEL_PROVIDER_CATALOG)
    dupe.providers[1]!.id = dupe.providers[0]!.id
    expect(() => parseModelProviderCatalog(dupe)).toThrowError(/不合法/)
    const badApi = structuredClone(BUNDLED_MODEL_PROVIDER_CATALOG)
    ;(badApi.providers[0] as { api: string }).api = 'telepathy'
    expect(() => parseModelProviderCatalog(badApi)).toThrowError(/不合法/)
  })

  it('drops malformed optional fields instead of rejecting the entry', () => {
    const document = structuredClone(BUNDLED_MODEL_PROVIDER_CATALOG)
    Object.assign(document.providers[0]!, { contextWindowHack: 1 })
    ;(document.providers[1] as { popularModels: unknown }).popularModels = ['ok', 42, '', 'x'.repeat(200)]
    const parsed = parseModelProviderCatalog(document)
    expect(parsed.providers[1]!.popularModels).toEqual(['ok'])
  })

  it('keeps the repository catalog and the bundled snapshot identical', async () => {
    const raw = await readFile(REPO_CATALOG_PATH, 'utf8')
    expect(JSON.parse(raw) as unknown).toEqual(BUNDLED_MODEL_PROVIDER_CATALOG)
  })
})

describe('ModelProviderCatalogService fallback chain', () => {
  it('uses a reachable remote and caches it', async () => {
    const root = await stateRoot()
    const remote = { ...structuredClone(BUNDLED_MODEL_PROVIDER_CATALOG), version: 'remote-1' }
    const service = new ModelProviderCatalogService({
      stateRoot: root,
      remoteUrl: 'https://example.test/catalog.json',
      fetch: vi.fn<typeof fetch>(async () => response(remote)),
    })
    const state = await service.state()
    expect(state.source).toBe('remote')
    expect(state.catalog.version).toBe('remote-1')
    const cached = JSON.parse(await readFile(join(root, 'model-hub', 'providers.json'), 'utf8')) as { version: string }
    expect(cached.version).toBe('remote-1')
  })

  it('falls back to the cache when the remote is unreachable', async () => {
    const root = await stateRoot()
    const first = new ModelProviderCatalogService({
      stateRoot: root,
      remoteUrl: 'https://example.test/catalog.json',
      fetch: vi.fn<typeof fetch>(async () => response({ ...BUNDLED_MODEL_PROVIDER_CATALOG, version: 'v-cache' })),
    })
    await first.state()
    const second = new ModelProviderCatalogService({
      stateRoot: root,
      remoteUrl: 'https://example.test/catalog.json',
      fetch: vi.fn<typeof fetch>(async () => { throw new Error('offline') }),
    })
    const state = await second.state()
    expect(state.source).toBe('cache')
    expect(state.catalog.version).toBe('v-cache')
    expect(state.notice).toContain('本地缓存')
  })

  it('rejects a malformed remote without ever replacing the cache', async () => {
    const root = await stateRoot()
    const seed = new ModelProviderCatalogService({
      stateRoot: root,
      remoteUrl: 'https://example.test/catalog.json',
      fetch: vi.fn<typeof fetch>(async () => response({ ...BUNDLED_MODEL_PROVIDER_CATALOG, version: 'good' })),
    })
    await seed.state()
    const poison = structuredClone(BUNDLED_MODEL_PROVIDER_CATALOG)
    delete (poison.providers[0] as { name?: string }).name
    const service = new ModelProviderCatalogService({
      stateRoot: root,
      remoteUrl: 'https://example.test/catalog.json',
      fetch: vi.fn<typeof fetch>(async () => response(poison)),
    })
    const state = await service.state()
    expect(state.source).toBe('cache')
    expect(state.catalog.version).toBe('good')
  })

  it('refreshes a same-version remote when its content hash changes', async () => {
    const root = await stateRoot()
    let remote = { ...structuredClone(BUNDLED_MODEL_PROVIDER_CATALOG), version: 'same-version' }
    const fetchMock = vi.fn<typeof fetch>(async () => response(remote))
    const service = new ModelProviderCatalogService({
      stateRoot: root,
      remoteUrl: 'https://example.test/catalog.json',
      fetch: fetchMock,
    })
    expect((await service.state()).catalog.providers[0]!.description).toBe(BUNDLED_MODEL_PROVIDER_CATALOG.providers[0]!.description)
    remote = { ...remote, providers: remote.providers.map((provider, index) => index === 0 ? { ...provider, description: '更新后的目录说明' } : provider) }
    expect((await service.state(true)).catalog.providers[0]!.description).toBe('更新后的目录说明')
  })

  it('lands on the bundled snapshot when nothing else exists', async () => {
    const root = await stateRoot()
    const service = new ModelProviderCatalogService({
      stateRoot: root,
      remoteUrl: '',
      fetch: vi.fn<typeof fetch>(async () => response({}, false)),
    })
    const state = await service.state()
    expect(state.source).toBe('bundled')
    expect(state.catalog.version).toBe(BUNDLED_MODEL_PROVIDER_CATALOG.version)
  })
})

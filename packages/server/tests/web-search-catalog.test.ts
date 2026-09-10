import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createWebSearchCatalog, parseWebSearchCatalog } from '../src/web-search-catalog.js'

const SAMPLE = `{
  "schemaVersion": 1,
  "version": "2026.09.10-1",
  "providers": [
    { "id": "deepseek", "name": "DeepSeek", "endpoint": "https://api.deepseek.com/anthropic/v1", "obtain": { "text": "获取", "url": "https://platform.deepseek.com/api_keys" }, "backend": "deepseek" },
    { "id": "firecrawl", "name": "Firecrawl", "description": "网页搜索", "endpoint": "https://api.firecrawl.dev", "obtain": { "url": "https://www.firecrawl.dev/app/sign-up" }, "backend": "firecrawl", "integrationId": "builtin.firecrawl" }
  ]
}`

afterEach(() => {
  delete process.env.DSH_CYBER_WEBSEARCH_CATALOG_PATH
})

describe('parseWebSearchCatalog', () => {
  it('accepts the checked-in shape and defaults optional fields', () => {
    const catalog = parseWebSearchCatalog(SAMPLE, 'test.json')
    expect(catalog.version).toBe('2026.09.10-1')
    expect(catalog.providers).toHaveLength(2)
    const firecrawl = catalog.providers[1]!
    expect(firecrawl.description).toBe('网页搜索')
    expect(firecrawl.obtain.text).toBe('获取 API 密钥')
    expect(firecrawl.integrationId).toBe('builtin.firecrawl')
  })

  it('rejects a catalog without providers or with an invalid endpoint', () => {
    expect(() => parseWebSearchCatalog(JSON.stringify({ schemaVersion: 1, version: 'x', providers: [] }), 'a')).toThrow('declares no providers')
    expect(() => parseWebSearchCatalog(JSON.stringify({ schemaVersion: 1, version: 'x', providers: [{ id: 'a', name: 'A', endpoint: 'not a url', obtain: { url: 'u' }, backend: 'deepseek' }] }), 'b')).toThrow('invalid endpoint')
  })
})

describe('createWebSearchCatalog', () => {
  it('reads the repository JSON pointed to by the path option', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-websearch-catalog-'))
    try {
      const file = join(directory, 'catalog.json')
      await writeFile(file, SAMPLE, 'utf8')
      const catalogSource = await createWebSearchCatalog({ path: file })
      expect(catalogSource.catalog().version).toBe('2026.09.10-1')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('falls back to the built-in catalog when the file is missing', async () => {
    const catalogSource = await createWebSearchCatalog({ path: join(tmpdir(), 'does-not-exist.json') })
    const catalog = catalogSource.catalog()
    expect(catalog.version).toBe('built-in')
    expect(catalog.providers.map((provider) => provider.id)).toEqual(['deepseek', 'firecrawl'])
  })

  it('honours the environment override and treats an empty override as built-in', async () => {
    process.env.DSH_CYBER_WEBSEARCH_CATALOG_PATH = ''
    const disabled = await createWebSearchCatalog()
    expect(disabled.catalog().version).toBe('built-in')
  })
})

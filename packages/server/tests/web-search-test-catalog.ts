import type { WebSearchProviderCatalog } from '@dsh-cyber/contracts'

/** Shared test catalog mirroring catalog/web-search-providers.json. */
export const TEST_CATALOG: WebSearchProviderCatalog = {
  schemaVersion: 1,
  version: 'test',
  providers: [
    {
      id: 'deepseek',
      name: 'DeepSeek',
      description: '',
      endpoint: 'https://api.deepseek.com/anthropic/v1',
      obtain: { text: '获取密钥', url: 'https://platform.deepseek.com/api_keys' },
      backend: 'deepseek',
    },
    {
      id: 'firecrawl',
      name: 'Firecrawl',
      description: '',
      endpoint: 'https://api.firecrawl.dev',
      obtain: { text: '获取密钥', url: 'https://www.firecrawl.dev/app/sign-up' },
      backend: 'firecrawl',
      integrationId: 'builtin.firecrawl',
    },
  ],
}

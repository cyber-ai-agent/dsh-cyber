import type { IntegrationDescriptor, IntegrationHealth, JsonObject } from '@dsh-cyber/contracts'

export interface IntegrationProviderContext {
  config: JsonObject
  credential?: string
  fetch: typeof globalThis.fetch
  now: Date
}

export interface IntegrationProvider {
  readonly descriptor: IntegrationDescriptor
  validateConfig(config: JsonObject): JsonObject
  testConnection(context: IntegrationProviderContext): Promise<IntegrationHealth>
}

/** Stable host registry shared by Firecrawl, Home Assistant, GitHub and future MCP providers. */
export class IntegrationRegistry {
  readonly #providers = new Map<string, IntegrationProvider>()

  register(provider: IntegrationProvider): () => void {
    const id = provider.descriptor.id.trim()
    if (!id) throw new Error('Integration id cannot be empty')
    if (this.#providers.has(id)) throw new Error(`Duplicate integration provider: ${id}`)
    if (provider.descriptor.secretFields.some((field) => field.kind !== 'secret')) {
      throw new Error(`Integration ${id} contains a non-secret field in secretFields`)
    }
    this.#providers.set(id, provider)
    return () => { if (this.#providers.get(id) === provider) this.#providers.delete(id) }
  }

  list(): IntegrationDescriptor[] {
    return [...this.#providers.values()]
      .map(({ descriptor }) => ({
        ...descriptor,
        configFields: descriptor.configFields.map((field) => ({ ...field })),
        secretFields: descriptor.secretFields.map((field) => ({ ...field })),
        skillIds: [...descriptor.skillIds],
        dataEgress: [...descriptor.dataEgress],
      }))
      .sort((left, right) => left.displayName.localeCompare(right.displayName, 'zh-CN'))
  }

  require(id: string): IntegrationProvider {
    const provider = this.#providers.get(id)
    if (provider === undefined) throw new Error(`Unknown integration provider: ${id}`)
    return provider
  }
}

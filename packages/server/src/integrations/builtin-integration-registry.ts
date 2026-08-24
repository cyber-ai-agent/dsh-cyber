import { FirecrawlIntegrationProvider } from './firecrawl-provider.js'
import { IntegrationRegistry } from './integration-registry.js'

export function createBuiltinIntegrationRegistry(): IntegrationRegistry {
  const registry = new IntegrationRegistry()
  registry.register(new FirecrawlIntegrationProvider())
  return registry
}

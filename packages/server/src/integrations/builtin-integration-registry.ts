import { FirecrawlIntegrationProvider } from './firecrawl-provider.js'
import { IntegrationRegistry } from './integration-registry.js'
import { OfficialMcpClientFactory, type McpClientFactory } from './mcp-client.js'
import { McpIntegrationProvider } from './mcp-provider.js'
import { SshDeviceIntegrationProvider } from './ssh-provider.js'
import { WebSearchIntegrationProvider } from './web-search-provider.js'

export function createBuiltinIntegrationRegistry(mcpClients: McpClientFactory = new OfficialMcpClientFactory()): IntegrationRegistry {
  const registry = new IntegrationRegistry()
  registry.register(new WebSearchIntegrationProvider())
  registry.register(new FirecrawlIntegrationProvider())
  registry.register(new McpIntegrationProvider(mcpClients))
  registry.register(new SshDeviceIntegrationProvider())
  return registry
}

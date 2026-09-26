import type { SqliteStore } from '@dsh-cyber/persistence'

import type { FirecrawlClient } from '../integrations/firecrawl-client.js'
import type { IntegrationService } from '../integrations/integration-service.js'
import type { McpClientFactory } from '../integrations/mcp-client.js'
import { KnowledgeWebImportService } from '../services/knowledge-web-import-service.js'
import { McpResourceKnowledgeService } from '../services/mcp-resource-knowledge-service.js'
import type { WorldKnowledgeLibraryService } from '../services/world-knowledge-library-service.js'

/** Both remote import paths end in the same world-owned local knowledge library. */
export function composeKnowledgeImports(options: {
  store: SqliteStore
  integrations: IntegrationService
  mcpClients: McpClientFactory
  library: WorldKnowledgeLibraryService
  firecrawlClient: FirecrawlClient
}) {
  return {
    web: new KnowledgeWebImportService({ client: options.firecrawlClient, library: options.library }),
    mcpResources: new McpResourceKnowledgeService({
      store: options.store,
      integrations: options.integrations,
      clients: options.mcpClients,
      library: options.library,
    }),
  }
}

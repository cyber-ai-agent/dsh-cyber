import { ModelProviderCatalogService } from './services/model-provider-catalog.js'
import { ModelProviderBalanceService } from './services/model-provider-balance.js'
import { ModelCapabilityProbeService } from './services/model-capability-probe.js'

export const DEFAULT_MODEL_CATALOG_URL =
  'https://raw.githubusercontent.com/cyber-ai-agent/dsh-cyber/main/catalog/model-providers.json'

export interface ModelHubServices {
  providerCatalog: ModelProviderCatalogService
  balance: ModelProviderBalanceService
  probe: ModelCapabilityProbeService
}

/**
 * Composition of the model-hub services, kept out of the server composition
 * root. The built-in provider catalog refreshes from the pinned upstream copy
 * when reachable and always degrades to the local cache or the bundled
 * snapshot; set DSH_CYBER_MODEL_CATALOG_URL to an empty value to disable the
 * remote fetch entirely.
 */
export function createModelHubServices(options: { stateRoot: string }): ModelHubServices {
  const override = process.env.DSH_CYBER_MODEL_CATALOG_URL
  return {
    providerCatalog: new ModelProviderCatalogService({
      stateRoot: options.stateRoot,
      remoteUrl: override === undefined ? DEFAULT_MODEL_CATALOG_URL : override,
    }),
    balance: new ModelProviderBalanceService(),
    probe: new ModelCapabilityProbeService(),
  }
}

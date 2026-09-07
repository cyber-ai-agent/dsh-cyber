import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ModelProviderCatalogService } from './services/model-provider-catalog.js'
import { ModelProviderBalanceService } from './services/model-provider-balance.js'
import { ModelCapabilityProbeService } from './services/model-capability-probe.js'

export const DEFAULT_MODEL_CATALOG_URL =
  'https://raw.githubusercontent.com/cyber-ai-agent/dsh-cyber/main/catalog/model-providers.json'

/** The checked-in catalog next to this package is the local source of truth. */
export const DEFAULT_MODEL_CATALOG_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../catalog/model-providers.json',
)

export interface ModelHubServices {
  providerCatalog: ModelProviderCatalogService
  balance: ModelProviderBalanceService
  probe: ModelCapabilityProbeService
}

/**
 * Composition of the model-hub services, kept out of the server composition
 * root. The checked-in repository catalog is read first, so changing
 * catalog/model-providers.json is reflected by the local server after a
 * forced refresh or TTL expiry. DSH_CYBER_MODEL_CATALOG_PATH can point at another file (or be
 * empty to disable the repository source). DSH_CYBER_MODEL_CATALOG_URL is an
 * explicit remote fallback; the state-root cache and bundled snapshot remain
 * the final fallbacks.
 */
export function createModelHubServices(options: { stateRoot: string; catalogPath?: string }): ModelHubServices {
  const pathOverride = process.env.DSH_CYBER_MODEL_CATALOG_PATH
  const configuredPath = options.catalogPath ?? (pathOverride === undefined ? DEFAULT_MODEL_CATALOG_PATH : pathOverride)
  const override = process.env.DSH_CYBER_MODEL_CATALOG_URL
  return {
    providerCatalog: new ModelProviderCatalogService({
      stateRoot: options.stateRoot,
      ...(configuredPath.trim() ? { catalogPath: configuredPath } : {}),
      ...(override === undefined || !override.trim() ? {} : { remoteUrl: override }),
    }),
    balance: new ModelProviderBalanceService(),
    probe: new ModelCapabilityProbeService(),
  }
}

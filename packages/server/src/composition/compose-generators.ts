import type { SqliteStore } from '@dsh-cyber/persistence'

import type { Router } from '../http/router.js'
import { registerCharacterGeneratorRoutes, type CharacterGeneratorRoutesDependencies } from '../routes/character-generator-routes.js'
import { registerPluginGeneratorRoutes, type PluginGeneratorRoutesDependencies } from '../routes/plugin-generator-routes.js'
import { registerSkinGeneratorRoutes, type SkinGeneratorRoutesDependencies } from '../routes/skin-generator-routes.js'
import { registerWorldGeneratorRoutes, type WorldGeneratorRoutesDependencies } from '../routes/world-generator-routes.js'
import type { composeCharacterGeneratorMarketplace } from '../services/character-generator-marketplace.js'
import { CharacterImportAnalyzer, type CharacterImportAnalyzerPort } from '../services/character-import-analyzer.js'
import type { ModelCredentialService } from '../services/model-credential-service.js'
import { PluginImportAnalyzer, type PluginImportAnalyzerPort } from '../services/plugin-import-analyzer.js'
import { SkinImportAnalyzer, type SkinImportAnalyzerPort } from '../services/skin-import-analyzer.js'
import type { SkillCatalogService } from '../services/skill-catalog-service.js'
import { WorldImportAnalyzer, type WorldImportAnalyzerPort } from '../services/world-import-analyzer.js'

export type { CharacterImportAnalyzerPort, PluginImportAnalyzerPort, SkinImportAnalyzerPort, WorldImportAnalyzerPort }

/** Analyzer overrides; tests and CI pass deterministic stubs so no run calls a cloud model. */
export interface GeneratorAnalyzerOverrides {
  characterImportAnalyzer?: CharacterImportAnalyzerPort
  worldImportAnalyzer?: WorldImportAnalyzerPort
  skinImportAnalyzer?: SkinImportAnalyzerPort
  pluginImportAnalyzer?: PluginImportAnalyzerPort
}

/**
 * Wires the four generators (character, world, skin, plugin) to what they share.
 *
 * Every generator publishes into the same workspace-scoped marketplace roots
 * behind the same containment root, and every analyzer reads the same store
 * and credentials. Composing them here keeps that sharing in one place and
 * keeps `server.ts` inside its composition-root line budget, the same split
 * `composeWorldTrace` and `composeWorkSystem` already make.
 */
export function composeGenerators(options: {
  store: SqliteStore
  credentials: ModelCredentialService
  skillCatalog: SkillCatalogService
  packageCatalog: CharacterGeneratorRoutesDependencies['packageCatalog'] & WorldGeneratorRoutesDependencies['packageCatalog'] & SkinGeneratorRoutesDependencies['packageCatalog'] & PluginGeneratorRoutesDependencies['packageCatalog']
  marketplace: Awaited<ReturnType<typeof composeCharacterGeneratorMarketplace>>
  overrides: GeneratorAnalyzerOverrides
}): { registerGeneratorRoutes(router: Router): void } {
  const { store, credentials, skillCatalog, packageCatalog, marketplace, overrides } = options
  const characterAnalyzer = overrides.characterImportAnalyzer ?? new CharacterImportAnalyzer(store, credentials, skillCatalog)
  const worldAnalyzer = overrides.worldImportAnalyzer ?? new WorldImportAnalyzer(store, credentials, skillCatalog)
  const skinAnalyzer = overrides.skinImportAnalyzer ?? new SkinImportAnalyzer(store, credentials)
  const pluginAnalyzer = overrides.pluginImportAnalyzer ?? new PluginImportAnalyzer(store, credentials)
  const roots = { resolveMarketplaceRoot: marketplace.resolveMarketplaceRoot, containmentRoot: marketplace.containmentRoot }
  return {
    registerGeneratorRoutes(router) {
      registerCharacterGeneratorRoutes(router, { store, packageCatalog, skillCatalog, analyzer: characterAnalyzer, ...roots })
      registerWorldGeneratorRoutes(router, { store, packageCatalog, skillCatalog, analyzer: worldAnalyzer, ...roots })
      registerSkinGeneratorRoutes(router, { store, packageCatalog, analyzer: skinAnalyzer, ...roots })
      registerPluginGeneratorRoutes(router, { store, packageCatalog, analyzer: pluginAnalyzer, ...roots })
    },
  }
}

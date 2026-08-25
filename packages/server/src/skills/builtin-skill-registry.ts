import { HomeAssistantSkillAdapter, type HomeAssistantSkillAdapterOptions } from './home-assistant-adapter.js'
import { registerBuiltinSkillRecipes } from './builtin-skill-recipes.js'
import { FirecrawlSkillAdapter } from './firecrawl-skill-adapter.js'
import { CharacterSkillAdapterRegistry } from './skill-adapter.js'
import { WorldManagementAdapter, type WorldManagementHost } from './world-management-adapter.js'

export interface BuiltinSkillRegistryOptions {
  homeAssistant?: HomeAssistantSkillAdapterOptions
  firecrawl?: ConstructorParameters<typeof FirecrawlSkillAdapter>[0]
  worldManagement?: WorldManagementHost
}

/**
 * Host composition root for trusted skill adapters.
 * Adding an adapter never changes CharacterSkillRuntime or the Agent loop.
 */
export function createBuiltinSkillRegistry(
  options: BuiltinSkillRegistryOptions = {},
): CharacterSkillAdapterRegistry {
  const registry = new CharacterSkillAdapterRegistry()
  registerBuiltinSkillRecipes(registry)
  registry.register(new HomeAssistantSkillAdapter(options.homeAssistant))
  if (options.firecrawl !== undefined) registry.register(new FirecrawlSkillAdapter(options.firecrawl))
  if (options.worldManagement !== undefined) registry.register(new WorldManagementAdapter(options.worldManagement))
  return registry
}

import { HomeAssistantSkillAdapter, type HomeAssistantSkillAdapterOptions } from './home-assistant-adapter.js'
import { BrowserSkillAdapter, type BrowserSkillAdapterOptions } from './browser-skill-adapter.js'
import { registerBuiltinSkillRecipes } from './builtin-skill-recipes.js'
import { FirecrawlSkillAdapter } from './firecrawl-skill-adapter.js'
import { CharacterSkillAdapterRegistry } from './skill-adapter.js'
import { WorldManagementAdapter, type WorldManagementHost } from './world-management-adapter.js'
import { SshSkillAdapter, type SshSkillAdapterOptions } from './ssh-skill-adapter.js'

export { createConnectionGrantsResolver } from './ssh-skill-adapter.js'

export interface BuiltinSkillRegistryOptions {
  homeAssistant?: HomeAssistantSkillAdapterOptions
  firecrawl?: ConstructorParameters<typeof FirecrawlSkillAdapter>[0]
  browser?: BrowserSkillAdapterOptions
  worldManagement?: WorldManagementHost
  ssh?: SshSkillAdapterOptions
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
  if (options.browser !== undefined) registry.register(new BrowserSkillAdapter(options.browser))
  if (options.worldManagement !== undefined) registry.register(new WorldManagementAdapter(options.worldManagement))
  if (options.ssh !== undefined) registry.register(new SshSkillAdapter(options.ssh))
  return registry
}

import { HomeAssistantSkillAdapter, type HomeAssistantSkillAdapterOptions } from './home-assistant-adapter.js'
import { CharacterSkillAdapterRegistry } from './skill-adapter.js'

export interface BuiltinSkillRegistryOptions {
  homeAssistant?: HomeAssistantSkillAdapterOptions
}

/**
 * Host composition root for trusted skill adapters.
 * Adding an adapter never changes CharacterSkillRuntime or the Agent loop.
 */
export function createBuiltinSkillRegistry(
  options: BuiltinSkillRegistryOptions = {},
): CharacterSkillAdapterRegistry {
  const registry = new CharacterSkillAdapterRegistry()
  registry.register(new HomeAssistantSkillAdapter(options.homeAssistant))
  return registry
}

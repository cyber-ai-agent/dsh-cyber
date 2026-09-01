import type { World, WorldThemeManifestV1 } from '@dsh-cyber/contracts'
import { aiAcademyTheme, cyberCompanyTheme, jarvisCoreTheme, knowledgeGardenTheme, maidPalaceTheme, moonlitTavernTheme, newsCenterTheme } from '@dsh-cyber/world-runtime'

/**
 * Resolve the built-in scene owned by a World.
 *
 * This deliberately does not inspect the active application Skin. A Skin may
 * decorate the shell and conversation surface, but the World Runtime scene is
 * selected by the World template or its durable server-side scene binding.
 */
export function resolveBuiltInWorldScene(world: Pick<World, 'templateId'>): WorldThemeManifestV1 {
  if (world.templateId === 'personal-world') {
    return {
      ...cyberCompanyTheme,
      id: 'dsh-cyber.personal.default',
      version: '1.0.0',
      templateId: 'personal-world',
      displayName: '我的世界 · 默认空间',
      terminology: {
        ...cyberCompanyTheme.terminology,
        world: '世界',
        participant: '角色',
        session: '会话',
        milestone: '成长记录',
      },
    }
  }
  if (world.templateId === 'tavern' || world.templateId === 'moonlit-tavern') return moonlitTavernTheme
  if (world.templateId === 'maid-atelier' || world.templateId === 'maid-palace') return maidPalaceTheme
  if (world.templateId === 'ai-academy' || world.templateId === 'academy') return aiAcademyTheme
  if (world.templateId === 'jarvis-core' || world.templateId === 'jarvis') return jarvisCoreTheme
  if (world.templateId === 'knowledge-garden' || world.templateId === 'garden') return knowledgeGardenTheme
  if (world.templateId === 'news-center' || world.templateId === 'news') return newsCenterTheme
  return cyberCompanyTheme
}

/** User-facing terminology. Internally the v1 runtime still calls these world themes for compatibility. */
export const WORLD_SCENE_LABEL = '世界场景'

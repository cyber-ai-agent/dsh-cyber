import type { WorldThemeManifestV1 } from '@dsh-cyber/contracts'

import { cyberCompanyTheme } from './cyber-company.js'

/**
 * A safe built-in visual fallback for the generic personal world.
 * It deliberately reuses the proven Pixi scene contract while giving the
 * world an independent template identity. Users can replace it with a theme
 * package without changing their characters, conversations, files or settings.
 */
export const personalWorldTheme: WorldThemeManifestV1 = {
  ...cyberCompanyTheme,
  id: 'personal-world-default',
  version: '1.0.0',
  templateId: 'personal-world',
  displayName: '我的世界 · 默认空间',
  terminology: {
    ...cyberCompanyTheme.terminology,
    agent: '角色',
    recruit: '添加角色',
    groupSession: '群组会话',
    assignment: '任务',
  },
}

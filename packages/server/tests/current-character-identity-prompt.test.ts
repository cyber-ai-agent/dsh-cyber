import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'
import type { EmployeeInstance } from '@dsh-cyber/contracts'

import { WorldRootService } from '../src/services/world-root-service.js'
import { WorldSettingsService } from '../src/services/world-settings-service.js'

describe('world prompt character identity boundary', () => {
  it('does not inject the original template job title as the current identity', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-cyber-world-identity-'))
    const settings = new WorldSettingsService(new WorldRootService(stateRoot))
    const character: EmployeeInstance = {
      id: 'character-tuanzi',
      workspaceId: 'workspace-1',
      worldId: 'world-1',
      blueprintId: 'legacy.secretary',
      blueprintVersion: 1,
      displayName: '团子',
      role: '秘书',
      status: 'available',
      currentRevision: 2,
      createdAt: '2026-08-23T00:00:00.000Z',
      updatedAt: '2026-08-23T00:00:00.000Z',
    }

    const prompt = await settings.composeRuntimePrompt(character.worldId, character, '陪我聊一会。')

    expect(prompt).toContain('持久角色“团子”')
    expect(prompt).toContain('最新角色 Persona / Identity 契约')
    expect(prompt).toContain('初始岗位只属于来源元数据')
    expect(prompt).toContain('最终回复、可展示的判断摘要、计划和工具使用说明统一使用简体中文')
    expect(prompt).not.toContain('身份为“秘书”')
    expect(prompt).not.toContain('秘书')
  })
})

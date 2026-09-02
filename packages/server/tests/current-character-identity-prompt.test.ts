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

    const { text, revision } = await settings.composeWorldContext({ worldId: character.worldId, character, lane: 'direct' })

    expect(revision).toBe(0)
    expect(text).toContain('持久角色“团子”')
    expect(text).toContain('最新角色 Persona / Identity 契约')
    expect(text).toContain('初始岗位只属于来源元数据')
    expect(text).toContain('最终回复、可展示的判断摘要、计划和工具使用说明统一使用简体中文')
    expect(text).not.toContain('身份为“秘书”')
    expect(text).not.toContain('秘书')
  })

  it('renders the same rules byte-for-byte across turns and moves only with the settings revision', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-cyber-world-identity-'))
    const settings = new WorldSettingsService(new WorldRootService(stateRoot))
    const character = { id: 'character-1', worldId: 'world-1', displayName: '团子' } as EmployeeInstance

    const first = await settings.composeWorldContext({ worldId: 'world-1', character, lane: 'direct' })
    const again = await settings.composeWorldContext({ worldId: 'world-1', character, lane: 'direct' })
    expect(again).toEqual(first)
    // Nothing per-turn leaks into the layer: no clock, no counter.
    expect(first.text).not.toMatch(/\d{4}-\d{2}-\d{2}T/)

    await settings.save('world-1', { lore: '雨夜学院' })
    const edited = await settings.composeWorldContext({ worldId: 'world-1', character, lane: 'direct' })
    expect(edited.revision).toBe(first.revision + 1)
    expect(edited.text).toContain('世界观：雨夜学院')

    const group = await settings.composeWorldContext({ worldId: 'world-1', character, lane: 'group' })
    expect(group.text).toContain('多人会话中的每个角色都必须保持自己的当前身份')
    expect(group.text).not.toContain('持久角色“团子”')
  })
})

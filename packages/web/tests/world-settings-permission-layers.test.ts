import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { resolveInheritedModel, WorldSettingsDialog } from '../src/components/WorldSettingsDialog.js'

describe('WorldSettingsDialog permission layers', () => {
  it('keeps world settings focused on world configuration and role capability guidance', () => {
    const markup = renderToStaticMarkup(createElement(WorldSettingsDialog, {
      world: { id: 'world-1', name: '石墨世界', workspaceId: 'workspace-1', templateId: 'cyber-company', status: 'active' } as never,
      value: {
        schemaVersion: 1,
        worldId: 'world-1',
        lore: '',
        scenario: '',
        userIdentity: { displayName: '', worldRole: '', addressAs: '' },
        terminology: { characterSingular: '角色', characterPlural: '角色', addCharacterVerb: '添加角色', groupConversation: '群聊', assignment: '任务' },
        appearance: { accentColor: '#e0a72f', pageBackground: '#080b0d', panelBackground: '#0d1114', ownerBubbleColor: '#1a2b1d', characterBubbleColor: '#12171b', textColor: '#edf1f2', mutedTextColor: '#9aa6ad', panelRadius: 7, bubbleRadius: 7, buttonRadius: 4, fontScale: 1 },
        model: { reasoningEffort: 'auto', responseLanguage: 'zh-CN' },
        runtime: { permissionMode: 'danger-full-access' },
        updatedAt: '2026-08-25T08:00:00.000Z',
      } as never,
      models: [],
      modelAssignments: [],
      employees: [],
      saving: false,
      onClose: () => undefined,
      onSave: async () => undefined,
    }))
    expect(markup).toContain('技能与工具')
    expect(markup).toContain('回复偏好语言')
    expect(markup).toContain('简体中文（默认）')
    expect(markup).toContain('会话皮肤')
    expect(markup).toContain('世界场景属于 World 本身')
    expect(markup).not.toContain('世界专属空间皮肤')
    expect(markup).not.toContain('世界内文件权限')
    expect(markup).not.toContain('完整访问：读写此电脑')
    expect(markup).not.toContain('本次电脑访问')
    expect(markup).not.toContain('permission-risk-confirm')
  })

  it('uses the workspace model as the inheritance target when a world override exists', () => {
    const models = [
      { id: 'world-model', modelId: 'world-model-id', displayName: '世界覆盖模型', isDefault: false, settings: {} },
      { id: 'workspace-model', modelId: 'workspace-model-id', displayName: '工作区默认模型', isDefault: false, settings: {} },
    ] as never
    const assignments = [
      { id: 'world-assignment', scope: 'world', scopeId: 'world-1', modelProfileId: 'world-model' },
      { id: 'workspace-assignment', scope: 'workspace', scopeId: 'workspace-1', modelProfileId: 'workspace-model' },
    ] as never

    expect(resolveInheritedModel(models, assignments, 'workspace-1')?.id).toBe('workspace-model')
  })
})

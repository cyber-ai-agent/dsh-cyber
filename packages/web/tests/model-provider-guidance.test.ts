import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ModelProfile } from '@dsh-cyber/contracts'
import { MODEL_PRESETS, SettingsDialog } from '../src/components/SettingsDialog.js'
import { setUiLocale } from '../src/i18n/runtime.js'

const agnes: ModelProfile = {
  id: 'agnes-profile', workspaceId: 'workspace-1', displayName: 'Agnes AI',
  providerKind: 'openai-compatible-remote', baseUrl: 'https://apihub.agnes-ai.com/v1',
  modelId: 'Agnes-2.5-Pro-Beta', api: 'openai-completions', isDefault: true,
  credentialEnvName: 'DSH_CYBER_MODEL_KEY_AGNES', settings: { providerId: 'agnes' },
  createdAt: '2026-09-02T00:00:00.000Z', updatedAt: '2026-09-02T00:00:00.000Z',
}

describe('model provider guidance', () => {
  beforeEach(() => setUiLocale('zh-CN'))

  it('offers Agnes as a default provider and exposes an official key-registration path', () => {
    const html = renderToStaticMarkup(createElement(SettingsDialog, {
      initialSection: 'models',
      preferences: { locale: 'zh-CN', colorScheme: 'dark', skinId: 'default', customBackground: '', backgroundFit: 'cover', backgroundPosition: 'center', backgroundOpacity: 0.1, panelScale: 1, developerMode: false, messageHistoryPageSize: 50 },
      models: [agnes], assignments: [],
      workspace: { id: 'workspace-1', name: '工作区', createdAt: '2026-09-02T00:00:00.000Z', updatedAt: '2026-09-02T00:00:00.000Z' },
      worlds: [], employees: [], saving: false,
      onClose: vi.fn(), onSavePreferences: vi.fn(), onUploadBackground: vi.fn(), onSaveModel: vi.fn(),
      onDiscoverModels: vi.fn(), onDeleteModel: vi.fn(), onAssignModel: vi.fn(), onSystemAction: vi.fn(),
      onLoadModelLogs: vi.fn(), onClearModelLogs: vi.fn(),
    }))
    expect(html).toContain('Agnes AI')
    const preset = MODEL_PRESETS.find((item) => item.id === 'agnes')
    expect(preset).toMatchObject({
      baseUrl: 'https://apihub.agnes-ai.com/v1',
      helpUrl: 'https://beta.agnes-ai.com/',
      providerKind: 'openai-compatible-remote',
      api: 'openai-completions',
    })
    expect(preset?.description).toContain('多模态模型服务')
    expect(MODEL_PRESETS.filter((item) => !item.id.startsWith('custom-')).every((item) => item.helpUrl)).toBe(true)
  })
})

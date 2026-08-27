import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ModelProfile } from '@dsh-cyber/contracts'

import { ModelPicker, filterModelPickerGroups, modelPickerGroups } from '../src/features/models/ModelPicker.js'
import { setUiLocale } from '../src/i18n/runtime.js'

function model(overrides: Partial<ModelProfile> = {}): ModelProfile {
  return {
    id: 'profile-a',
    workspaceId: 'workspace-1',
    displayName: '研发模型连接',
    providerKind: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    modelId: 'deepseek-chat',
    api: 'openai-completions',
    isDefault: false,
    settings: {},
    createdAt: '2026-08-28T00:00:00.000Z',
    updatedAt: '2026-08-28T00:00:00.000Z',
    ...overrides,
  }
}

describe('ModelPicker', () => {
  beforeEach(() => setUiLocale('zh-CN'))

  it('renders inherited state and groups profiles into provider and model layers', () => {
    const models = [
      model({ settings: { providerId: 'deepseek', contextWindow: 64_000, capabilities: ['coding', 'tool-use'] } }),
      model({ id: 'profile-b', displayName: '备用连接', providerKind: 'deepseek', modelId: 'qwen3:14b', credentialEnvName: 'DSH_CYBER_MODEL_KEY_TEST', settings: { providerId: 'deepseek' } }),
    ]
    const html = renderToStaticMarkup(createElement(ModelPicker, {
      models,
      ariaLabel: '世界默认模型',
      inheritLabel: '继承全局或角色设置',
      initiallyOpen: true,
      onChange: vi.fn(),
    }))

    expect(html).toContain('继承全局或角色设置')
    expect(html).toContain('DeepSeek')
    expect(html).toContain('备用连接')
    expect(html).toContain('deepseek-chat')
    expect(html).toContain('qwen3:14b')
    expect(html).toContain('已配置')
    expect(html).toContain('能力 coding, tool-use')
    expect(html).toContain('上下文')
    expect(html).toContain('2 个模型')
  })

  it('searches provider, model, id and trusted capability metadata', () => {
    const models = [model({ settings: { providerId: 'deepseek', capabilities: ['coding'] } }), model({ id: 'profile-b', modelId: 'qwen3', settings: { providerId: 'custom-local', capabilities: ['vision'] } })]
    const groups = modelPickerGroups(models, 'zh-CN')
    expect(filterModelPickerGroups(groups, 'qwen3').flatMap((group) => group.models).map((item) => item.id)).toEqual(['profile-b'])
    expect(filterModelPickerGroups(groups, 'vision').flatMap((group) => group.models).map((item) => item.id)).toEqual(['profile-b'])
    expect(filterModelPickerGroups(groups, 'deepseek').flatMap((group) => group.models)).toHaveLength(1)
  })

  it('keeps the closed trigger keyboard-focusable and omits absent metadata', () => {
    const html = renderToStaticMarkup(createElement(ModelPicker, {
      models: [model({ settings: {} })],
      value: 'profile-a',
      onChange: vi.fn(),
    }))
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('研发模型连接 · deepseek-chat')
    expect(html).not.toContain('能力')
    expect(html).not.toContain('上下文')
  })
})

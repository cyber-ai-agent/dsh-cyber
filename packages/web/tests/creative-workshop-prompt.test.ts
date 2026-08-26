import { describe, expect, it } from 'vitest'
import type { WorldTemplateManifest } from '@dsh-cyber/contracts'
import type { EmbodimentPresetDescriptor } from '@dsh-cyber/contracts/creative-platform'

import { analyzeWorkshopPrompt } from '../src/components/creative-workshop/prompt-parser.js'

const templates = [
  { schemaVersion: 1, id: 'personal-world', version: 1, displayName: '我的世界', summary: '' },
  { schemaVersion: 1, id: 'creator-studio', version: 1, displayName: '自媒体工作室', summary: '' },
] as WorldTemplateManifest[]

const presets = [{
  id: 'general',
  displayName: '通用角色',
  description: '',
  profile: {
    roleTags: ['general'],
    preferredZoneTags: ['public'],
    preferredFacilityCapabilities: ['collaboration'],
    allowedZoneTags: ['public'],
    homeSlotTags: ['public'],
    ambientBehaviors: ['observe-world'],
    socialPolicy: { canInitiateConversation: false, cooldownSeconds: 1800, maxDailyConversations: 0 },
  },
}] as EmbodimentPresetDescriptor[]

describe('creative workshop prompt parser', () => {
  it('turns a natural language description into a guided draft', () => {
    const result = analyzeWorkshopPrompt('# 短剧增长工作室\n创建一个负责短剧制作和复盘的团队。角色：编剧、审校', templates, presets)
    expect(result.source).toBe('text')
    expect(result.draft.displayName).toBe('短剧增长工作室')
    expect(result.draft.baseTemplateId).toBe('creator-studio')
    expect(result.draft.scenario).toContain('短剧制作')
    expect(result.draft.roles.map((role) => role.displayName)).toEqual(['编剧', '审校'])
  })

  it('accepts a complete JSON prompt and preserves role intent', () => {
    const result = analyzeWorkshopPrompt(JSON.stringify({
      world: { name: '研究站', templateId: 'personal-world', goal: '分析观测数据' },
      roles: [{ name: '观测员', identity: '研究员', responsibilities: '负责样本分析', skills: ['scientific-reasoning'] }],
    }), templates, presets)
    expect(result.source).toBe('json')
    expect(result.draft.displayName).toBe('研究站')
    expect(result.draft.scenario).toBe('分析观测数据')
    expect(result.draft.roles[0]).toMatchObject({ displayName: '观测员', role: '研究员', requestedSkillIds: ['scientific-reasoning'] })
  })

  it('returns a user-facing error for malformed JSON', () => {
    expect(() => analyzeWorkshopPrompt('{"world":', templates, presets)).toThrow('提示词 JSON 无法解析')
  })
})

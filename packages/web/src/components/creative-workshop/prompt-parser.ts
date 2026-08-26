import type { WorldTemplateManifest } from '@dsh-cyber/contracts'
import type { EmbodimentPresetDescriptor } from '@dsh-cyber/contracts/creative-platform'

import { createEmptyWorkshopDraft, createRoleDraft, type WorkshopDraft, type WorkshopRoleDraft } from './model.js'

export interface WorkshopPromptAnalysis {
  draft: WorkshopDraft
  reply: string
  source: 'text' | 'json'
}

export function analyzeWorkshopPrompt(
  input: string,
  templates: readonly WorldTemplateManifest[],
  presets: readonly EmbodimentPresetDescriptor[],
  currentDraft?: WorkshopDraft,
): WorkshopPromptAnalysis {
  const source = input.trim()
  if (source.length === 0) throw new Error('请先描述你想创建的世界')
  const preset = presets[0]
  if (preset === undefined) throw new Error('当前没有可用的角色行为预设')

  const parsed = parseJsonPrompt(source)
  if (parsed !== undefined) {
    return { draft: draftFromRecord(parsed, templates, presets, currentDraft), reply: '我已读取这份 JSON，可以直接生成世界。', source: 'json' }
  }
  const draft = draftFromText(source, templates, preset, currentDraft)
  return { draft, reply: '我已理解这段描述，可以直接生成世界。', source: 'text' }
}

function parseJsonPrompt(value: string): Record<string, unknown> | undefined {
  const candidate = value.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  if (!candidate.startsWith('{') && !candidate.startsWith('[')) return undefined
  try {
    const parsed: unknown = JSON.parse(candidate)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    throw new Error('JSON 顶层需要是对象')
  } catch (cause) {
    throw new Error(`提示词 JSON 无法解析：${cause instanceof Error ? cause.message : '格式不正确'}`)
  }
}

function draftFromRecord(
  input: Record<string, unknown>,
  templates: readonly WorldTemplateManifest[],
  presets: readonly EmbodimentPresetDescriptor[],
  currentDraft?: WorkshopDraft,
): WorkshopDraft {
  const nestedWorld = record(input.world) ?? record(input.worldDefinition) ?? {}
  const source = { ...input, ...nestedWorld }
  const fallback = currentDraft ?? createEmptyWorkshopDraft(templates[0]?.id ?? 'personal-world', presets[0]!)
  const templateId = chooseTemplate(stringValue(source.baseTemplateId, source.templateId, source.template), templates, fallback.baseTemplateId)
  const rawRoles = arrayValue(source.roles, source.characters, source.agents, source.team)
  const roles = rawRoles.length === 0
    ? fallback.roles
    : rawRoles.map((item, index) => roleFromValue(item, index, presets[index % presets.length] ?? presets[0]!, fallback.roles[index]))
  return {
    ...fallback,
    displayName: stringValue(source.displayName, source.name, source.title) ?? fallback.displayName,
    baseTemplateId: templateId,
    lore: stringValue(source.lore, source.background, source.rules) ?? fallback.lore,
    scenario: stringValue(source.scenario, source.goal, source.objective, source.description, source.prompt) ?? fallback.scenario,
    roles,
  }
}

function draftFromText(
  input: string,
  templates: readonly WorldTemplateManifest[],
  preset: EmbodimentPresetDescriptor,
  currentDraft?: WorkshopDraft,
): WorkshopDraft {
  const fallback = currentDraft ?? createEmptyWorkshopDraft(chooseTemplate(input, templates, templates[0]?.id ?? 'personal-world'), preset)
  const title = input.match(/(?:世界名称|世界名|名称|标题)\s*[:：]\s*([^\n]+)/)?.[1]?.trim()
    ?? input.match(/^#\s+(.+)$/m)?.[1]?.trim()
  const roleLines = [...input.matchAll(/(?:角色|人物|成员|团队成员)\s*[:：]\s*([^\n]+)/g)]
    .flatMap((match) => (match[1] ?? '').split(/[、,，]/).map((item) => item.trim()).filter(Boolean))
  const roles = roleLines.length === 0
    ? fallback.roles.some((role) => role.displayName.trim() || role.role.trim())
      ? fallback.roles
      : [roleFromValue({ displayName: '管家', role: '世界管理员', summary: '帮助维护这个世界并协调后续角色。' }, 0, preset, fallback.roles[0])]
    : roleLines.slice(0, 16).map((name, index) => roleFromValue({ displayName: name }, index, preset, fallback.roles[index]))
  return {
    ...fallback,
    displayName: title ?? fallback.displayName,
    baseTemplateId: chooseTemplate(input, templates, fallback.baseTemplateId),
    scenario: input.slice(0, 8_000),
    roles,
  }
}

function roleFromValue(
  value: unknown,
  index: number,
  preset: EmbodimentPresetDescriptor,
  fallback?: WorkshopRoleDraft,
): WorkshopRoleDraft {
  const source = typeof value === 'string' ? { displayName: value } : record(value) ?? {}
  const role = stringValue(source.displayName, source.name, source.label) ?? fallback?.displayName ?? `角色 ${index + 1}`
  const identity = stringValue(source.role, source.job, source.identity) ?? fallback?.role ?? '协作角色'
  const summary = stringValue(source.summary, source.description, source.responsibilities) ?? fallback?.summary ?? `负责${identity}相关工作`
  const persona = stringValue(source.persona, source.personality, source.systemPrompt, source.principles) ?? fallback?.persona ?? `你是${role}，以事实和清晰边界推进工作。`
  const draft = fallback === undefined ? createRoleDraft(index + 1, preset) : { ...fallback, embodiment: structuredClone(fallback.embodiment) }
  return {
    ...draft,
    displayName: role,
    role: identity,
    summary,
    persona,
    requestedSkillIds: stringArray(source.requestedSkillIds, source.skillIds, source.skills) ?? draft.requestedSkillIds,
  }
}

function chooseTemplate(value: unknown, templates: readonly WorldTemplateManifest[], fallback: string): string {
  const text = typeof value === 'string' ? value.toLocaleLowerCase() : ''
  const direct = templates.find((item) => item.id.toLocaleLowerCase() === text || item.displayName.toLocaleLowerCase() === text)
  if (direct !== undefined) return direct.id
  const hints: Array<[string, string[]]> = [
    ['tavern', ['酒馆', '冒险', '剧情', '角色扮演']],
    ['orbital-observatory', ['观测', '深空', '轨道', '科学']],
    ['creator-studio', ['内容', '短剧', '自媒体', '视频', '创作']],
    ['cyber-company', ['公司', '团队', '项目', '协作', '运营']],
  ]
  const match = hints.find(([, words]) => words.some((word) => text.includes(word)))
  return templates.some((item) => item.id === match?.[0]) ? match![0] : fallback
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function arrayValue(...values: unknown[]): unknown[] {
  for (const value of values) if (Array.isArray(value)) return value
  return []
}

function stringValue(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.trim().length > 0)?.trim()
}

function stringArray(...values: unknown[]): string[] | undefined {
  for (const value of values) {
    if (!Array.isArray(value)) continue
    const result = value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
    if (result.length > 0) return [...new Set(result)].slice(0, 32)
  }
  return undefined
}

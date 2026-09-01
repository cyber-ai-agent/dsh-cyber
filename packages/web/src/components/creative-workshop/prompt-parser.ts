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
    return { draft: draftFromRecord(parsed, templates, presets, currentDraft), reply: '已读取 JSON 草稿，请检查后再确认创建。', source: 'json' }
  }
  const draft = draftFromText(source, templates, preset, currentDraft)
  return { draft, reply: '已生成可编辑草稿，请检查后再确认创建。', source: 'text' }
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
  assertSuggestionOnlyDraft(input)
  const nestedWorld = record(input.world) ?? record(input.worldDefinition) ?? {}
  const source = { ...input, ...nestedWorld }
  const fallback = currentDraft ?? createEmptyWorkshopDraft(templates[0]?.id ?? 'personal-world', presets[0]!)
  const templateId = chooseTemplate(stringValue(source.baseTemplateId, source.templateId, source.template), templates, fallback.baseTemplateId)
  const rawRoles = arrayValue(source.roles, source.characters, source.agents, source.team)
  const roles = rawRoles.length === 0
    ? fallback.roles.some(hasRoleContent)
      ? fallback.roles.map((role, index) => roleFromValue({}, index, presets[index % presets.length] ?? presets[0]!, role))
      : [roleFromValue({ displayName: '管家', role: '世界管家', summary: '帮助维护这个世界并协调后续角色。' }, 0, presets[0]!, fallback.roles[0])]
    : rawRoles.map((item, index) => roleFromValue(item, index, presets[index % presets.length] ?? presets[0]!, fallback.roles[index]))
  return {
    ...fallback,
    displayName: stringValue(source.displayName, source.name, source.title) ?? fallback.displayName,
    baseTemplateId: templateId,
    lore: stringValue(source.lore, source.background, source.rules) ?? fallback.lore,
    scenario: stringValue(source.scenario, source.goal, source.objective, source.purpose, source.description, source.prompt) ?? fallback.scenario,
    roles,
    ...(modelProfileIdFromPolicy(source.modelPolicy) === undefined ? {} : { worldModelProfileId: modelProfileIdFromPolicy(source.modelPolicy)! }),
  }
}

function assertSuggestionOnlyDraft(input: Record<string, unknown>): void {
  const forbidden = new Set([
    'characterId', 'databaseId', 'revision', 'createdAt', 'internalPath',
    'skillGrants', 'permissionGrants', 'approvedPermissions', 'approvedPermission',
    'providerId', 'packageId',
  ])
  const visit = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`))
      return
    }
    const object = record(value)
    if (object === undefined) return
    for (const [key, child] of Object.entries(object)) {
      if (forbidden.has(key)) throw new Error(`草稿包含不允许由 AI 指定的字段：${path}.${key}`)
      visit(child, `${path}.${key}`)
    }
  }
  visit(input, 'draft')
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
    .flatMap(expandRoleSpecification)
  const roles = roleLines.length === 0
    ? fallback.roles.some((role) => role.displayName.trim() || role.role.trim())
      ? fallback.roles
      : [roleFromValue({ displayName: '管家', role: '世界管家', summary: '帮助维护这个世界并协调后续角色。' }, 0, preset, fallback.roles[0])]
    : roleLines.slice(0, 16).map((role, index) => roleFromValue(role, index, preset, fallback.roles[index]))
  return {
    ...fallback,
    displayName: title ?? stringValue(fallback.displayName) ?? inferWorldName(input),
    baseTemplateId: chooseTemplate(input, templates, fallback.baseTemplateId),
    scenario: input.slice(0, 8_000),
    roles,
  }
}

function expandRoleSpecification(value: string): Array<{ displayName: string; role: string }> {
  const match = /^(?:(\d+)|([一二两三四五六七八九十]))\s*(?:个|名|位)?\s*(.+)$/u.exec(value.trim())
  if (match === null) return [{ displayName: value.trim(), role: value.trim() }]
  const count = match[1] === undefined ? chineseCount(match[2]!) : Number(match[1])
  const role = match[3]?.trim() ?? ''
  if (!Number.isInteger(count) || count < 1 || count > 16 || role.length === 0) return [{ displayName: value.trim(), role: value.trim() }]
  return Array.from({ length: count }, (_, index) => ({
    displayName: count === 1 ? role : `${role} ${index + 1}`,
    role,
  }))
}

function chineseCount(value: string): number {
  if (value === '十') return 10
  const digit: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
  return digit[value] ?? 0
}

function roleFromValue(
  value: unknown,
  index: number,
  preset: EmbodimentPresetDescriptor,
  fallback?: WorkshopRoleDraft,
): WorkshopRoleDraft {
  const source = typeof value === 'string' ? { displayName: value } : record(value) ?? {}
  const role = stringValue(source.displayName, source.name, source.label) ?? stringValue(fallback?.displayName) ?? `角色 ${index + 1}`
  const identity = stringValue(source.role, source.job, source.identity) ?? stringValue(fallback?.role) ?? '协作角色'
  const summary = stringValue(source.summary, source.description, source.responsibilities) ?? stringValue(fallback?.summary) ?? `负责${identity}相关工作`
  // Imported JSON is untrusted draft data. Never promote fields named
  // systemPrompt/principles into host-level persona instructions.
  const personaObject = record(source.persona)
  const persona = stringValue(
    source.persona,
    source.personality,
    personaObject?.background,
    personaObject?.communicationStyle,
  ) ?? stringValue(fallback?.persona) ?? `你是${role}，以事实和清晰边界推进工作。`
  const draft = fallback === undefined ? createRoleDraft(index + 1, preset) : { ...fallback, embodiment: structuredClone(fallback.embodiment) }
  return {
    ...draft,
    displayName: role,
    role: identity,
    summary,
    persona,
    requestedSkillIds: stringArray(source.requestedSkillIds, source.requestedSkills, source.skillIds, source.skills) ?? draft.requestedSkillIds,
    ...(modelProfileIdFromPolicy(source.modelPolicy) === undefined ? {} : { modelProfileId: modelProfileIdFromPolicy(source.modelPolicy)! }),
  }
}

function modelProfileIdFromPolicy(value: unknown): string | undefined {
  const policy = record(value)
  return policy?.mode === 'override' && typeof policy.modelProfileId === 'string' && policy.modelProfileId.trim()
    ? policy.modelProfileId.trim()
    : undefined
}

function chooseTemplate(value: unknown, templates: readonly WorldTemplateManifest[], fallback: string): string {
  const text = typeof value === 'string' ? value.toLocaleLowerCase() : ''
  const direct = templates.find((item) => item.id.toLocaleLowerCase() === text || item.displayName.toLocaleLowerCase() === text)
  if (direct !== undefined) return direct.id
  const hints: Array<[string, string[]]> = [
    ['tavern', ['酒馆', '冒险', '剧情', '角色扮演']],
    ['ai-academy', ['教学', '课程', '教案', '讲课', '培训', '学院', '答疑']],
    ['jarvis-core', ['助理', '中枢', '委派', '日程', '待办', '个人事务', '管家']],
    ['orbital-observatory', ['观测', '深空', '轨道', '科学']],
    ['creator-studio', ['内容', '短剧', '自媒体', '视频', '创作']],
    ['cyber-company', ['公司', '团队', '项目', '协作', '运营']],
  ]
  const match = hints.find(([, words]) => words.some((word) => text.includes(word)))
  return templates.some((item) => item.id === match?.[0]) ? match![0] : fallback
}

function hasRoleContent(role: WorkshopRoleDraft): boolean {
  return [role.displayName, role.role, role.summary, role.persona].some((value) => value.trim().length > 0)
}

function inferWorldName(input: string): string {
  const normalized = input.replace(/\s+/g, ' ').trim()
  const withoutAction = normalized
    .replace(/^(请|帮我|帮忙|想要|我想|我要|为我|给我)?\s*/u, '')
    .replace(/^(创建|建立|生成|打造|设计|构建|做一个|做一座|来一个|来一座)\s*/u, '')
    .replace(/^(一个|一座|一间|一处)\s*/u, '')
    .replace(/[，。！？!?,；;].*$/u, '')
    .trim()
  if (withoutAction.length >= 2 && withoutAction.length <= 32) return withoutAction
  return '新世界'
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

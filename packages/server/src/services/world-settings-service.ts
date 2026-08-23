import { randomUUID } from 'node:crypto'
import { open, readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'

import type { AgentPermissionMode, EmployeeInstance, ReasoningEffort, WorldSettings } from '@dsh-cyber/contracts'
import type { WorldRootService } from './world-root-service.js'

const reasoning = new Set<ReasoningEffort>(['auto', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
const permissionModes = new Set<AgentPermissionMode>(['read-only', 'workspace-write'])
const COLOR = /^#[0-9a-f]{6}$/i

export class WorldSettingsService {
  readonly #roots: WorldRootService

  constructor(roots: WorldRootService) { this.#roots = roots }

  async get(worldId: string): Promise<WorldSettings> {
    const root = await this.#roots.ensure(worldId)
    try {
      return normalize(worldId, JSON.parse(await readFile(join(root.rootPath, 'settings.json'), 'utf8')) as Partial<WorldSettings>)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return defaults(worldId)
    }
  }

  async save(worldId: string, value: Partial<WorldSettings>): Promise<WorldSettings> {
    const current = await this.get(worldId)
    const next = normalize(worldId, {
      ...current,
      ...value,
      userIdentity: { ...current.userIdentity, ...value.userIdentity },
      terminology: { ...current.terminology, ...value.terminology },
      appearance: { ...current.appearance, ...value.appearance },
      model: { ...current.model, ...value.model },
      runtime: { ...current.runtime, ...value.runtime },
      updatedAt: new Date().toISOString(),
    })
    const root = await this.#roots.ensure(worldId)
    await atomic(join(root.rootPath, 'settings.json'), `${JSON.stringify(next, null, 2)}\n`)
    return next
  }

  async composeRuntimePrompt(worldId: string, character: EmployeeInstance, prompt: string): Promise<string> {
    const settings = await this.get(worldId)
    return `${worldHeader(settings)}\n${characterIdentity(character)}\n\n[用户请求]\n${prompt}`
  }

  async composeGroupRuntimePrompt(worldId: string, prompt: string): Promise<string> {
    const settings = await this.get(worldId)
    return `${worldHeader(settings)}\n多人会话中的每个角色都必须保持自己的当前身份、知识边界和立场，不替其他角色发言。角色的最新 Persona / Identity 优先于创建时模板中的旧岗位。\n\n[用户请求]\n${prompt}`
  }
}

function worldHeader(settings: WorldSettings): string {
  return [
    '[当前世界设定]',
    settings.lore ? `世界观：${settings.lore}` : '',
    settings.scenario ? `当前场景：${settings.scenario}` : '',
    `用户在这个世界中的身份：${settings.userIdentity.displayName}（${settings.userIdentity.worldRole}），请称呼用户为“${settings.userIdentity.addressAs}”。`,
    '当前世界与其他世界的数据、文件、记忆相互隔离。',
  ].filter(Boolean).join('\n')
}

function characterIdentity(character: EmployeeInstance): string {
  return [
    `你在这个世界中是持久角色“${character.displayName}”。`,
    '你的当前身份、个性与关系由最新角色 Persona / Identity 契约定义；创建时使用的模板或初始岗位只属于来源元数据，不能覆盖用户后续保存的角色设定。',
    '保持当前角色身份，不冒充其他角色，也不要自行恢复已经被用户修改掉的旧模板身份。',
  ].join('\n')
}

function defaults(worldId: string): WorldSettings {
  return {
    schemaVersion: 1,
    worldId,
    lore: '',
    scenario: '',
    userIdentity: { displayName: '你', worldRole: '世界创建者', addressAs: '你' },
    terminology: { characterSingular: '角色', characterPlural: '角色', addCharacterVerb: '添加角色', groupConversation: '群组会话', assignment: '任务' },
    appearance: {
      accentColor: '#d7a52a', pageBackground: '#080d10', panelBackground: '#0d1419',
      ownerBubbleColor: '#263629', characterBubbleColor: '#141c22', textColor: '#edf2f4', mutedTextColor: '#84919a',
      panelRadius: 10, bubbleRadius: 8, buttonRadius: 7, fontScale: 1,
    },
    model: { reasoningEffort: 'auto' },
    runtime: { permissionMode: 'read-only' },
    updatedAt: new Date().toISOString(),
  }
}

function normalize(worldId: string, value: Partial<WorldSettings>): WorldSettings {
  const base = defaults(worldId)
  const raw = {
    ...base,
    ...value,
    userIdentity: { ...base.userIdentity, ...(value.userIdentity ?? {}) },
    terminology: { ...base.terminology, ...(value.terminology ?? {}) },
    appearance: { ...base.appearance, ...(value.appearance ?? {}) },
    model: { ...base.model, ...(value.model ?? {}) },
    runtime: { ...base.runtime, ...(value.runtime ?? {}) },
  }
  const next: WorldSettings = {
    ...raw,
    schemaVersion: 1,
    worldId,
    lore: cleanText(raw.lore, 20_000),
    scenario: cleanText(raw.scenario, 8_000),
    userIdentity: {
      displayName: cleanText(raw.userIdentity.displayName, 80) || base.userIdentity.displayName,
      worldRole: cleanText(raw.userIdentity.worldRole, 120) || base.userIdentity.worldRole,
      addressAs: cleanText(raw.userIdentity.addressAs, 80) || base.userIdentity.addressAs,
    },
    terminology: {
      characterSingular: cleanText(raw.terminology.characterSingular, 32) || base.terminology.characterSingular,
      characterPlural: cleanText(raw.terminology.characterPlural, 32) || base.terminology.characterPlural,
      addCharacterVerb: cleanText(raw.terminology.addCharacterVerb, 32) || base.terminology.addCharacterVerb,
      groupConversation: cleanText(raw.terminology.groupConversation, 32) || base.terminology.groupConversation,
      assignment: cleanText(raw.terminology.assignment, 32) || base.terminology.assignment,
    },
    appearance: {
      accentColor: color(raw.appearance.accentColor, base.appearance.accentColor),
      pageBackground: color(raw.appearance.pageBackground, base.appearance.pageBackground),
      panelBackground: color(raw.appearance.panelBackground, base.appearance.panelBackground),
      ownerBubbleColor: color(raw.appearance.ownerBubbleColor, base.appearance.ownerBubbleColor),
      characterBubbleColor: color(raw.appearance.characterBubbleColor, base.appearance.characterBubbleColor),
      textColor: color(raw.appearance.textColor, base.appearance.textColor),
      mutedTextColor: color(raw.appearance.mutedTextColor, base.appearance.mutedTextColor),
      panelRadius: clampNumber(raw.appearance.panelRadius, 0, 40, base.appearance.panelRadius),
      bubbleRadius: clampNumber(raw.appearance.bubbleRadius, 0, 40, base.appearance.bubbleRadius),
      buttonRadius: clampNumber(raw.appearance.buttonRadius, 0, 30, base.appearance.buttonRadius),
      fontScale: clampNumber(raw.appearance.fontScale, 0.8, 1.4, base.appearance.fontScale),
    },
    model: {
      ...(typeof raw.model.defaultModelProfileId === 'string' && raw.model.defaultModelProfileId.trim()
        ? { defaultModelProfileId: raw.model.defaultModelProfileId.trim().slice(0, 160) }
        : {}),
      reasoningEffort: reasoning.has(raw.model.reasoningEffort) ? raw.model.reasoningEffort : 'auto',
    },
    runtime: {
      permissionMode: permissionModes.has(raw.runtime.permissionMode) ? raw.runtime.permissionMode : 'read-only',
    },
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date().toISOString(),
  }
  return next
}

function cleanText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replaceAll('\0', '').trim().slice(0, max) : ''
}

function color(value: unknown, fallback: string): string {
  return typeof value === 'string' && COLOR.test(value) ? value.toLowerCase() : fallback
}

function clampNumber(value: unknown, minimum: number, maximum: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback
}

async function atomic(path: string, content: string): Promise<void> {
  const temp = `${path}.tmp-${randomUUID()}`
  const handle = await open(temp, 'wx', 0o600)
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temp, path)
}

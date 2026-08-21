import { randomUUID } from 'node:crypto'
import { open, readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'

import type { EmployeeInstance, ReasoningEffort, WorldSettings } from '@dsh-cyber/contracts'

import type { WorldRootService } from './world-root-service.js'

const reasoning = new Set<ReasoningEffort>([
  'auto', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
])

export class WorldSettingsService {
  readonly #roots: WorldRootService

  constructor(roots: WorldRootService) {
    this.#roots = roots
  }

  async get(worldId: string): Promise<WorldSettings> {
    const root = await this.#roots.ensure(worldId)
    try {
      return normalize(
        worldId,
        JSON.parse(await readFile(join(root.rootPath, 'settings.json'), 'utf8')) as Partial<WorldSettings>,
      )
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
      updatedAt: new Date().toISOString(),
    })
    const root = await this.#roots.ensure(worldId)
    await atomic(join(root.rootPath, 'settings.json'), `${JSON.stringify(next, null, 2)}\n`)
    return next
  }

  async composeRuntimePrompt(
    worldId: string,
    character: EmployeeInstance,
    prompt: string,
  ): Promise<string> {
    const settings = await this.get(worldId)
    return `${worldHeader(settings)}\n${characterIdentity(character)}\n\n[用户请求]\n${prompt}`
  }

  async composeGroupRuntimePrompt(worldId: string, prompt: string): Promise<string> {
    const settings = await this.get(worldId)
    return `${worldHeader(settings)}\n多人会话中的每个角色都必须保持自己的身份、知识边界和立场，不替其他角色发言。\n\n[用户请求]\n${prompt}`
  }
}

function worldHeader(settings: WorldSettings): string {
  const worldContext = [
    '[当前世界设定]',
    settings.lore ? `世界观：${settings.lore}` : '',
    settings.scenario ? `当前场景：${settings.scenario}` : '',
    `用户在这个世界中的身份：${settings.userIdentity.displayName}（${settings.userIdentity.worldRole}），请称呼用户为“${settings.userIdentity.addressAs}”。`,
    '当前世界与其他世界的数据、文件、记忆相互隔离。',
  ].filter(Boolean)
  return worldContext.join('\n')
}

function characterIdentity(character: EmployeeInstance): string {
  return `你在这个世界中是角色“${character.displayName}”，身份为“${character.role}”。保持自己的角色身份，不冒充其他角色。`
}

function defaults(worldId: string): WorldSettings {
  return {
    schemaVersion: 1,
    worldId,
    lore: '',
    scenario: '',
    userIdentity: {
      displayName: '你',
      worldRole: '世界创建者',
      addressAs: '你',
    },
    terminology: {
      characterSingular: '角色',
      characterPlural: '角色',
      addCharacterVerb: '添加角色',
      groupConversation: '群组会话',
      assignment: '任务',
    },
    appearance: {
      accentColor: '#d7a52a',
      pageBackground: '#080d10',
      panelBackground: '#0d1419',
      ownerBubbleColor: '#263629',
      characterBubbleColor: '#141c22',
      textColor: '#edf2f4',
      mutedTextColor: '#84919a',
      panelRadius: 10,
      bubbleRadius: 8,
      buttonRadius: 7,
      fontScale: 1,
    },
    model: { reasoningEffort: 'auto' },
    updatedAt: new Date().toISOString(),
  }
}

function normalize(worldId: string, value: Partial<WorldSettings>): WorldSettings {
  const base = defaults(worldId)
  const next = {
    ...base,
    ...value,
    schemaVersion: 1 as const,
    worldId,
    userIdentity: { ...base.userIdentity, ...(value.userIdentity ?? {}) },
    terminology: { ...base.terminology, ...(value.terminology ?? {}) },
    appearance: { ...base.appearance, ...(value.appearance ?? {}) },
    model: { ...base.model, ...(value.model ?? {}) },
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date().toISOString(),
  }
  if (!reasoning.has(next.model.reasoningEffort)) next.model.reasoningEffort = 'auto'
  for (const key of ['panelRadius', 'bubbleRadius', 'buttonRadius', 'fontScale'] as const) {
    if (!Number.isFinite(next.appearance[key])) next.appearance[key] = base.appearance[key]
  }
  return next
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

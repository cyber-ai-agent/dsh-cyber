import { randomUUID } from 'node:crypto'
import { open, readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'

import type { AgentPermissionMode, EmployeeInstance, ReasoningEffort, WorldSettings, WorldThemeManifestV1 } from '@dsh-cyber/contracts'
import { UnsupportedWorldRuntimeError, type WorldRuntimeService } from '../world-runtime-service.js'
import type { ContextConversationLane } from './conversation-context-composer.js'
import type { WorldRootService } from './world-root-service.js'

const reasoning = new Set<ReasoningEffort>(['auto', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
const responseLanguages = new Set<WorldSettings['model']['responseLanguage']>(['zh-CN', 'en-US', 'auto'])
const permissionModes = new Set<AgentPermissionMode>(['read-only', 'workspace-write', 'danger-full-access'])
const COLOR = /^#[0-9a-f]{6}$/i

export interface WorldSettingsSnapshot {
  settings: WorldSettings
  revision: number
}

export class WorldSettingsConflictError extends Error {
  readonly code = 'world_settings_revision_conflict'

  constructor(
    readonly worldId: string,
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(`World settings changed concurrently (expected revision ${expectedRevision}, actual ${actualRevision})`)
    this.name = 'WorldSettingsConflictError'
  }
}

export class WorldSettingsService {
  readonly #roots: WorldRootService
  readonly #themes: Pick<WorldRuntimeService, 'getThemeManifest'> | undefined

  /**
   * `themes` resolves the world's durable theme binding - the theme the world
   * was created with, or the package instance the owner bound since - whose
   * `terminology.rules` render into the world context. Without it the context
   * is the settings header alone, exactly as before the rules joined it.
   */
  constructor(roots: WorldRootService, themes?: Pick<WorldRuntimeService, 'getThemeManifest'>) {
    this.#roots = roots
    this.#themes = themes
  }

  async get(worldId: string): Promise<WorldSettings> {
    return (await this.getSnapshot(worldId)).settings
  }

  async getSnapshot(worldId: string): Promise<WorldSettingsSnapshot> {
    const root = await this.#roots.ensure(worldId)
    try {
      const raw = JSON.parse(await readFile(join(root.rootPath, 'settings.json'), 'utf8')) as Record<string, unknown>
      const revision = typeof raw.revision === 'number' && Number.isSafeInteger(raw.revision) && raw.revision >= 0
        ? raw.revision
        : 0
      return { settings: normalize(worldId, raw as Partial<WorldSettings>), revision }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return { settings: defaults(worldId), revision: 0 }
    }
  }

  async save(worldId: string, value: Partial<WorldSettings>): Promise<WorldSettings> {
    const current = await this.getSnapshot(worldId)
    const next = await this.savePatch(worldId, value as Record<string, unknown>, current.revision)
    return next.settings
  }

  async savePatch(
    worldId: string,
    value: Record<string, unknown>,
    expectedRevision: number,
  ): Promise<WorldSettingsSnapshot> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new TypeError('World settings revision must be a non-negative integer')
    }
    // Read, compare and publish must be one critical section. Without it the
    // revision check is advisory: two writers holding the same expected
    // revision both read, both find it current, and both publish — the second
    // silently overwriting the first while each reports success.
    //
    // The lock is module-scoped rather than an instance field because the
    // Creative Workshop constructs its own WorldSettingsService over the same
    // files. Per world, so unrelated worlds still write concurrently.
    return withWorldSettingsLock(worldId, () => this.#savePatchExclusive(worldId, value, expectedRevision))
  }

  async #savePatchExclusive(
    worldId: string,
    value: Record<string, unknown>,
    expectedRevision: number,
  ): Promise<WorldSettingsSnapshot> {
    const current = await this.getSnapshot(worldId)
    if (current.revision !== expectedRevision) {
      throw new WorldSettingsConflictError(worldId, expectedRevision, current.revision)
    }
    const currentSettings = current.settings
    const next = normalize(worldId, {
      ...currentSettings,
      ...value,
      userIdentity: { ...currentSettings.userIdentity, ...asRecord(value.userIdentity) },
      terminology: { ...currentSettings.terminology, ...asRecord(value.terminology) },
      appearance: { ...currentSettings.appearance, ...asRecord(value.appearance) },
      model: { ...currentSettings.model, ...asRecord(value.model) },
      runtime: { ...currentSettings.runtime, ...asRecord(value.runtime) },
      updatedAt: new Date().toISOString(),
    })
    const root = await this.#roots.ensure(worldId)
    const revision = current.revision + 1
    await atomic(join(root.rootPath, 'settings.json'), `${JSON.stringify({ ...next, revision }, null, 2)}\n`)
    return { settings: next, revision }
  }

  /**
   * The world's stable rules for one character's turn: lore, scenario, the
   * user's identity, the isolation rule and the response language, then the
   * rules of the world's theme, followed by the identity note for the lane
   * the turn runs in.
   *
   * This is the `world-context` layer of the envelope, not a request. It reads
   * nothing that moves per turn - no clock, no counter, no retrieval - so two
   * turns of the same character in the same world render byte-identical text
   * until the settings revision or the theme binding changes. That is what
   * lets it sit in the cacheable prefix instead of behind the retrieved
   * memories.
   */
  async composeWorldContext(input: {
    worldId: string
    character: EmployeeInstance
    lane: ContextConversationLane
  }): Promise<WorldContextText> {
    const snapshot = await this.getSnapshot(input.worldId)
    const theme = this.#themeManifest(input.worldId)
    const identity = input.lane === 'direct' || input.lane === 'unknown'
      ? characterIdentity(input.character)
      : GROUP_IDENTITY_NOTE
    return {
      text: [worldHeader(snapshot.settings), theme === undefined ? '' : themeRules(theme), identity].filter(Boolean).join('\n'),
      revision: snapshot.revision,
    }
  }

  /**
   * The manifest of the world's durable theme binding, read from SQLite the
   * same way the scene reads it. A world whose template has no theme (or no
   * theme source at all) simply contributes no rules.
   */
  #themeManifest(worldId: string): WorldThemeManifestV1 | undefined {
    if (this.#themes === undefined) return undefined
    try {
      return this.#themes.getThemeManifest(worldId)
    } catch (error) {
      if (error instanceof UnsupportedWorldRuntimeError) return undefined
      throw error
    }
  }
}

export interface WorldContextText {
  text: string
  /** The world settings revision the text was rendered from. */
  revision: number
}

const GROUP_IDENTITY_NOTE = '多人会话中的每个角色都必须保持自己的当前身份、知识边界和立场，不替其他角色发言。角色的最新 Persona / Identity 优先于创建时模板中的旧岗位。'

/**
 * One in-flight settings write per world, shared by every service instance.
 *
 * Module scope is deliberate: `CreativeWorkshopService` builds a second
 * `WorldSettingsService` over the same `settings.json`, and an instance-level
 * lock would let those two writers race each other.
 */
const worldSettingsLocks = new Map<string, Promise<unknown>>()

function withWorldSettingsLock<TResult>(worldId: string, work: () => Promise<TResult>): Promise<TResult> {
  const previous = worldSettingsLocks.get(worldId) ?? Promise.resolve()
  const current = previous.then(work, work)
  worldSettingsLocks.set(worldId, current)
  void current
    .catch(() => undefined)
    .finally(() => {
      if (worldSettingsLocks.get(worldId) === current) worldSettingsLocks.delete(worldId)
    })
  return current
}

function worldHeader(settings: WorldSettings): string {
  return [
    '[当前世界设定]',
    settings.lore ? `世界观：${settings.lore}` : '',
    settings.scenario ? `当前场景：${settings.scenario}` : '',
    `用户在这个世界中的身份：${settings.userIdentity.displayName}（${settings.userIdentity.worldRole}），请称呼用户为“${settings.userIdentity.addressAs}”。`,
    '当前世界与其他世界的数据、文件、记忆相互隔离。',
    responseLanguageInstruction(settings.model.responseLanguage),
  ].filter(Boolean).join('\n')
}

/**
 * How much theme rule text may enter the prefix: at most 12 rules of at most
 * 200 characters each, 2,400 characters of prose in all.
 *
 * The figures are the World Generator analyzer's publish contract (12 rules,
 * 200 characters, one line of prose each), so a theme that passed it always
 * fits whole; the official themes carry 6-9 rules of under 60 characters.
 * 2,400 characters is about an eighth of the lore budget and a few hundred
 * tokens more than a persona - a theme with 200 rules costs the prefix no
 * more than the first twelve. The bound is a shape, not a sanitizer: the
 * content gate for model-written rules is the analyzer, before publish.
 */
const MAX_THEME_RULES = 12
const MAX_THEME_RULE_LENGTH = 200

/**
 * The theme's rules as a block the model can see is the world's, not the
 * character's: a `[世界规则]` header naming the theme, then the numbered
 * rules. Empty when the theme declares none, so a world without theme rules
 * renders byte-identically to before the block existed.
 */
function themeRules(theme: WorldThemeManifestV1): string {
  const declared = theme.terminology.rules
  if (!Array.isArray(declared)) return ''
  const rules: string[] = []
  for (const item of declared) {
    if (rules.length >= MAX_THEME_RULES) break
    if (typeof item !== 'string') continue
    const rule = item.replaceAll('\0', '').trim()
    if (!rule || rule.length > MAX_THEME_RULE_LENGTH || /[\r\n]/.test(rule)) continue
    rules.push(rule)
  }
  if (rules.length === 0) return ''
  const source = theme.displayName.replaceAll(/\s+/g, ' ').trim()
  return [
    '[世界规则]',
    `以下规则来自世界主题“${source}”，对这个世界里的每个角色都生效；它们是世界的规则，不是角色 Persona 的一部分：`,
    ...rules.map((rule, index) => `${index + 1}. ${rule}`),
  ].join('\n')
}

function responseLanguageInstruction(language: WorldSettings['model']['responseLanguage']): string {
  if (language === 'en-US') {
    return '[回复偏好语言]\nUse English for the final response, visible reasoning summaries, plans, and tool-use explanations. Keep code, commands, paths, API names, protocols, and brand names unchanged.'
  }
  if (language === 'auto') {
    return '[回复偏好语言]\n跟随用户当前消息使用的主要语言生成最终回复、可展示的判断摘要、计划和工具使用说明；代码、命令、路径、API、协议与品牌标识保留原文。'
  }
  return '[回复偏好语言]\n最终回复、可展示的判断摘要、计划和工具使用说明统一使用简体中文；代码、命令、路径、API、协议与品牌标识保留原文。'
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
    model: { reasoningEffort: 'auto', responseLanguage: 'zh-CN' },
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
      // Model identity is authoritative in SQLite model_assignments. Keep
      // only the local reasoning preference in settings.json; a legacy
      // defaultModelProfileId is intentionally ignored and never rewritten.
      reasoningEffort: reasoning.has(raw.model.reasoningEffort) ? raw.model.reasoningEffort : 'auto',
      responseLanguage: responseLanguages.has(raw.model.responseLanguage) ? raw.model.responseLanguage : 'zh-CN',
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

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
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

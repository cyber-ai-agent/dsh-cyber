import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'

import type { CreativeWorkshopCharacterDraft, CreativeWorkshopDraftV1, CreativeWorkshopWorldDraft } from '@dsh-cyber/contracts/creative-platform'
import type { SqliteStore } from '@dsh-cyber/persistence'

import { ServiceError } from './service-error.js'

export class CreativeWorkshopDraftService {
  readonly #store: SqliteStore
  readonly #root: string

  constructor(store: SqliteStore) {
    this.#store = store
    this.#root = join(dirname(dirname(store.databasePath)), 'workshop', 'drafts')
  }

  async get(workspaceId: string): Promise<CreativeWorkshopDraftV1 | undefined> {
    this.#requireWorkspace(workspaceId)
    try {
      return parseCreativeWorkshopDraft(JSON.parse(await readFile(this.#path(workspaceId), 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      if (error instanceof ServiceError) throw error
      throw new ServiceError('invalid', 'workshop_draft_corrupt', '保存的创意工坊草稿无法读取。')
    }
  }

  async save(workspaceId: string, value: unknown): Promise<CreativeWorkshopDraftV1> {
    this.#requireWorkspace(workspaceId)
    const draft = parseCreativeWorkshopDraft(value)
    await mkdir(this.#root, { recursive: true, mode: 0o700 })
    await atomicWrite(this.#path(workspaceId), `${JSON.stringify(draft, null, 2)}\n`)
    return draft
  }

  async delete(workspaceId: string): Promise<boolean> {
    this.#requireWorkspace(workspaceId)
    try { await rm(this.#path(workspaceId)); return true } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }

  #path(workspaceId: string): string { return join(this.#root, `${encodeURIComponent(workspaceId)}.json`) }
  #requireWorkspace(workspaceId: string): void {
    if (this.#store.getWorkspace(workspaceId) === undefined) throw new ServiceError('not-found', 'workspace_not_found', '工作区不存在。')
  }
}

export function parseCreativeWorkshopDraft(value: unknown): CreativeWorkshopDraftV1 {
  assertNoForbiddenDraftFields(value)
  const source = object(value, '草稿')
  if (source.schemaVersion !== 1) throw invalid('草稿版本不受支持。')
  const worldSource = object(source.world, '世界草稿')
  const characterSources = array(source.characters, '角色草稿')
  if (characterSources.length < 1 || characterSources.length > 20) throw invalid('角色数量必须在 1 到 20 之间。')
  const world: CreativeWorkshopWorldDraft = {
    name: text(worldSource.name, '世界名称', 80),
    ...optionalTextFields(worldSource, [['description', 2_000], ['purpose', 8_000], ['themeHint', 120]] as const),
  }
  if (worldSource.modelPolicy !== undefined) world.modelPolicy = parseModelPolicy(worldSource.modelPolicy)
  const ids = new Set<string>()
  const characters = characterSources.map((item, index) => parseCharacter(item, index, ids))
  const draft: CreativeWorkshopDraftV1 = { schemaVersion: 1, world, characters }
  const metadata = objectOrUndefined(source.metadata)
  if (metadata !== undefined) {
    draft.metadata = optionalTextFields(metadata, [['generatedBy', 120], ['generatedAt', 80], ['originalPrompt', 32_000]] as const)
  }
  return draft
}

function assertNoForbiddenDraftFields(value: unknown): void {
  const forbidden = new Set(['characterId', 'databaseId', 'revision', 'createdAt', 'internalPath', 'skillGrants', 'permissionGrants', 'approvedPermissions', 'approvedPermission', 'providerId', 'packageId'])
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) { candidate.forEach(visit); return }
    if (candidate === null || typeof candidate !== 'object') return
    for (const [key, child] of Object.entries(candidate as Record<string, unknown>)) {
      if (forbidden.has(key)) throw invalid(`草稿包含不允许的字段：${key}`)
      visit(child)
    }
  }
  visit(value)
}

function parseCharacter(value: unknown, index: number, ids: Set<string>): CreativeWorkshopCharacterDraft {
  const source = object(value, `角色 ${index + 1}`)
  const tempId = token(source.tempId, `角色 ${index + 1} 临时 ID`)
  if (ids.has(tempId)) throw invalid(`角色临时 ID 重复：${tempId}`)
  ids.add(tempId)
  const result: CreativeWorkshopCharacterDraft = {
    tempId,
    name: text(source.name, `角色 ${index + 1} 名称`, 50),
    ...optionalTextFields(source, [['role', 100], ['summary', 500]] as const),
  }
  if (source.requestedSkills !== undefined) result.requestedSkills = tokenArray(source.requestedSkills, '建议技能', 32)
  if (source.responsibilities !== undefined) result.responsibilities = textArray(source.responsibilities, '职责', 24, 300)
  if (source.modelPolicy !== undefined) result.modelPolicy = parseModelPolicy(source.modelPolicy)
  const persona = objectOrUndefined(source.persona)
  if (persona !== undefined) result.persona = {
    ...optionalTextFields(persona, [['communicationStyle', 500], ['background', 2_000]] as const),
    ...(persona.traits === undefined ? {} : { traits: textArray(persona.traits, '性格特征', 20, 80) }),
  }
  const appearance = objectOrUndefined(source.appearance)
  if (appearance !== undefined) result.appearance = optionalTextFields(appearance, [['description', 1_000], ['avatarHint', 200], ['embodimentHint', 300]] as const)
  const relationship = objectOrUndefined(source.relationship)
  if (relationship !== undefined) result.relationship = optionalTextFields(relationship, [['type', 100], ['description', 500]] as const)
  return result
}

function parseModelPolicy(value: unknown): NonNullable<CreativeWorkshopDraftV1['world']['modelPolicy']> {
  const source = object(value, '模型建议')
  if (source.mode === 'inherit') return { mode: 'inherit' }
  if (source.mode === 'override') return { mode: 'override', ...(source.modelProfileId === undefined ? {} : { modelProfileId: token(source.modelProfileId, '模型配置 ID') }) }
  if (source.mode === 'recommend') return {
    mode: 'recommend',
    requiredCapabilities: tokenArray(source.requiredCapabilities, '模型能力', 12) as Array<'text' | 'vision' | 'reasoning' | 'tools' | 'image-generation' | 'embedding'>,
    reason: text(source.reason, '模型推荐原因', 500),
  }
  throw invalid('模型建议模式无效。')
}

function optionalTextFields<T extends readonly (readonly [string, number])[]>(source: Record<string, unknown>, fields: T): Record<string, string> {
  return Object.fromEntries(fields.flatMap(([key, maximum]) => source[key] === undefined ? [] : [[key, text(source[key], key, maximum)]]))
}
function object(value: unknown, label: string): Record<string, unknown> { if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalid(`${label}必须是对象。`); return value as Record<string, unknown> }
function objectOrUndefined(value: unknown): Record<string, unknown> | undefined { return value === undefined ? undefined : object(value, '字段') }
function array(value: unknown, label: string): unknown[] { if (!Array.isArray(value)) throw invalid(`${label}必须是数组。`); return value }
function text(value: unknown, label: string, maximum: number): string { if (typeof value !== 'string') throw invalid(`${label}必须是文本。`); const result = value.normalize('NFC').trim(); if (!result || Array.from(result).length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(result)) throw invalid(`${label}无效。`); return result }
function token(value: unknown, label: string): string { const result = text(value, label, 160); if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(result)) throw invalid(`${label}格式无效。`); return result }
function tokenArray(value: unknown, label: string, maximum: number): string[] { const values = array(value, label); if (values.length > maximum) throw invalid(`${label}数量过多。`); const result = values.map((item) => token(item, label)); if (new Set(result).size !== result.length) throw invalid(`${label}不能重复。`); return result }
function textArray(value: unknown, label: string, maximum: number, itemMaximum: number): string[] { const values = array(value, label); if (values.length > maximum) throw invalid(`${label}数量过多。`); return values.map((item) => text(item, label, itemMaximum)) }
function invalid(message: string): ServiceError { return new ServiceError('invalid', 'workshop_draft_invalid', message) }

async function atomicWrite(path: string, content: string): Promise<void> {
  const temporary = `${path}.tmp-${randomUUID()}`
  const handle = await open(temporary, 'wx', 0o600)
  try { await handle.writeFile(content, 'utf8'); await handle.sync() } finally { await handle.close() }
  await rename(temporary, path)
}

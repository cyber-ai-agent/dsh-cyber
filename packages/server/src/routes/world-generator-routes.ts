import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'

import type {
  CharacterGeneratorAvatarMimeType,
  CharacterGeneratorCapabilityCatalogItem,
  CharacterSourceInput,
  CyberMarketPackage,
  JsonObject,
  WorldGeneratorCatalog,
  WorldGeneratorSceneCatalogItem,
  WorldGeneratorSceneSelection,
  WorldImportAnalyzeResult,
  WorldImportPublishResult,
  WorldThemeDraft,
  WorldThemeManifestV1,
} from '@dsh-cyber/contracts'
import type { LocalPackageCatalog } from '@dsh-cyber/package-runtime'
import type { SqliteStore } from '@dsh-cyber/persistence'
import { validateWorldThemeManifest } from '@dsh-cyber/world-runtime'

import { HttpError } from '../http/errors.js'
import type { Router } from '../http/router.js'
import { readJson, record } from '../http/request.js'
import { writeJson } from '../http/response.js'
import {
  AvatarImageError,
  assertAvatarImage,
  assertDeclaredAvatarMediaType,
  decodeAvatarBase64,
  normalizeAvatarFileName,
  type AvatarMediaType,
} from '../services/avatar-image-guard.js'
import {
  BUILTIN_AVATAR_PACKAGE_IDS,
  commitGeneratedPackage,
  loadBuiltinAvatarPreview,
  prepareGeneratedPackagePaths,
  type GeneratedPackagePaths,
} from '../services/generated-package-publish.js'
import type { SkillCatalogService } from '../services/skill-catalog-service.js'
import {
  DEFAULT_WORLD_GENERATOR_SCENE_ID,
  WORLD_GENERATOR_SCENE_PACKAGE_IDS,
  WORLD_GENERATOR_TEMPLATE_ID,
  normalizeWorldSource,
  normalizeWorldThemeDraft,
  sourceReference,
  type WorldImportAnalyzerPort,
} from '../services/world-import-analyzer.js'
import {
  WORLD_BACKGROUND_MAX_BYTES,
  compileWorldThemePackage,
  type WorldThemeCastCompileInput,
  type WorldThemeSceneBase,
} from '../services/world-theme-package-compiler.js'

/** Same host-owned safe set the Character Generator labels; see its routes. */
const CAPABILITY_CATALOG: CharacterGeneratorCapabilityCatalogItem[] = [
  { id: 'workspace:read', displayName: '读取工作区', summary: '允许角色读取当前工作区内已授权的文件。' },
  { id: 'knowledge:read', displayName: '读取知识', summary: '允许角色读取当前世界已授权的知识资料。' },
  { id: 'artifact:read', displayName: '读取产物', summary: '允许角色读取当前世界已发布的产物。' },
]
const PUBLISHER = 'DSH Cyber World Generator'
/**
 * The shared image guard speaks about avatars. A background upload walks the
 * same checks and surfaces the same failure codes under the world's own
 * prefix and wording, so a client never has to translate an avatar error
 * into a background one.
 */
const BACKGROUND_ERROR_MESSAGES: Record<string, string> = {
  world_background_data_invalid: '世界背景图片数据无效。',
  world_background_size_invalid: '世界背景图片不能超过 4 MiB。',
  world_background_signature_invalid: '世界背景必须是 PNG、JPEG 或 WebP 图片。',
  world_background_dimensions_invalid: '世界背景图片尺寸超出允许范围。',
  world_background_mime_invalid: '世界背景图片格式不受支持。',
  world_background_mime_mismatch: '世界背景图片的声明格式与实际内容不一致。',
  world_background_filename_invalid: '上传的世界背景文件名无效。',
}

export interface WorldGeneratorRoutesDependencies {
  store: SqliteStore
  packageCatalog: LocalPackageCatalog
  skillCatalog: Pick<SkillCatalogService, 'listWorkspace'>
  analyzer: WorldImportAnalyzerPort
  /** Generated packages are workspace-private; resolved per request. */
  resolveMarketplaceRoot(workspaceId: string): string
  /** Host boundary every generated write must stay inside. */
  containmentRoot?: string
}

export function registerWorldGeneratorRoutes(router: Router, dependencies: WorldGeneratorRoutesDependencies): void {
  const { store, packageCatalog, skillCatalog, analyzer } = dependencies
  const declaredContainmentRoot = dependencies.containmentRoot === undefined ? undefined : resolve(dependencies.containmentRoot)

  router.get(/^\/api\/workspaces\/([^/]+)\/world-generator\/catalog$/, async ({ response, params }) => {
    const workspaceId = params[0]!
    assertWorkspace(store, workspaceId)
    const skills = await skillCatalog.listWorkspace(workspaceId).catch(() => [])
    const catalog: WorldGeneratorCatalog = {
      targetWorldTemplateId: WORLD_GENERATOR_TEMPLATE_ID,
      scenes: await listOfficialScenes(packageCatalog),
      skills,
      capabilities: CAPABILITY_CATALOG.map((item) => ({ ...item })),
    }
    writeJson(response, 200, { catalog })
  })

  router.post(/^\/api\/workspaces\/([^/]+)\/world-generator\/analyze$/, async ({ request, response, params }) => {
    const workspaceId = params[0]!
    assertWorkspace(store, workspaceId)
    const body = await readJson(request)
    const { source } = parseSource(body.source)
    const result = await analyzer.analyze({ workspaceId, source })
    const allowedSkillIds = await workspaceSkillIds(skillCatalog, workspaceId)
    // The analyzer port is host code, but a stub or a future port may return
    // anything: rebuild the draft through the publish-time parser in filter
    // mode so nothing unknown reaches the client as a suggestion.
    const draft = normalizeWorldThemeDraft(result.draft, { allowedSkillIds, sourceRef: sourceReference(source), originalText: source.text })
    const suggestedSceneId = typeof result.suggestedSceneId === 'string' && (WORLD_GENERATOR_SCENE_PACKAGE_IDS as readonly string[]).includes(result.suggestedSceneId)
      ? result.suggestedSceneId
      : undefined
    const output: WorldImportAnalyzeResult = { draft, ...(suggestedSceneId === undefined ? {} : { suggestedSceneId }) }
    writeJson(response, 200, output)
  })

  router.post(/^\/api\/workspaces\/([^/]+)\/world-generator\/publish$/, async ({ request, response, params }) => {
    const workspaceId = params[0]!
    assertWorkspace(store, workspaceId)
    const body = await readJson(request)
    const parsedSource = parseSource(body.source)
    const source = parsedSource.source
    const allowedSkillIds = await workspaceSkillIds(skillCatalog, workspaceId)
    const rawDraft = record(body.draft)
    if (rawDraft === undefined) throw new HttpError(422, 'world_draft_invalid', '世界草稿必须是对象。')
    const draft = normalizeWorldThemeDraft(rawDraft, {
      allowedSkillIds,
      sourceRef: sourceReference(source),
      originalText: source.text,
      rejectUnknown: true,
    })
    const selection = parseSceneSelection(body.scene)
    // The upload is checked before anything is staged: the file name is
    // validated but never used to build a path, the payload is bounded before
    // it is decoded, and the media type comes from the bytes alone.
    const background = selection.kind === 'upload' ? loadUploadedBackground(selection) : undefined
    const base = await loadSceneBase(packageCatalog, selection.id)
    const marketplaceRoot = resolve(dependencies.resolveMarketplaceRoot(workspaceId))
    const containmentRoot = declaredContainmentRoot ?? marketplaceRoot
    const packageId = `generated.world.${randomUUID().replaceAll('-', '')}`
    const packageVersion = '1.0.0'
    const originalFormat = source.kind === 'file' && source.fileName?.toLowerCase().endsWith('.md') === true ? 'md' : 'txt'
    const staged: GeneratedPackagePaths[] = []
    const published: GeneratedPackagePaths[] = []
    try {
      const themePaths = await prepareGeneratedPackagePaths(containmentRoot, marketplaceRoot, 'themes', packageId, token())
      const cast: WorldThemeCastCompileInput[] = []
      const castPaths: GeneratedPackagePaths[] = []
      for (const [index, member] of draft.cast.entries()) {
        const castPackageId = `generated.character.${randomUUID().replaceAll('-', '')}`
        const paths = await prepareGeneratedPackagePaths(containmentRoot, marketplaceRoot, 'talent', castPackageId, token())
        // The built-in 2D avatar slot rotates through the official previews so
        // a cast does not render as four copies of one face.
        const avatarIndex = index % BUILTIN_AVATAR_PACKAGE_IDS.length
        const preview = await loadBuiltinAvatarPreview(packageCatalog, BUILTIN_AVATAR_PACKAGE_IDS[avatarIndex]!)
        castPaths.push(paths)
        cast.push({ packageId: castPackageId, sourceDirectory: paths.stagingDirectory, draft: member, fallbackAvatarIndex: avatarIndex, preview })
      }
      const compiled = await compileWorldThemePackage({
        sourceDirectory: themePaths.stagingDirectory,
        packageId,
        packageVersion,
        entrypointId: 'world-theme',
        templateId: WORLD_GENERATOR_TEMPLATE_ID,
        displayName: draft.displayName,
        summary: draft.summary,
        terminology: themeTerminology(draft),
        publisher: PUBLISHER,
        base,
        ...(background === undefined ? {} : { background }),
        cast,
        allowedSkillIds,
        createdAt: new Date().toISOString(),
        source: {
          originalText: parsedSource.originalText,
          originalFormat,
          analysis: draftAnalysis(draft, cast.map((member) => member.packageId)),
        },
      })
      staged.push(themePaths, ...castPaths)
      for (const paths of [themePaths, ...castPaths]) {
        await commitGeneratedPackage(containmentRoot, paths)
        staged.splice(staged.indexOf(paths), 1)
        published.push(paths)
      }
      const item = await packageCatalog.find(packageId, packageVersion, { workspaceId })
      if (item === undefined || item.verified || item.market !== 'theme') throw new Error('Generated world theme package failed catalog verification')
      const castItems: CyberMarketPackage[] = []
      for (const member of cast) {
        const castItem = await packageCatalog.find(member.packageId, packageVersion, { workspaceId })
        if (castItem === undefined || castItem.verified || castItem.market !== 'talent') throw new Error('Generated cast package failed catalog verification')
        castItems.push(castItem)
      }
      const output: WorldImportPublishResult = { item, theme: compiled.theme, cast: castItems }
      writeJson(response, 201, output)
    } catch (error) {
      for (const paths of staged) await rm(paths.stagingDirectory, { recursive: true, force: true }).catch(() => undefined)
      for (const paths of published) await rm(paths.installedDirectory, { recursive: true, force: true }).catch(() => undefined)
      if (error instanceof HttpError) throw error
      if (error instanceof AvatarImageError) throw background === undefined ? new HttpError(422, error.code, error.message) : backgroundHttpError(error)
      throw new HttpError(422, 'world_publish_failed', error instanceof Error ? error.message : '世界包发布失败')
    }
  })
}

function token(): string {
  return randomUUID().replaceAll('-', '')
}

function assertWorkspace(store: Pick<SqliteStore, 'getWorkspace'>, workspaceId: string): void {
  if (store.getWorkspace(workspaceId) === undefined) throw new HttpError(404, 'workspace_not_found', 'Workspace not found')
}

interface ParsedWorldSource {
  source: CharacterSourceInput
  /**
   * Raw request text retained UNCHANGED as `source/original.*`. Same policy
   * and the same two safety properties as the Character Generator (the archive
   * is inert and separately byte-bounded by the compiler); see parseSource in
   * character-generator-routes.ts for the full rationale.
   */
  originalText: string
}

function parseSource(value: unknown): ParsedWorldSource {
  const source = record(value)
  if (source === undefined) throw new HttpError(422, 'world_source_invalid', '世界来源必须是对象。')
  try {
    const originalText = source.text as string
    return {
      source: normalizeWorldSource({
        kind: source.kind as CharacterSourceInput['kind'],
        text: originalText,
        ...(source.fileName === undefined ? {} : { fileName: source.fileName as string }),
      }),
      originalText,
    }
  } catch (error) {
    throw new HttpError(422, error instanceof Error && 'code' in error ? String((error as Error & { code?: unknown }).code) : 'world_source_invalid', error instanceof Error ? error.message : '世界来源无效。')
  }
}

async function workspaceSkillIds(skillCatalog: Pick<SkillCatalogService, 'listWorkspace'>, workspaceId: string): Promise<ReadonlySet<string>> {
  const entries = await skillCatalog.listWorkspace(workspaceId).catch(() => [])
  return new Set(entries.map((entry) => entry.id.trim()).filter(Boolean))
}

function parseSceneSelection(value: unknown): WorldGeneratorSceneSelection {
  if (value === undefined || value === null) return { kind: 'official', id: DEFAULT_WORLD_GENERATOR_SCENE_ID }
  const input = record(value)
  if (input === undefined || (input.kind !== 'official' && input.kind !== 'upload') || typeof input.id !== 'string') {
    throw new HttpError(422, 'world_scene_invalid', '世界场景来源无效。')
  }
  // An upload still names an official scene: that is where its layout comes from.
  const id = input.id.trim()
  if (!(WORLD_GENERATOR_SCENE_PACKAGE_IDS as readonly string[]).includes(id)) {
    throw new HttpError(422, 'world_scene_not_allowed', '只能使用指定的官方世界场景。')
  }
  if (input.kind === 'official') return { kind: 'official', id }
  const { fileName, mimeType, dataBase64 } = input
  if (typeof fileName !== 'string' || typeof mimeType !== 'string' || typeof dataBase64 !== 'string') {
    throw new HttpError(422, 'world_scene_invalid', '上传的世界背景字段不完整。')
  }
  return { kind: 'upload', id, fileName, mimeType: mimeType as CharacterGeneratorAvatarMimeType, dataBase64 }
}

/**
 * The avatar upload boundary, applied to a scene background. Nothing the
 * client declared is trusted: the file name is validated but never joined
 * into a path (the stored file is always `assets/background.<sniffed ext>`),
 * the encoded payload is bounded before it is decoded, and the media type
 * comes from the bytes; the declaration is only cross-checked so a
 * mislabelled upload is refused rather than stored under the client's label.
 */
function loadUploadedBackground(selection: Extract<WorldGeneratorSceneSelection, { kind: 'upload' }>): { bytes: Buffer; mimeType: AvatarMediaType } {
  try {
    normalizeAvatarFileName(selection.fileName)
    const bytes = decodeAvatarBase64(selection.dataBase64, WORLD_BACKGROUND_MAX_BYTES)
    const mimeType = assertAvatarImage(bytes, WORLD_BACKGROUND_MAX_BYTES)
    assertDeclaredAvatarMediaType(selection.mimeType, mimeType)
    return { bytes, mimeType }
  } catch (error) {
    if (error instanceof AvatarImageError) throw backgroundHttpError(error)
    throw error
  }
}

function backgroundHttpError(error: AvatarImageError): HttpError {
  const code = error.code.replace(/^character_avatar_/u, 'world_background_')
  return new HttpError(422, code, BACKGROUND_ERROR_MESSAGES[code] ?? error.message)
}

/** Read one official theme package, validated, with its assets' bytes. */
async function loadOfficialTheme(
  packageCatalog: LocalPackageCatalog,
  packageId: string,
): Promise<{ item: CyberMarketPackage; theme: WorldThemeManifestV1 } | undefined> {
  const item = await packageCatalog.find(packageId)
  if (item === undefined || item.market !== 'theme' || !item.verified || item.manifest.kind !== 'world-theme') return undefined
  const entrypoint = item.manifest.entrypoints?.find((candidate) => candidate.kind === 'world-theme')
  if (entrypoint === undefined) return undefined
  let raw: unknown
  try {
    raw = JSON.parse((await packageCatalog.readDeclaredFile(item, entrypoint.path)).toString('utf8'))
  } catch {
    return undefined
  }
  if (!validateWorldThemeManifest(raw).valid) return undefined
  return { item, theme: raw as WorldThemeManifestV1 }
}

async function listOfficialScenes(packageCatalog: LocalPackageCatalog): Promise<WorldGeneratorSceneCatalogItem[]> {
  const result: WorldGeneratorSceneCatalogItem[] = []
  for (const packageId of WORLD_GENERATOR_SCENE_PACKAGE_IDS) {
    const official = await loadOfficialTheme(packageCatalog, packageId)
    const scene = official?.theme.scenes[0]
    if (official === undefined || scene === undefined) continue
    result.push({
      id: packageId,
      displayName: official.theme.displayName,
      packageId,
      packageVersion: official.item.manifest.version,
      sceneId: scene.id,
      source: 'official',
    })
  }
  return result
}

async function loadSceneBase(packageCatalog: LocalPackageCatalog, packageId: string): Promise<WorldThemeSceneBase> {
  const official = await loadOfficialTheme(packageCatalog, packageId)
  if (official === undefined) throw new HttpError(422, 'world_scene_not_found', '官方世界场景不可用。')
  const declared = new Set(official.item.manifest.files.map((file) => file.path))
  const assetBytes = new Map<string, Buffer>()
  for (const asset of official.theme.assets) {
    if (!declared.has(asset.src)) throw new HttpError(422, 'world_scene_asset_missing', '官方世界场景资源缺失。')
    assetBytes.set(asset.src, await packageCatalog.readDeclaredFile(official.item, asset.src))
  }
  return {
    renderer: official.theme.renderer,
    assets: official.theme.assets,
    actorSets: official.theme.actorSets,
    scenes: official.theme.scenes,
    activityMapping: official.theme.activityMapping,
    assetBytes,
  }
}

/**
 * The theme vocabulary in the shape the official themes use: the four slots
 * plus `workflow` and `rules` arrays (see ai-academy.ts).
 */
function themeTerminology(draft: WorldThemeDraft): JsonObject {
  return {
    world: draft.terminology.world,
    participant: draft.terminology.participant,
    session: draft.terminology.session,
    milestone: draft.terminology.milestone,
    workflow: [...draft.workflow],
    rules: [...draft.rules],
  }
}

function draftAnalysis(draft: WorldThemeDraft, castPackageIds: string[]): JsonObject {
  return {
    schemaVersion: draft.schemaVersion,
    targetWorldTemplateId: draft.targetWorldTemplateId,
    displayName: draft.displayName,
    summary: draft.summary,
    terminology: { ...draft.terminology },
    workflow: [...draft.workflow],
    rules: [...draft.rules],
    cast: draft.cast.map((member, index) => ({
      packageId: castPackageIds[index] ?? '',
      displayName: member.displayName,
      role: member.role,
      summary: member.summary,
    })),
    sourceSummary: draft.sourceSummary,
    sourceRefs: [...draft.sourceRefs],
  }
}

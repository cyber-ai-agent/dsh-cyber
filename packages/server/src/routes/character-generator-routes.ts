import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'

import { worldTemplate } from '@dsh-cyber/catalog'
import type {
  CharacterGeneratorAvatarCatalogItem,
  CharacterGeneratorAvatarMimeType,
  CharacterGeneratorAvatarSelection,
  CharacterGeneratorCatalog,
  CharacterGeneratorCapabilityCatalogItem,
  CharacterImportAnalyzeResult,
  CharacterImportPublishResult,
  CharacterSourceInput,
  JsonObject,
} from '@dsh-cyber/contracts'
import type { LocalPackageCatalog } from '@dsh-cyber/package-runtime'
import type { SqliteStore } from '@dsh-cyber/persistence'

import { HttpError } from '../http/errors.js'
import type { Router } from '../http/router.js'
import { readJson, record, requiredString } from '../http/request.js'
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
  normalizeCharacterBlueprintDraft,
  normalizeCharacterSource,
  type CharacterBlueprintDraftValidationContext,
  type CharacterImportAnalyzerPort,
} from '../services/character-import-analyzer.js'
import { compileEmployeeBlueprintPackage } from '../services/employee-blueprint-package-compiler.js'
import {
  BUILTIN_AVATAR_PACKAGE_IDS,
  DEFAULT_AVATAR_PACKAGE_ID,
  commitGeneratedPackage,
  loadBuiltinAvatarPreview,
  prepareGeneratedPackagePaths,
} from '../services/generated-package-publish.js'
import type { SkillCatalogService } from '../services/skill-catalog-service.js'

/**
 * Display metadata for the host-owned Character Generator safe capability
 * catalog. It only labels the ids that CHARACTER_GENERATOR_CAPABILITIES already
 * allows; the `CharacterGeneratorCapabilityId` type keeps this list from
 * introducing an id of its own.
 */
const CAPABILITY_CATALOG: CharacterGeneratorCapabilityCatalogItem[] = [
  { id: 'workspace:read', displayName: '读取工作区', summary: '允许角色读取当前工作区内已授权的文件。' },
  { id: 'knowledge:read', displayName: '读取知识', summary: '允许角色读取当前世界已授权的知识资料。' },
  { id: 'artifact:read', displayName: '读取产物', summary: '允许角色读取当前世界已发布的产物。' },
]

export interface CharacterGeneratorRoutesDependencies {
  store: SqliteStore
  packageCatalog: LocalPackageCatalog
  skillCatalog: Pick<SkillCatalogService, 'listWorkspace'>
  analyzer: CharacterImportAnalyzerPort
  /**
   * Generated packages are workspace-private, so the root is resolved per
   * request instead of being fixed once at registration.
   */
  resolveMarketplaceRoot(workspaceId: string): string
  /**
   * Host owned boundary the generated marketplace must stay inside. Every path
   * component between it and a written file is checked for symlinks, so a
   * planted link cannot redirect a publish outside the host's state. Defaults
   * to the requesting workspace's own marketplace root when the caller has no
   * wider boundary to enforce.
   */
  containmentRoot?: string
}

export function registerCharacterGeneratorRoutes(
  router: Router,
  dependencies: CharacterGeneratorRoutesDependencies,
): void {
  const { store, packageCatalog, skillCatalog, analyzer } = dependencies
  const declaredContainmentRoot = dependencies.containmentRoot === undefined
    ? undefined
    : resolve(dependencies.containmentRoot)

  router.get(/^\/api\/workspaces\/([^/]+)\/character-generator\/catalog$/, async ({ response, params, url }) => {
    const workspaceId = params[0]!
    assertWorkspace(store, workspaceId)
    const worldTemplateId = optionalWorldTemplateId(url.searchParams.get('worldTemplateId'))
    const skills = await skillCatalog.listWorkspace(workspaceId).catch(() => [])
    const avatars = await listBuiltinAvatars(packageCatalog)
    const catalog: CharacterGeneratorCatalog = {
      capabilities: CAPABILITY_CATALOG.map((item) => ({ ...item })),
      avatars,
      skills,
    }
    writeJson(response, 200, {
      catalog,
      // Keep an items alias for simple catalog consumers; the structured
      // catalog remains authoritative for capabilities and avatar options.
      items: catalog.skills,
      capabilities: catalog.capabilities,
      avatars: catalog.avatars,
      skills: catalog.skills,
      ...(worldTemplateId === undefined ? {} : { worldTemplateId }),
    })
  })

  router.post(/^\/api\/workspaces\/([^/]+)\/character-generator\/analyze$/, async ({ request, response, params }) => {
    const workspaceId = params[0]!
    assertWorkspace(store, workspaceId)
    const body = await readJson(request)
    const targetWorldTemplateId = parseTargetWorldTemplateId(body)
    const { source } = parseSource(body.source)
    const result = await analyzer.analyze({ workspaceId, targetWorldTemplateId, source })
    const allowedSkillIds = await workspaceSkillIds(skillCatalog, workspaceId)
    const draft = normalizeCharacterBlueprintDraft(result.draft, analyzeDraftContext(targetWorldTemplateId, source, allowedSkillIds))
    const output: CharacterImportAnalyzeResult = { draft }
    writeJson(response, 200, output)
  })

  router.post(/^\/api\/workspaces\/([^/]+)\/character-generator\/publish$/, async ({ request, response, params }) => {
    const workspaceId = params[0]!
    assertWorkspace(store, workspaceId)
    const body = await readJson(request)
    const targetWorldTemplateId = parseTargetWorldTemplateId(body)
    const parsedSource = parseSource(body.source)
    const source = parsedSource.source
    const allowedSkillIds = await workspaceSkillIds(skillCatalog, workspaceId)
    const rawDraft = record(body.draft)
    if (rawDraft === undefined) throw new HttpError(422, 'character_draft_invalid', '角色草稿必须是对象。')
    const draft = normalizeCharacterBlueprintDraft(rawDraft, {
      targetWorldTemplateId,
      allowedSkillIds,
      sourceRef: sourceReference(source),
      originalText: source.text,
      rejectUnknown: true,
    })
    const selection = parseAvatarSelection(body.avatar)
    const avatar = await loadPreview(packageCatalog, selection)
    const marketplaceRoot = resolve(dependencies.resolveMarketplaceRoot(workspaceId))
    // Generated roots are per workspace, so the containment boundary falls back
    // to this workspace's own root rather than to a shared one.
    const containmentRoot = declaredContainmentRoot ?? marketplaceRoot
    const packageId = `generated.character.${randomUUID().replaceAll('-', '')}`
    const packageVersion = '1.0.0'
    const analysis = draftAnalysis(draft)
    const originalFormat = source.kind === 'file' && source.fileName?.toLowerCase().endsWith('.md') === true ? 'md' : 'txt'
    let stagingDirectory: string | undefined
    let installedDirectory: string | undefined
    let staged = false
    let published = false
    try {
      // Create and verify the target tree inside the try so a hostile or broken
      // layout answers with a publish failure instead of an internal error.
      const paths = await prepareGeneratedPackagePaths(containmentRoot, marketplaceRoot, 'talent', packageId, randomUUID().replaceAll('-', ''))
      stagingDirectory = paths.stagingDirectory
      installedDirectory = paths.installedDirectory
      const compiled = await compileEmployeeBlueprintPackage({
        sourceDirectory: stagingDirectory,
        packageId,
        blueprintVersion: 1,
        packageVersion,
        entrypointId: 'character-blueprint',
        worldTemplateId: targetWorldTemplateId,
        displayName: draft.displayName,
        role: draft.role,
        summary: draft.summary,
        persona: draft.persona,
        publisher: 'DSH Cyber Character Generator',
        // draft.background and draft.personalityTraits are deliberately NOT
        // passed to the blueprint: they are EmployeeProfile content, not
        // persona content, and the package keeps them in source/analysis.json
        // as reviewed reference material only.
        requestedSkills: draft.requestedSkillIds,
        requestedCapabilities: draft.requestedCapabilities,
        ...(draft.embodiment === undefined ? {} : { embodiment: draft.embodiment }),
        createdAt: new Date().toISOString(),
        fallbackAvatarIndex: fallbackAvatarIndex(selection, packageId),
        source: {
          originalText: parsedSource.originalText,
          originalFormat,
          analysis,
          preview: { ...avatar, ownedByCharacter: selection?.kind === 'upload' },
        },
      })
      staged = true
      await commitGeneratedPackage(containmentRoot, paths)
      staged = false
      published = true
      const item = await packageCatalog.find(packageId, packageVersion, { workspaceId })
      if (item === undefined || item.verified) throw new Error('Generated character package failed catalog verification')
      const output: CharacterImportPublishResult = { item, blueprint: compiled.blueprint }
      writeJson(response, 201, output satisfies CharacterImportPublishResult)
    } catch (error) {
      if (staged && stagingDirectory !== undefined) await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined)
      if (published && installedDirectory !== undefined) await rm(installedDirectory, { recursive: true, force: true }).catch(() => undefined)
      if (error instanceof HttpError) throw error
      throw new HttpError(422, 'character_publish_failed', error instanceof Error ? error.message : '角色包发布失败')
    }
  })
}

function assertWorkspace(store: Pick<SqliteStore, 'getWorkspace'>, workspaceId: string): void {
  if (store.getWorkspace(workspaceId) === undefined) throw new HttpError(404, 'workspace_not_found', 'Workspace not found')
}

function parseTargetWorldTemplateId(body: Record<string, unknown>): string {
  const value = requiredString(body, 'targetWorldTemplateId')
  const normalized = value.trim()
  if (worldTemplate(normalized) === undefined) throw new HttpError(422, 'character_world_template_invalid', '目标世界模板不存在。')
  return normalized
}

function optionalWorldTemplateId(value: string | null): string | undefined {
  if (value === null || value.trim() === '') return undefined
  const normalized = value.trim()
  if (worldTemplate(normalized) === undefined) throw new HttpError(422, 'character_world_template_invalid', '目标世界模板不存在。')
  return normalized
}

interface ParsedCharacterSource {
  /** Normalized and validated. Everything derived from the source uses this. */
  source: CharacterSourceInput
  /**
   * The raw request text, retained UNCHANGED as the package's
   * `source/original.*` provenance file. This is deliberate, not an oversight;
   * see parseSource.
   */
  originalText: string
}

/**
 * Split the source into the validated form the pipeline runs on and the raw
 * form the package archives.
 *
 * `originalText` is kept RAW on purpose. `source/original.*` answers one
 * question — what did the human actually hand us — and provenance that has been
 * silently rewritten cannot be diffed against the operator's own file. The NFC
 * pass and the trim in normalizeCharacterSource exist so the DERIVED draft is
 * stable, not to sanitize the archive; applying them here would drop a trailing
 * newline and recompose combining marks in a file whose whole value is being
 * byte-exact.
 *
 * Two properties make that safe, and both are pinned in
 * character-generator-confirmations.test.ts (B-FIX-6):
 *
 *  1. The archive is inert. Nothing in the product reads `source/original.*`:
 *     it is not an entrypoint, the marketplace preview route selects only
 *     image extensions out of manifest.files, and the sole code that touches
 *     the bytes is the SHA-256 integrity check. It never reaches a persona, a
 *     blueprint field, a dossier or a runtime turn request.
 *  2. The raw form is separately bounded. normalizeCharacterSource applies its
 *     128 KiB check to the NFC form, which UTF-8 NFD can exceed by up to 3x, so
 *     that check alone is not a bound on what gets written; the compiler
 *     re-checks the raw originalText against the same 128 KiB before it stages
 *     anything.
 *
 * The residual gap between the two forms is exactly VT (U+000B) and FF (U+000C)
 * in leading or trailing position — the only rejected control characters that
 * `trim()` removes. NUL and ESC are not whitespace, so they are refused in every
 * position and no escape sequence can reach the archive.
 *
 * If either property above stops holding — something starts reading the file,
 * or the compiler's byte bound goes away — retain `source.text` here instead.
 */
function parseSource(value: unknown): ParsedCharacterSource {
  const source = record(value)
  if (source === undefined) throw new HttpError(422, 'character_source_invalid', '角色来源必须是对象。')
  try {
    const originalText = source.text as string
    return {
      source: normalizeCharacterSource({
      kind: source.kind as CharacterSourceInput['kind'],
      text: originalText,
      ...(source.fileName === undefined ? {} : { fileName: source.fileName as string }),
      }),
      originalText,
    }
  } catch (error) {
    throw characterSourceHttpError(error)
  }
}

function characterSourceHttpError(error: unknown): HttpError {
  return new HttpError(422, error instanceof Error && 'code' in error ? String((error as Error & { code?: unknown }).code) : 'character_source_invalid', error instanceof Error ? error.message : '角色来源无效。')
}

function analyzeDraftContext(
  targetWorldTemplateId: string,
  source: CharacterSourceInput,
  allowedSkillIds: ReadonlySet<string>,
): CharacterBlueprintDraftValidationContext {
  return {
    targetWorldTemplateId,
    allowedSkillIds,
    sourceRef: sourceReference(source),
    originalText: source.text,
  }
}

async function workspaceSkillIds(
  skillCatalog: Pick<SkillCatalogService, 'listWorkspace'>,
  workspaceId: string,
): Promise<ReadonlySet<string>> {
  const entries = await skillCatalog.listWorkspace(workspaceId).catch(() => [])
  return new Set(entries.map((entry) => entry.id.trim()).filter(Boolean))
}

function sourceReference(source: CharacterSourceInput): string {
  return source.fileName === undefined ? `source:${source.kind}` : `source:${source.fileName}`
}

async function listBuiltinAvatars(packageCatalog: LocalPackageCatalog): Promise<CharacterGeneratorAvatarCatalogItem[]> {
  const result: CharacterGeneratorAvatarCatalogItem[] = []
  for (const [avatarIndex, packageId] of BUILTIN_AVATAR_PACKAGE_IDS.entries()) {
    const item = await packageCatalog.find(packageId)
    if (item === undefined || item.market !== 'talent' || !item.verified || item.manifest.kind !== 'employee-blueprint') continue
    const preview = item.manifest.files.find((file) => /\.(?:png|jpe?g|webp)$/iu.test(file.path))
    if (preview === undefined) continue
    // The declared path only narrows the candidates; the stored bytes decide
    // the media type advertised to the client.
    let mimeType: AvatarMediaType
    try {
      mimeType = assertAvatarImage(await packageCatalog.readDeclaredFile(item, preview.path))
    } catch {
      continue
    }
    result.push({
      id: packageId,
      displayName: item.manifest.displayName,
      avatarIndex,
      label: item.manifest.displayName,
      packageId,
      packageVersion: item.manifest.version,
      previewPath: preview.path,
      mimeType,
      source: 'builtin',
    })
  }
  return result
}

async function loadPreview(
  packageCatalog: LocalPackageCatalog,
  selection: CharacterGeneratorAvatarSelection | undefined,
): Promise<{ bytes: Buffer; mimeType: AvatarMediaType }> {
  const chosen = selection ?? { kind: 'builtin' as const, id: DEFAULT_AVATAR_PACKAGE_ID }
  try {
    if (chosen.kind === 'builtin') return await loadBuiltinAvatarPreview(packageCatalog, chosen.id)
    // Nothing the client declared is trusted here. The file name is validated
    // but never used to build a path, the encoded payload is bounded before it
    // is decoded, and the media type comes from the bytes — the declaration is
    // only cross-checked so a mislabelled upload is refused rather than stored.
    normalizeAvatarFileName(chosen.fileName)
    const bytes = decodeAvatarBase64(chosen.dataBase64)
    const mimeType = assertAvatarImage(bytes)
    assertDeclaredAvatarMediaType(chosen.mimeType, mimeType)
    return { bytes, mimeType }
  } catch (error) {
    if (error instanceof AvatarImageError) throw new HttpError(422, error.code, error.message)
    throw error
  }
}

/**
 * Freezes the built-in 2D avatar slot into the published talent.
 *
 * The picker already decided this when the draft was reviewed, so a built-in
 * selection is simply recorded. An upload still needs a slot for the case
 * where the image cannot be rendered; deriving it from the immutable package
 * id keeps that answer identical on every later read instead of re-rolling it
 * per render or per page load.
 */
function fallbackAvatarIndex(
  selection: CharacterGeneratorAvatarSelection | undefined,
  packageId: string,
): number {
  if (selection === undefined || selection.kind === 'builtin') {
    const id = selection?.id ?? DEFAULT_AVATAR_PACKAGE_ID
    const position = (BUILTIN_AVATAR_PACKAGE_IDS as readonly string[]).indexOf(id)
    return position < 0 ? 0 : position
  }
  let total = 0
  for (const character of packageId) total = (total * 31 + character.charCodeAt(0)) % 8
  return total
}

function parseAvatarSelection(value: unknown): CharacterGeneratorAvatarSelection | undefined {
  if (value === undefined || value === null) return undefined
  const input = record(value)
  if (input === undefined || (input.kind !== 'builtin' && input.kind !== 'upload' && input.kind !== 'builtin-2d' && input.kind !== 'uploaded-2d')) {
    throw new HttpError(422, 'character_avatar_invalid', '角色预览来源无效。')
  }
  if (input.kind === 'builtin' || input.kind === 'builtin-2d') {
    const avatarId = typeof input.id === 'string' ? input.id.trim() : typeof input.avatarId === 'string' ? input.avatarId.trim() : undefined
    const avatarIndex = typeof input.avatarIndex === 'number' && Number.isInteger(input.avatarIndex) ? input.avatarIndex : 0
    const id = avatarId !== undefined && avatarId !== '' && (BUILTIN_AVATAR_PACKAGE_IDS as readonly string[]).includes(avatarId)
      ? avatarId
      : BUILTIN_AVATAR_PACKAGE_IDS[Math.max(0, Math.min(BUILTIN_AVATAR_PACKAGE_IDS.length - 1, avatarIndex))] ?? DEFAULT_AVATAR_PACKAGE_ID
    return { kind: 'builtin', id }
  }
  const fileName = typeof input.fileName === 'string' ? input.fileName : typeof input.name === 'string' ? input.name : undefined
  const mimeType = input.mimeType
  const dataBase64 = input.dataBase64
  if (typeof fileName !== 'string' || typeof mimeType !== 'string' || typeof dataBase64 !== 'string') {
    throw new HttpError(422, 'character_avatar_invalid', '上传的角色预览字段不完整。')
  }
  return {
    kind: 'upload',
    fileName,
    mimeType: mimeType as CharacterGeneratorAvatarMimeType,
    dataBase64,
  }
}

function draftAnalysis(draft: ReturnType<typeof normalizeCharacterBlueprintDraft>): JsonObject {
  return {
    schemaVersion: draft.schemaVersion,
    targetWorldTemplateId: draft.targetWorldTemplateId,
    displayName: draft.displayName,
    role: draft.role,
    summary: draft.summary,
    persona: draft.persona,
    personalityTraits: [...draft.personalityTraits],
    background: draft.background,
    requestedSkillIds: [...draft.requestedSkillIds],
    requestedCapabilities: [...draft.requestedCapabilities],
    sourceSummary: draft.sourceSummary,
    sourceRefs: [...draft.sourceRefs],
    ...(draft.embodiment === undefined ? {} : { embodiment: structuredClone(draft.embodiment) as unknown as JsonObject }),
  }
}

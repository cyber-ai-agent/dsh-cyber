import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'

import type {
  CharacterSourceInput,
  JsonObject,
  SkinDraft,
  SkinGeneratorBackdropCatalogItem,
  SkinGeneratorBackdropSelection,
  SkinGeneratorCatalog,
  SkinImportAnalyzeResult,
  SkinImportPublishResult,
} from '@dsh-cyber/contracts'
import type { LocalPackageCatalog } from '@dsh-cyber/package-runtime'
import type { SqliteStore } from '@dsh-cyber/persistence'

import { HttpError } from '../http/errors.js'
import type { Router } from '../http/router.js'
import { readJson, record } from '../http/request.js'
import { writeJson } from '../http/response.js'
import { SKIN_BACKDROP_SKIN_IDS } from '../skin-manifest.js'
import {
  commitGeneratedPackage,
  prepareGeneratedPackagePaths,
  type GeneratedPackagePaths,
} from '../services/generated-package-publish.js'
import {
  normalizeSkinDraft,
  normalizeSkinSource,
  skinSourceReference,
  type SkinImportAnalyzerPort,
} from '../services/skin-import-analyzer.js'
import { compileSkinPackage } from '../services/skin-package-compiler.js'

const PUBLISHER = 'DSH Cyber Skin Generator'

export interface SkinGeneratorRoutesDependencies {
  store: SqliteStore
  packageCatalog: LocalPackageCatalog
  analyzer: SkinImportAnalyzerPort
  /** Generated packages are workspace-private; resolved per request. */
  resolveMarketplaceRoot(workspaceId: string): string
  /** Host boundary every generated write must stay inside. */
  containmentRoot?: string
}

export function registerSkinGeneratorRoutes(router: Router, dependencies: SkinGeneratorRoutesDependencies): void {
  const { store, packageCatalog, analyzer } = dependencies
  const declaredContainmentRoot = dependencies.containmentRoot === undefined ? undefined : resolve(dependencies.containmentRoot)

  router.get(/^\/api\/workspaces\/([^/]+)\/skin-generator\/catalog$/, async ({ response, params }) => {
    const workspaceId = params[0]!
    assertWorkspace(store, workspaceId)
    const catalog: SkinGeneratorCatalog = { backdrops: await listOfficialBackdrops(packageCatalog) }
    writeJson(response, 200, { catalog })
  })

  router.post(/^\/api\/workspaces\/([^/]+)\/skin-generator\/analyze$/, async ({ request, response, params }) => {
    const workspaceId = params[0]!
    assertWorkspace(store, workspaceId)
    const body = await readJson(request)
    const { source } = parseSource(body.source)
    const result = await analyzer.analyze({ workspaceId, source })
    // The analyzer port is host code, but a stub or a future port may return
    // anything: rebuild the draft through the publish-time parser in filter
    // mode so nothing unknown reaches the client as a suggestion.
    const draft = normalizeSkinDraft(result.draft, { sourceRef: skinSourceReference(source), originalText: source.text })
    const suggestedBackdropId = typeof result.suggestedBackdropId === 'string' && (SKIN_BACKDROP_SKIN_IDS as readonly string[]).includes(result.suggestedBackdropId)
      ? result.suggestedBackdropId
      : undefined
    const output: SkinImportAnalyzeResult = { draft, ...(suggestedBackdropId === undefined ? {} : { suggestedBackdropId }) }
    writeJson(response, 200, output)
  })

  router.post(/^\/api\/workspaces\/([^/]+)\/skin-generator\/publish$/, async ({ request, response, params }) => {
    const workspaceId = params[0]!
    assertWorkspace(store, workspaceId)
    const body = await readJson(request)
    const parsedSource = parseSource(body.source)
    const source = parsedSource.source
    const rawDraft = record(body.draft)
    if (rawDraft === undefined) throw new HttpError(422, 'skin_draft_invalid', '皮肤草稿必须是对象。')
    const draft = normalizeSkinDraft(rawDraft, {
      sourceRef: skinSourceReference(source),
      originalText: source.text,
      rejectUnknown: true,
    })
    const backdrop = parseBackdropSelection(body.backdrop)
    if (backdrop !== undefined) await assertOfficialBackdrop(packageCatalog, backdrop.id)
    const marketplaceRoot = resolve(dependencies.resolveMarketplaceRoot(workspaceId))
    const containmentRoot = declaredContainmentRoot ?? marketplaceRoot
    const packageId = `generated.skin.${randomUUID().replaceAll('-', '')}`
    const packageVersion = '1.0.0'
    const originalFormat = source.kind === 'file' && source.fileName?.toLowerCase().endsWith('.md') === true ? 'md' : 'txt'
    let paths: GeneratedPackagePaths | undefined
    let committed = false
    try {
      paths = await prepareGeneratedPackagePaths(containmentRoot, marketplaceRoot, 'skins', packageId, token())
      const compiled = await compileSkinPackage({
        sourceDirectory: paths.stagingDirectory,
        packageId,
        packageVersion,
        displayName: draft.displayName,
        summary: draft.summary,
        palette: draft.palette,
        ...(backdrop === undefined ? {} : { backdropSkinId: backdrop.id }),
        publisher: PUBLISHER,
        createdAt: new Date().toISOString(),
        source: {
          originalText: parsedSource.originalText,
          originalFormat,
          analysis: draftAnalysis(draft, backdrop?.id),
        },
      })
      await commitGeneratedPackage(containmentRoot, paths)
      committed = true
      const item = await packageCatalog.find(packageId, packageVersion, { workspaceId })
      if (item === undefined || item.verified || item.market !== 'skin') throw new Error('Generated skin package failed catalog verification')
      const output: SkinImportPublishResult = { item, skin: compiled.skin }
      writeJson(response, 201, output)
    } catch (error) {
      if (paths !== undefined) {
        await rm(committed ? paths.installedDirectory : paths.stagingDirectory, { recursive: true, force: true }).catch(() => undefined)
      }
      if (error instanceof HttpError) throw error
      throw new HttpError(422, 'skin_publish_failed', error instanceof Error ? error.message : '皮肤包发布失败')
    }
  })
}

function token(): string {
  return randomUUID().replaceAll('-', '')
}

function assertWorkspace(store: Pick<SqliteStore, 'getWorkspace'>, workspaceId: string): void {
  if (store.getWorkspace(workspaceId) === undefined) throw new HttpError(404, 'workspace_not_found', 'Workspace not found')
}

interface ParsedSkinSource {
  source: CharacterSourceInput
  /**
   * Raw request text retained UNCHANGED as `source/original.*`. Same policy
   * and the same two safety properties as the Character Generator (the archive
   * is inert and separately byte-bounded by the compiler); see parseSource in
   * character-generator-routes.ts for the full rationale.
   */
  originalText: string
}

function parseSource(value: unknown): ParsedSkinSource {
  const source = record(value)
  if (source === undefined) throw new HttpError(422, 'skin_source_invalid', '皮肤来源必须是对象。')
  try {
    const originalText = source.text as string
    return {
      source: normalizeSkinSource({
        kind: source.kind as CharacterSourceInput['kind'],
        text: originalText,
        ...(source.fileName === undefined ? {} : { fileName: source.fileName as string }),
      }),
      originalText,
    }
  } catch (error) {
    throw new HttpError(422, error instanceof Error && 'code' in error ? String((error as Error & { code?: unknown }).code) : 'skin_source_invalid', error instanceof Error ? error.message : '皮肤来源无效。')
  }
}

function parseBackdropSelection(value: unknown): SkinGeneratorBackdropSelection | undefined {
  if (value === undefined || value === null) return undefined
  const input = record(value)
  if (input === undefined || input.kind !== 'official' || typeof input.id !== 'string') {
    throw new HttpError(422, 'skin_backdrop_invalid', '皮肤背景来源无效。')
  }
  const id = input.id.trim()
  if (!(SKIN_BACKDROP_SKIN_IDS as readonly string[]).includes(id)) {
    throw new HttpError(422, 'skin_backdrop_not_allowed', '只能使用指定的官方皮肤场景。')
  }
  return { kind: 'official', id }
}

/** The official skin packages the backdrop allowlist names, as the catalog verifies them. */
async function listOfficialBackdrops(packageCatalog: LocalPackageCatalog): Promise<SkinGeneratorBackdropCatalogItem[]> {
  const result: SkinGeneratorBackdropCatalogItem[] = []
  for (const id of SKIN_BACKDROP_SKIN_IDS) {
    const item = await packageCatalog.find(id)
    if (item === undefined || item.market !== 'skin' || !item.verified || item.manifest.kind !== 'skin') continue
    result.push({ id, displayName: item.manifest.displayName, packageId: item.manifest.id, packageVersion: item.manifest.version, source: 'official' })
  }
  return result
}

async function assertOfficialBackdrop(packageCatalog: LocalPackageCatalog, id: string): Promise<void> {
  const item = await packageCatalog.find(id)
  if (item === undefined || item.market !== 'skin' || !item.verified || item.manifest.kind !== 'skin') {
    throw new HttpError(422, 'skin_backdrop_not_found', '官方皮肤场景不可用。')
  }
}

function draftAnalysis(draft: SkinDraft, backdropSkinId: string | undefined): JsonObject {
  return {
    schemaVersion: draft.schemaVersion,
    displayName: draft.displayName,
    summary: draft.summary,
    palette: { ...draft.palette },
    ...(backdropSkinId === undefined ? {} : { backdropSkinId }),
    sourceSummary: draft.sourceSummary,
    sourceRefs: [...draft.sourceRefs],
  }
}

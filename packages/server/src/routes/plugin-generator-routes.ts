import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'

import type {
  CharacterSourceInput,
  JsonObject,
  PluginDraft,
  PluginGeneratorCatalog,
  PluginGeneratorLimits,
  PluginGeneratorReservedTrigger,
  PluginImportAnalyzeResult,
  PluginImportPublishResult,
} from '@dsh-cyber/contracts'
import type { LocalPackageCatalog } from '@dsh-cyber/package-runtime'
import type { SqliteStore } from '@dsh-cyber/persistence'

import { HttpError } from '../http/errors.js'
import type { Router } from '../http/router.js'
import { readJson, record } from '../http/request.js'
import { writeJson } from '../http/response.js'
import { PROMPT_TRANSFORM_LIMITS, parsePromptTransformDefinition } from '../prompt-transform-parser.js'
import {
  commitGeneratedPackage,
  prepareGeneratedPackagePaths,
  type GeneratedPackagePaths,
} from '../services/generated-package-publish.js'
import {
  PLUGIN_TRANSFORM_MODES,
  normalizePluginDraft,
  normalizePluginSource,
  pluginSourceReference,
  type PluginImportAnalyzerPort,
} from '../services/plugin-import-analyzer.js'
import { compilePluginPackage } from '../services/plugin-package-compiler.js'

const PUBLISHER = 'DSH Cyber Plugin Generator'

export interface PluginGeneratorRoutesDependencies {
  store: SqliteStore
  packageCatalog: LocalPackageCatalog
  analyzer: PluginImportAnalyzerPort
  /** Generated packages are workspace-private; resolved per request. */
  resolveMarketplaceRoot(workspaceId: string): string
  /** Host boundary every generated write must stay inside. */
  containmentRoot?: string
}

export function registerPluginGeneratorRoutes(router: Router, dependencies: PluginGeneratorRoutesDependencies): void {
  const { store, packageCatalog, analyzer } = dependencies
  const declaredContainmentRoot = dependencies.containmentRoot === undefined ? undefined : resolve(dependencies.containmentRoot)

  router.get(/^\/api\/workspaces\/([^/]+)\/plugin-generator\/catalog$/, async ({ response, params }) => {
    const workspaceId = params[0]!
    assertWorkspace(store, workspaceId)
    const catalog: PluginGeneratorCatalog = {
      limits: pluginGeneratorLimits(),
      modes: [...PLUGIN_TRANSFORM_MODES],
      reservedTriggers: await listReservedTriggers(packageCatalog),
    }
    writeJson(response, 200, { catalog })
  })

  router.post(/^\/api\/workspaces\/([^/]+)\/plugin-generator\/analyze$/, async ({ request, response, params }) => {
    const workspaceId = params[0]!
    assertWorkspace(store, workspaceId)
    const body = await readJson(request)
    const { source } = parseSource(body.source)
    const result = await analyzer.analyze({ workspaceId, source })
    // The analyzer port is host code, but a stub or a future port may return
    // anything: rebuild the draft through the publish-time parser in filter
    // mode so nothing unknown reaches the client as a suggestion.
    const draft = normalizePluginDraft(result.draft, { sourceRef: pluginSourceReference(source), originalText: source.text })
    const output: PluginImportAnalyzeResult = { draft }
    writeJson(response, 200, output)
  })

  router.post(/^\/api\/workspaces\/([^/]+)\/plugin-generator\/publish$/, async ({ request, response, params }) => {
    const workspaceId = params[0]!
    assertWorkspace(store, workspaceId)
    const body = await readJson(request)
    const parsedSource = parseSource(body.source)
    const source = parsedSource.source
    const rawDraft = record(body.draft)
    if (rawDraft === undefined) throw new HttpError(422, 'plugin_draft_invalid', '插件草稿必须是对象。')
    const reserved = await listReservedTriggers(packageCatalog)
    const draft = normalizePluginDraft(rawDraft, {
      sourceRef: pluginSourceReference(source),
      originalText: source.text,
      rejectUnknown: true,
      reservedTriggers: new Map(reserved.map((item) => [item.trigger, item])),
    })
    const marketplaceRoot = resolve(dependencies.resolveMarketplaceRoot(workspaceId))
    const containmentRoot = declaredContainmentRoot ?? marketplaceRoot
    const packageId = `generated.plugin.${randomUUID().replaceAll('-', '')}`
    const packageVersion = '1.0.0'
    const originalFormat = source.kind === 'file' && source.fileName?.toLowerCase().endsWith('.md') === true ? 'md' : 'txt'
    let paths: GeneratedPackagePaths | undefined
    let committed = false
    try {
      paths = await prepareGeneratedPackagePaths(containmentRoot, marketplaceRoot, 'plugins', packageId, token())
      const compiled = await compilePluginPackage({
        sourceDirectory: paths.stagingDirectory,
        packageId,
        packageVersion,
        displayName: draft.displayName,
        summary: draft.summary,
        transforms: draft.transforms,
        publisher: PUBLISHER,
        createdAt: new Date().toISOString(),
        source: {
          originalText: parsedSource.originalText,
          originalFormat,
          analysis: draftAnalysis(draft),
        },
      })
      await commitGeneratedPackage(containmentRoot, paths)
      committed = true
      const item = await packageCatalog.find(packageId, packageVersion, { workspaceId })
      if (item === undefined || item.verified || item.market !== 'plugin' || item.manifest.kind !== 'plugin') {
        throw new Error('Generated plugin package failed catalog verification')
      }
      const output: PluginImportPublishResult = { item, definition: compiled.definition }
      writeJson(response, 201, output)
    } catch (error) {
      if (paths !== undefined) {
        await rm(committed ? paths.installedDirectory : paths.stagingDirectory, { recursive: true, force: true }).catch(() => undefined)
      }
      if (error instanceof HttpError) throw error
      throw new HttpError(422, 'plugin_publish_failed', error instanceof Error ? error.message : '插件包发布失败')
    }
  })
}

function token(): string {
  return randomUUID().replaceAll('-', '')
}

function assertWorkspace(store: Pick<SqliteStore, 'getWorkspace'>, workspaceId: string): void {
  if (store.getWorkspace(workspaceId) === undefined) throw new HttpError(404, 'workspace_not_found', 'Workspace not found')
}

/** The runtime parser's limits as the review UI needs them; no second table exists. */
function pluginGeneratorLimits(): PluginGeneratorLimits {
  return {
    maxTransforms: PROMPT_TRANSFORM_LIMITS.maxTransforms,
    maxIdLength: PROMPT_TRANSFORM_LIMITS.maxIdLength,
    maxTriggerLength: PROMPT_TRANSFORM_LIMITS.maxTriggerLength,
    maxDescriptionLength: PROMPT_TRANSFORM_LIMITS.maxDescriptionLength,
    maxInstructionLength: PROMPT_TRANSFORM_LIMITS.maxInstructionLength,
  }
}

/**
 * Every explicit trigger a plugin in the shared marketplace roots declares —
 * today the official plugins. A generated plugin may not reuse one: the
 * runtime applies every matching transform, so a duplicate would silently
 * stack a generated instruction onto an official command. Workspace-private
 * (generated) roots are not consulted: no workspace is named, so the catalog
 * fails closed to the shared roots by construction.
 */
async function listReservedTriggers(packageCatalog: LocalPackageCatalog): Promise<PluginGeneratorReservedTrigger[]> {
  const reserved = new Map<string, PluginGeneratorReservedTrigger>()
  for (const item of await packageCatalog.list({ market: 'plugin' })) {
    if (item.manifest.kind !== 'plugin') continue
    for (const entrypoint of item.manifest.entrypoints ?? []) {
      if (entrypoint.kind !== 'prompt-transform') continue
      try {
        const definition = parsePromptTransformDefinition(JSON.parse((await packageCatalog.readDeclaredFile(item, entrypoint.path)).toString('utf8')))
        for (const transform of definition.transforms) {
          if (transform.trigger === 'always' || reserved.has(transform.trigger)) continue
          reserved.set(transform.trigger, { trigger: transform.trigger, packageId: item.manifest.id, displayName: item.manifest.displayName })
        }
      } catch {
        // A malformed shared plugin reserves nothing; the installer refuses it anyway.
      }
    }
  }
  return [...reserved.values()].sort((left, right) => left.trigger.localeCompare(right.trigger))
}

interface ParsedPluginSource {
  source: CharacterSourceInput
  /**
   * Raw request text retained UNCHANGED as `source/original.*`. Same policy
   * and the same two safety properties as the Character Generator (the archive
   * is inert and separately byte-bounded by the compiler); see parseSource in
   * character-generator-routes.ts for the full rationale.
   */
  originalText: string
}

function parseSource(value: unknown): ParsedPluginSource {
  const source = record(value)
  if (source === undefined) throw new HttpError(422, 'plugin_source_invalid', '插件来源必须是对象。')
  try {
    const originalText = source.text as string
    return {
      source: normalizePluginSource({
        kind: source.kind as CharacterSourceInput['kind'],
        text: originalText,
        ...(source.fileName === undefined ? {} : { fileName: source.fileName as string }),
      }),
      originalText,
    }
  } catch (error) {
    throw new HttpError(422, error instanceof Error && 'code' in error ? String((error as Error & { code?: unknown }).code) : 'plugin_source_invalid', error instanceof Error ? error.message : '插件来源无效。')
  }
}

function draftAnalysis(draft: PluginDraft): JsonObject {
  return {
    schemaVersion: draft.schemaVersion,
    displayName: draft.displayName,
    summary: draft.summary,
    transforms: draft.transforms.map((transform) => ({ ...transform })),
    sourceSummary: draft.sourceSummary,
    sourceRefs: [...draft.sourceRefs],
  }
}

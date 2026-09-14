import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { JsonObject, SkillAuthoringDraft, SkillAuthoringPublishResult, SkillAuthoringSource } from '@dsh-cyber/contracts'
import type { LocalPackageCatalog } from '@dsh-cyber/package-runtime'
import type { SqliteStore } from '@dsh-cyber/persistence'

import { HttpError } from '../http/errors.js'
import { readJson, record } from '../http/request.js'
import { writeJson } from '../http/response.js'
import type { Router } from '../http/router.js'
import { commitGeneratedPackage, prepareGeneratedPackagePaths, type GeneratedPackagePaths } from '../services/generated-package-publish.js'
import { normalizeSkillDraft, normalizeSkillSource, type SkillAuthoringAnalyzerPort } from '../services/skill-authoring-analyzer.js'
import { compileSkillPackage } from '../services/skill-package-compiler.js'

export interface SkillAuthoringRoutesDependencies {
  store: SqliteStore
  packageCatalog: LocalPackageCatalog
  analyzer: SkillAuthoringAnalyzerPort
  resolveMarketplaceRoot(workspaceId: string): string
  containmentRoot?: string
}

export function registerSkillAuthoringRoutes(router: Router, dependencies: SkillAuthoringRoutesDependencies): void {
  const containment = dependencies.containmentRoot === undefined ? undefined : resolve(dependencies.containmentRoot)

  router.post(/^\/api\/workspaces\/([^/]+)\/skill-authoring\/analyze$/, async ({ request, response, params }) => {
    const workspaceId = params[0]!
    assertWorkspace(dependencies.store, workspaceId)
    const body = await readJson(request)
    const source = sourceInput(body.source)
    const current = body.current === undefined ? undefined : normalizeSkillDraft(body.current)
    writeJson(response, 200, await dependencies.analyzer.analyze({ workspaceId, source, ...(current === undefined ? {} : { current }) }))
  })

  router.post(/^\/api\/workspaces\/([^/]+)\/skill-authoring\/publish$/, async ({ request, response, params }) => {
    const workspaceId = params[0]!
    assertWorkspace(dependencies.store, workspaceId)
    const body = await readJson(request)
    const source = normalizeSkillSource(sourceInput(body.source))
    const draft = normalizeSkillDraft(body.draft, source)
    const base = basePackage(dependencies.store, workspaceId, body.basePackageId, body.basePackageVersion, draft)
    const packageId = base?.packageId ?? `generated.skill.${randomUUID().replaceAll('-', '')}`
    const packageVersion = base === undefined ? '1.0.0' : nextPatch(base.version)
    const marketplaceRoot = resolve(dependencies.resolveMarketplaceRoot(workspaceId))
    const containmentRoot = containment ?? marketplaceRoot
    const storageId = `${packageId}-${packageVersion.replaceAll('.', '-')}`
    let paths: GeneratedPackagePaths | undefined
    let committed = false
    try {
      paths = await prepareGeneratedPackagePaths(containmentRoot, marketplaceRoot, 'plugins', storageId, token())
      const { manifest } = await compileSkillPackage({
        sourceDirectory: paths.stagingDirectory, packageId, packageVersion, draft,
        source: { originalText: source.text, originalFormat: source.kind === 'file' && source.fileName?.toLowerCase().endsWith('.md') === true ? 'md' : 'txt', analysis: draft as unknown as JsonObject },
      })
      await commitGeneratedPackage(containmentRoot, paths); committed = true
      const item = await dependencies.packageCatalog.find(packageId, packageVersion, { workspaceId })
      if (item === undefined || item.verified || item.manifest.kind !== 'skill') throw new Error('Generated skill package failed catalog verification')
      const output: SkillAuthoringPublishResult = { item, draft }
      writeJson(response, 201, output)
    } catch (error) {
      if (paths !== undefined) await rm(committed ? paths.installedDirectory : paths.stagingDirectory, { recursive: true, force: true }).catch(() => undefined)
      if (error instanceof HttpError) throw error
      throw new HttpError(422, 'skill_publish_failed', error instanceof Error ? error.message : '技能包发布失败')
    }
  })
}

function sourceInput(value: unknown): SkillAuthoringSource {
  const source = record(value)
  if (source === undefined) throw new HttpError(422, 'skill_source_invalid', '技能来源必须是对象。')
  return { kind: source.kind as SkillAuthoringSource['kind'], text: source.text as string, ...(source.fileName === undefined ? {} : { fileName: source.fileName as string }) }
}

function basePackage(store: SqliteStore, workspaceId: string, packageIdValue: unknown, versionValue: unknown, draft: SkillAuthoringDraft): { packageId: string; version: string } | undefined {
  if (packageIdValue === undefined && versionValue === undefined) return undefined
  if (typeof packageIdValue !== 'string' || typeof versionValue !== 'string' || !packageIdValue.startsWith('generated.skill.')) throw new HttpError(422, 'skill_edit_source_invalid', '只能为技能中心创建的技能发布新版本。')
  const installed = store.getInstalledPackage(workspaceId, packageIdValue, versionValue)
  const ownsSkill = installed?.manifest.entrypoints?.some((entrypoint) => entrypoint.kind === 'skill' && entrypoint.id === draft.id) === true
  if (installed === undefined || installed.kind !== 'skill' || !ownsSkill) throw new HttpError(422, 'skill_edit_source_invalid', '技能编辑来源与当前草稿不匹配。')
  return { packageId: installed.packageId, version: installed.version }
}

function nextPatch(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (match === null) throw new HttpError(422, 'skill_version_invalid', '当前技能版本无法自动递增。')
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`
}
function assertWorkspace(store: Pick<SqliteStore, 'getWorkspace'>, workspaceId: string): void { if (store.getWorkspace(workspaceId) === undefined) throw new HttpError(404, 'workspace_not_found', 'Workspace not found') }
function token(): string { return randomUUID().replaceAll('-', '') }

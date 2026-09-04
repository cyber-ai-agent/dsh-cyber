import { createHash, randomUUID } from 'node:crypto'
import { copyFile, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'

import type {
  JsonObject,
  WorldArtifact,
  WorldArtifactFilter,
  WorldArtifactKind,
  WorldArtifactPublishManifest,
  WorldArtifactPublishManifestEntry,
  WorldArtifactPublication,
  WorldArtifactRunProvenance,
  WorldArtifactVersion,
} from '@dsh-cyber/contracts'
import { WorldArtifactRepository } from '@dsh-cyber/persistence'
import type { AgentRunCompletionContext, AgentRunCompletionContribution, AgentRunCompletionHook } from '@dsh-cyber/orchestration'

import { ServiceError } from './service-error.js'
import { isPathWithin, type WorldRoot, WorldRootService } from './world-root-service.js'
import { resolveCanonicalPathWithoutSymlinkHops, SymlinkHopError } from './canonical-path.js'

// The segment walk is shared with the knowledge library importer; both are
// re-exported here so existing callers keep importing them from this module.
export { resolveCanonicalPathWithoutSymlinkHops, SymlinkHopError } from './canonical-path.js'

/** Per-file and per-manifest caps keep publication bounded and predictable. */
export const WORLD_ARTIFACT_LIMITS = {
  manifestBytes: 512 * 1024,
  maxManifestEntries: 32,
  maxFileBytes: 50 * 1024 * 1024,
  maxProjectBytes: 100 * 1024 * 1024,
  maxProjectFiles: 512,
  maxProjectDepth: 16,
  previewBytes: 50 * 1024 * 1024,
} as const

export interface WorldArtifactServiceOptions {
  repository: WorldArtifactRepository
  roots: WorldRootService
  clock?: () => string
  /** Called after registry mutation so the single world live stream can announce it. */
  onChanged?: (worldId: string, payload: JsonObject) => void
}

export interface WorldArtifactView {
  artifact: WorldArtifact
  versions: WorldArtifactVersion[]
}

export interface PublishWorkspaceArtifactInput {
  workspaceId: string
  worldId: string
  sourceRelativePath: string
  title: string
  kind: WorldArtifactKind
  description?: string
  entrypoint?: string
  mimeType?: string
  artifactId?: string
  createdByKind: 'owner' | 'employee'
  createdById: string
  employeeId?: string
  sessionId?: string
  workTurnId?: string
  agentRunId?: string
  idempotencyKey?: string
}

export interface PublishImportedArtifactInput extends Omit<PublishWorkspaceArtifactInput, 'sourceRelativePath'> {
  /** Relative to the World root, or an absolute path that is still inside it. */
  sourcePath: string
}

/** Host-managed cache input for read-only Browser screenshots. */
export interface PublishBrowserScreenshotInput {
  workspaceId: string
  worldId: string
  bytes: Buffer
  title: string
  createdById: string
  workTurnId?: string
  agentRunId?: string
  idempotencyKey?: string
}

/** A model-generated image becoming a durable Artifact. */
export interface PublishGeneratedImageInput {
  workspaceId: string
  worldId: string
  bytes: Buffer
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp'
  title: string
  createdById: string
  sessionId?: string
  workTurnId?: string
  agentRunId?: string
  idempotencyKey?: string
}

export interface ArtifactPreview {
  artifact: WorldArtifact
  version: WorldArtifactVersion
  body: Buffer
  contentType: string
  isHtml: boolean
}

/**
 * Host-side Artifact authority.  The repository stores only registry and
 * provenance; this service is the only layer allowed to copy bytes into
 * exports/artifacts and to serve them back.
 */
export class WorldArtifactService {
  readonly #repository: WorldArtifactRepository
  readonly #roots: WorldRootService
  readonly #clock: () => string
  readonly #onChanged: ((worldId: string, payload: JsonObject) => void) | undefined

  constructor(options: WorldArtifactServiceOptions) {
    this.#repository = options.repository
    this.#roots = options.roots
    this.#clock = options.clock ?? (() => new Date().toISOString())
    this.#onChanged = options.onChanged
  }

  list(worldId: string, filter: WorldArtifactFilter = {}): WorldArtifact[] {
    return this.#repository.list(worldId, filter)
  }

  /**
   * Registry-only provenance read for the World Trace.
   *
   * It never touches the filesystem, so a trace projection cannot reach
   * artifact content through this service — only the rows naming which run
   * published what.
   */
  listRunProvenance(worldId: string): WorldArtifactRunProvenance[] {
    return this.#repository.listRunProvenance(worldId)
  }

  get(worldId: string, artifactId: string): WorldArtifactView {
    const artifact = this.#repository.get(worldId, artifactId)
    if (artifact === undefined) throw notFound('artifact_not_found', '产物不存在')
    return { artifact, versions: this.#repository.listVersions(worldId, artifactId) }
  }

  /**
   * Publish one file or project directory from the current Agent workspace.
   * The source is always read from `world/files`, never from `exports`.
   */
  async publishFromWorkspace(input: PublishWorkspaceArtifactInput): Promise<WorldArtifactPublication> {
    const root = await this.#roots.ensure(input.worldId)
    const sourceRelativePath = normalizeRelativePath(input.sourceRelativePath, 'source path')
    const sourcePath = join(root.filesPath, ...sourceRelativePath.split('/'))
    return this.#publishSource(root, sourcePath, sourceRelativePath, input)
  }

  /** Publish an existing World-owned file after the same containment checks. */
  async publishImportedFile(input: PublishImportedArtifactInput): Promise<WorldArtifactPublication> {
    const root = await this.#roots.ensure(input.worldId)
    const { sourcePath, sourceRelativePath } = await this.#resolveImportedPath(root, input.sourcePath)
    return this.#publishSource(root, sourcePath, sourceRelativePath, { ...input, sourceRelativePath }, root.rootPath)
  }

  /**
   * Publish a Browser screenshot through the host cache. The screenshot never
   * enters `world/files`; it is copied from a short-lived managed cache file
   * into the Artifact Center's immutable exports area and then removed.
   */
  async publishBrowserScreenshot(input: PublishBrowserScreenshotInput): Promise<WorldArtifactPublication> {
    if (!Buffer.isBuffer(input.bytes) || input.bytes.byteLength === 0 || input.bytes.byteLength > 4 * 1024 * 1024) {
      throw invalid('browser_screenshot_size_invalid', 'Browser 截图大小无效')
    }
    const root = await this.#roots.ensure(input.worldId)
    const cacheDirectory = join(root.cachePath, 'browser-screenshots')
    await mkdir(cacheDirectory, { recursive: true })
    const cachePath = join(cacheDirectory, `${randomUUID()}.png`)
    await writeFile(cachePath, input.bytes, { flag: 'wx', mode: 0o600 })
    try {
      return await this.publishImportedFile({
        workspaceId: input.workspaceId,
        worldId: input.worldId,
        sourcePath: cachePath,
        title: input.title,
        kind: 'image',
        mimeType: 'image/png',
        createdByKind: 'employee',
        createdById: input.createdById,
        ...(input.workTurnId === undefined ? {} : { workTurnId: input.workTurnId }),
        ...(input.agentRunId === undefined ? {} : { agentRunId: input.agentRunId }),
        ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
      })
    } finally {
      await rm(cachePath, { force: true }).catch(() => undefined)
    }
  }

  /** Publish an image a model just generated as a durable Artifact. */
  async publishGeneratedImage(input: PublishGeneratedImageInput): Promise<WorldArtifactPublication> {
    if (!Buffer.isBuffer(input.bytes) || input.bytes.byteLength === 0 || input.bytes.byteLength > 20 * 1024 * 1024) {
      throw invalid('generated_image_size_invalid', '生成的图片大小无效')
    }
    const extension = input.mimeType === 'image/jpeg' ? 'jpg' : input.mimeType === 'image/webp' ? 'webp' : 'png'
    const root = await this.#roots.ensure(input.worldId)
    const cacheDirectory = join(root.cachePath, 'generated-images')
    await mkdir(cacheDirectory, { recursive: true })
    const cachePath = join(cacheDirectory, `${randomUUID()}.${extension}`)
    await writeFile(cachePath, input.bytes, { flag: 'wx', mode: 0o600 })
    try {
      return await this.publishImportedFile({
        workspaceId: input.workspaceId,
        worldId: input.worldId,
        sourcePath: cachePath,
        title: input.title,
        kind: 'image',
        mimeType: input.mimeType,
        createdByKind: 'employee',
        createdById: input.createdById,
        ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
        ...(input.workTurnId === undefined ? {} : { workTurnId: input.workTurnId }),
        ...(input.agentRunId === undefined ? {} : { agentRunId: input.agentRunId }),
        ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
      })
    } finally {
      await rm(cachePath, { force: true }).catch(() => undefined)
    }
  }

  /** Append a new immutable version using an already registered artifact id. */
  async createVersion(input: PublishWorkspaceArtifactInput): Promise<WorldArtifactPublication> {
    if (input.artifactId === undefined) throw invalid('artifact_id_required', '新增版本需要 artifactId')
    return this.publishFromWorkspace(input)
  }

  archive(worldId: string, artifactId: string): WorldArtifact {
    const artifact = this.#repository.archive(worldId, artifactId)
    this.#notify(worldId, { artifactId, status: artifact.status })
    return artifact
  }

  restore(worldId: string, artifactId: string): WorldArtifact {
    const artifact = this.#repository.restore(worldId, artifactId)
    this.#notify(worldId, { artifactId, status: artifact.status })
    return artifact
  }

  rename(worldId: string, artifactId: string, title: string, description?: string): WorldArtifact {
    const artifact = this.#repository.rename(worldId, artifactId, title, description)
    this.#notify(worldId, { artifactId, status: artifact.status })
    return artifact
  }

  /** Remove one registry entry and its version directory without touching any workspace source. */
  async remove(worldId: string, artifactId: string): Promise<void> {
    this.get(worldId, artifactId)
    const root = await this.#roots.ensure(worldId)
    const artifactDirectory = resolve(root.exportsArtifactsPath, artifactId)
    if (!isPathWithin(root.exportsArtifactsPath, artifactDirectory) || artifactDirectory === root.exportsArtifactsPath) {
      throw conflict('artifact_path_invalid', '产物目录越界')
    }
    const quarantine = `${artifactDirectory}.deleting-${randomUUID()}`
    let moved = false
    if (await existingPath(artifactDirectory)) {
      await assertNoSymlinkSegments(root.exportsArtifactsPath, artifactDirectory)
      await rename(artifactDirectory, quarantine)
      moved = true
    }
    try {
      if (!this.#repository.remove(worldId, artifactId)) throw notFound('artifact_not_found', '产物不存在')
      if (moved) await rm(quarantine, { recursive: true, force: true })
      this.#notify(worldId, { artifactId, status: 'removed' })
    } catch (error) {
      if (moved && await existingPath(quarantine)) await rename(quarantine, artifactDirectory).catch(() => undefined)
      throw error
    }
  }

  /** Mark metadata missing without preventing the rest of the world from booting. */
  markMissing(worldId: string, artifactId: string): WorldArtifact {
    const artifact = this.#repository.setStatus(worldId, artifactId, 'missing')
    this.#notify(worldId, { artifactId, status: artifact.status })
    return artifact
  }

  /**
   * Read only the exact run manifest injected by the host.  No directory scan
   * or assistant-text inference is performed here.
   */
  async publishAgentRun(context: AgentRunCompletionContext): Promise<AgentRunCompletionContribution> {
    const root = await this.#roots.ensure(context.worldId)
    const workspacePath = await resolveAgentWorkspace(root, context.workspacePath)
    if (workspacePath === undefined) return noArtifactContribution()
    const manifestPath = this.#roots.publicationManifestPathAt(workspacePath, context.agentRunId)
    const manifestRead = await readExactManifest(workspacePath, manifestPath)
    const entries = manifestRead.found
      ? manifestRead.manifest.artifacts
      : await discoverRunArtifactEntries(workspacePath, context.runStartedAt, context.runCompletedAt)
    const artifactRefs: string[] = []
    for (const entry of entries) {
      const sourceRelativePath = normalizeRelativePath(entry.path, 'manifest path')
      const sourcePath = join(workspacePath, ...sourceRelativePath.split('/'))
      const worldRelativePath = toPosix(relative(root.filesPath, sourcePath))
      if (!worldRelativePath || worldRelativePath.startsWith('..')) {
        throw conflict('artifact_path_invalid', '产物路径不在当前世界工作区内')
      }
      const fingerprint = await inspectSource(root.filesPath, sourcePath)
      // The run and source path, rather than a random artifact id, define one
      // logical publication. If the process dies after the atomic move but
      // before SQLite commits, retrying finds the same target and repairs the
      // registry instead of leaving an orphaned version.
      const idempotencyKey = `agent-run:v1:${context.agentRunId}:${worldRelativePath}`
      const publication = await this.#publishSource(root, sourcePath, sourceRelativePath, {
        workspaceId: context.workspaceId,
        worldId: context.worldId,
        sourceRelativePath,
        title: entry.title,
        kind: entry.kind,
        ...(entry.description === undefined ? {} : { description: entry.description }),
        ...(entry.entrypoint === undefined ? {} : { entrypoint: entry.entrypoint }),
        createdByKind: 'employee',
        createdById: context.employeeId,
        employeeId: context.employeeId,
        sessionId: context.sessionId,
        workTurnId: context.workTurnId,
        agentRunId: context.agentRunId,
        artifactId: stableArtifactId(context.worldId, context.agentRunId, worldRelativePath),
        idempotencyKey,
      })
      artifactRefs.push(publication.artifact.id)
    }
    return artifactRefs.length === 0 ? noArtifactContribution() : {
      artifactRefs: [...new Set(artifactRefs)],
      messageMetadata: {
        artifactCount: artifactRefs.length,
        completionOutcome: 'artifacts-published',
        artifactDiscovery: manifestRead.found ? 'manifest' : 'run-window',
      },
    }
  }

  /** Safe implementation of the provider-neutral orchestration seam. */
  completionHook(): AgentRunCompletionHook {
    return new ArtifactPublicationHook(this)
  }

  async preview(worldId: string, artifactId: string, versionNumber?: number, selectedPath?: string): Promise<ArtifactPreview> {
    const view = this.get(worldId, artifactId)
    const version = versionNumber === undefined
      ? view.versions.find((candidate) => candidate.version === view.artifact.currentVersion)
      : view.versions.find((candidate) => candidate.version === versionNumber)
    if (version === undefined) throw notFound('artifact_version_not_found', '产物版本不存在')
    const root = await this.#roots.ensure(worldId)
    const path = this.#publishedPath(root, version.relativePath)
    let body: Buffer
    let selectedContentType: string | undefined
    let selectedIsHtml = false
    try {
      await assertSafeFile(root.exportsArtifactsPath, path, WORLD_ARTIFACT_LIMITS.previewBytes)
      if (view.artifact.kind === 'project') {
        if (selectedPath === undefined || selectedPath.trim() === '') {
          const tree = await projectTree(path)
          body = Buffer.from(`${JSON.stringify({ kind: 'project-tree', artifactId, version: version.version, entries: tree })}\n`, 'utf8')
        } else {
          const childRelativePath = normalizeRelativePath(selectedPath, 'project preview path')
          const child = resolve(path, ...childRelativePath.split('/'))
          if (!isPathWithin(path, child)) throw conflict('artifact_path_invalid', '项目预览路径越界')
          await assertSafeFile(path, child, WORLD_ARTIFACT_LIMITS.previewBytes)
          const childInfo = await lstat(child)
          if (!childInfo.isFile()) throw invalid('artifact_preview_file_required', '项目预览路径必须是文件')
          body = await readFile(child)
          selectedContentType = mimeTypeFor(view.artifact.kind, childRelativePath)
          selectedIsHtml = extname(childRelativePath).toLowerCase() === '.html'
        }
      } else {
        body = await readFile(path)
      }
    } catch (error) {
      if (isMissingPath(error)) {
        if (view.artifact.status !== 'missing') this.markMissing(worldId, artifactId)
        throw notFound('artifact_missing', '产物文件已丢失')
      }
      throw error
    }
    const integrity = view.artifact.kind === 'project'
      ? await inspectSource(root.exportsArtifactsPath, path)
      : { byteLength: body.byteLength, sha256: sha256(body) }
    if (integrity.byteLength !== version.byteLength || integrity.sha256 !== version.sha256) {
      if (view.artifact.status !== 'missing') this.markMissing(worldId, artifactId)
      throw conflict('artifact_integrity_failed', '产物完整性校验失败')
    }
    const contentType = selectedContentType
      ?? (view.artifact.kind === 'project' && (selectedPath === undefined || selectedPath.trim() === '')
        ? 'application/json; charset=utf-8'
        : version.mimeType ?? mimeTypeFor(view.artifact.kind, version.relativePath))
    return {
      artifact: view.artifact,
      version,
      body,
      contentType,
      isHtml: selectedIsHtml || view.artifact.kind === 'html' || contentType === 'text/html',
    }
  }

  #publishedPath(root: WorldRoot, relativePath: string): string {
    const normalized = normalizeRelativePath(relativePath, 'published artifact path')
    const path = resolve(root.rootPath, ...normalized.split('/'))
    if (!isPathWithin(root.exportsArtifactsPath, path)) {
      throw conflict('artifact_path_invalid', '产物路径越界')
    }
    return path
  }

  async #publishSource(
    root: WorldRoot,
    sourcePath: string,
    sourceRelativePath: string,
    input: PublishWorkspaceArtifactInput,
    sourceRoot = root.filesPath,
  ): Promise<WorldArtifactPublication> {
    const source = await inspectSource(sourceRoot, sourcePath)
    if (source.kind === 'directory' && input.kind !== 'project') {
      throw invalid('artifact_kind_mismatch', '目录产物必须使用项目类型')
    }
    if (source.kind !== 'directory' && input.kind === 'project') {
      throw invalid('artifact_kind_mismatch', '项目产物必须发布一个目录')
    }
    const entrypoint = input.entrypoint === undefined ? undefined : normalizeRelativePath(input.entrypoint, 'entrypoint')
    if (entrypoint !== undefined) {
      if (source.kind !== 'directory') throw invalid('artifact_entrypoint_invalid', '只有项目产物可以设置入口文件')
      const entrypointPath = resolve(sourcePath, ...entrypoint.split('/'))
      if (!isPathWithin(sourcePath, entrypointPath)) throw conflict('artifact_path_invalid', '项目入口文件越界')
      await assertSafeFile(sourcePath, entrypointPath, WORLD_ARTIFACT_LIMITS.maxFileBytes)
      if (!(await lstat(entrypointPath)).isFile()) throw invalid('artifact_entrypoint_invalid', '项目入口必须是文件')
    }
    const existingByKey = input.idempotencyKey === undefined
      ? undefined
      : this.#repository.getVersionByIdempotencyKey(input.worldId, input.idempotencyKey)
    if (existingByKey !== undefined) {
      const artifact = this.#repository.get(input.worldId, existingByKey.artifactId)
      if (artifact === undefined) throw conflict('artifact_registry_corrupt', '产物注册信息丢失')
      return { artifact, version: existingByKey, created: false }
    }

    const artifactId = input.artifactId ?? randomUUID()
    const current = this.#repository.get(input.worldId, artifactId)
    const versionNumber = current?.currentVersion === undefined ? 1 : current.currentVersion + 1
    const destinationDirectory = join(root.exportsArtifactsPath, artifactId, `v${versionNumber}`)
    const destinationName = basename(sourceRelativePath)
    const destination = join(destinationDirectory, destinationName)
    const relativePath = toPosix(relative(root.rootPath, destination))
    const staging = `${destination}.tmp-${randomUUID()}`
    let moved = false
    try {
      const existingTarget = await existingPath(destination)
      if (existingTarget) {
        const published = await inspectSource(root.exportsArtifactsPath, destination)
        if (published.kind !== source.kind || published.byteLength !== source.byteLength || published.sha256 !== source.sha256) {
          throw conflict('artifact_integrity_failed', '已存在的产物目标与本次内容不一致')
        }
      } else {
        await copySourceAtomically(sourceRoot, sourcePath, staging, source)
        const published = await inspectSource(root.exportsArtifactsPath, staging)
        if (published.byteLength !== source.byteLength || published.sha256 !== source.sha256) {
          throw conflict('artifact_integrity_failed', '产物复制后完整性校验失败')
        }
        await mkdir(destinationDirectory, { recursive: true })
        await assertNoSymlinkSegments(root.exportsArtifactsPath, destinationDirectory)
        await rename(staging, destination)
        moved = true
      }

      // A concurrent caller may have committed this key while the bytes were
      // being staged. Re-read after the move, so we return the committed
      // publication instead of calculating a different vN path.
      const committed = input.idempotencyKey === undefined
        ? undefined
        : this.#repository.getVersionByIdempotencyKey(input.worldId, input.idempotencyKey)
      if (committed !== undefined) {
        const artifact = this.#repository.get(input.worldId, committed.artifactId)
        if (artifact === undefined) throw conflict('artifact_registry_corrupt', '产物注册信息丢失')
        if (moved) await rm(destination, { recursive: true, force: true })
        return { artifact, version: committed, created: false }
      }
      const publication = this.#repository.publish({
        workspaceId: input.workspaceId,
        worldId: input.worldId,
        artifactId,
        title: input.title,
        ...(input.description === undefined ? {} : { description: input.description }),
        kind: input.kind,
        relativePath,
        ...(entrypoint === undefined ? {} : { entrypoint }),
        ...(input.mimeType === undefined ? {} : { mimeType: input.mimeType }),
        byteLength: source.byteLength,
        sha256: source.sha256,
        sourceRelativePath,
        createdByKind: input.createdByKind,
        createdById: input.createdById,
        ...(input.employeeId === undefined ? {} : { employeeId: input.employeeId }),
        ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
        ...(input.workTurnId === undefined ? {} : { workTurnId: input.workTurnId }),
        ...(input.agentRunId === undefined ? {} : { agentRunId: input.agentRunId }),
        ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
        createdAt: this.#clock(),
      })
      if (!publication.created) return publication
      this.#notify(input.worldId, { artifactId: publication.artifact.id, version: publication.version.version, status: publication.artifact.status })
      return publication
    } catch (error) {
      await rm(staging, { force: true }).catch(() => undefined)
      if (moved) await rm(destination, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
  }

  async #resolveImportedPath(root: WorldRoot, sourcePath: string): Promise<{ sourcePath: string; sourceRelativePath: string }> {
    if (sourcePath.trim() === '') throw invalid('source_path_required', '必须提供 sourcePath')
    const normalized = sourcePath.replaceAll('\\', '/')
    const lexical = isAbsoluteLike(normalized)
      ? resolve(normalized)
      : resolve(root.rootPath, ...normalizeRelativePath(normalized, 'source path').split('/'))
    // The caller may name the world root through a symlink the operator
    // configured (a state root below `/var` on macOS). Canonicalise segment by
    // segment so that alias stays usable while a symlink hop below the world
    // root is still refused instead of silently followed.
    let candidate: string
    try {
      candidate = await resolveCanonicalPathWithoutSymlinkHops(lexical, root.rootPath)
    } catch (error) {
      if (error instanceof SymlinkHopError) throw conflict('artifact_symlink_rejected', '导入路径包含符号链接')
      throw error
    }
    await assertSafeFile(root.rootPath, candidate, WORLD_ARTIFACT_LIMITS.maxProjectBytes)
    const sourceRelativePath = toPosix(relative(root.rootPath, candidate))
    if (!sourceRelativePath || sourceRelativePath.startsWith('..')) throw conflict('artifact_path_invalid', '导入路径越界')
    if (sourceRelativePath.split('/')[0]?.toLowerCase() === '.dsh') throw conflict('artifact_path_invalid', '不允许把 .dsh 控制目录作为产物源')
    return { sourcePath: candidate, sourceRelativePath }
  }

  #notify(worldId: string, payload: JsonObject): void {
    this.#onChanged?.(worldId, { type: 'artifact.changed', ...payload })
  }
}

/** The Server's concrete provider-neutral completion hook. */
export class ArtifactPublicationHook implements AgentRunCompletionHook {
  readonly #artifacts: WorldArtifactService

  constructor(artifacts: WorldArtifactService) { this.#artifacts = artifacts }

  onCompleted(context: AgentRunCompletionContext): Promise<AgentRunCompletionContribution> {
    return this.#artifacts.publishAgentRun(context)
  }
}

async function readExactManifest(workspacePath: string, path: string): Promise<{ found: boolean; manifest: WorldArtifactPublishManifest }> {
  let body: Buffer
  try {
    await assertSafeFile(workspacePath, path, WORLD_ARTIFACT_LIMITS.manifestBytes)
    body = await readFile(path)
  } catch (error) {
    if (isMissingPath(error)) return { found: false, manifest: { schemaVersion: 1, artifacts: [] } }
    throw error
  }
  if (body.byteLength > WORLD_ARTIFACT_LIMITS.manifestBytes) throw invalid('artifact_manifest_too_large', '产物 manifest 过大')
  let value: unknown
  try { value = JSON.parse(body.toString('utf8')) } catch { throw invalid('artifact_manifest_invalid', '产物 manifest 不是有效 JSON') }
  const object = record(value)
  if (object === undefined || object.schemaVersion !== 1 || !Array.isArray(object.artifacts) || Object.keys(object).some((key) => key !== 'schemaVersion' && key !== 'artifacts')) {
    throw invalid('artifact_manifest_invalid', '产物 manifest 结构无效')
  }
  if (object.artifacts.length > WORLD_ARTIFACT_LIMITS.maxManifestEntries) throw invalid('artifact_manifest_too_many', '产物数量超过限制')
  const artifacts = object.artifacts.map((entry) => parseManifestEntry(entry))
  const seenPaths = new Set<string>()
  for (const entry of artifacts) {
    const normalized = normalizeRelativePath(entry.path, 'manifest path')
    if (seenPaths.has(normalized)) throw invalid('artifact_manifest_duplicate', '产物 manifest 不得重复发布同一路径')
    seenPaths.add(normalized)
  }
  return { found: true, manifest: { schemaVersion: 1, artifacts } }
}

function noArtifactContribution(): AgentRunCompletionContribution {
  return { messageMetadata: { artifactCount: 0, completionOutcome: 'no-artifact' } }
}

const RUN_ARTIFACT_TIME_TOLERANCE_MS = 2_000

async function discoverRunArtifactEntries(
  workspacePath: string,
  runStartedAt: string | undefined,
  runCompletedAt: string | undefined,
): Promise<WorldArtifactPublishManifestEntry[]> {
  const startedAt = Date.parse(runStartedAt ?? '')
  const completedAt = Date.parse(runCompletedAt ?? '')
  if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt) || completedAt < startedAt) return []
  const files = (await collectProjectFiles(workspacePath, 0)).filter((file) =>
    file.modifiedAtMs >= startedAt - RUN_ARTIFACT_TIME_TOLERANCE_MS &&
    file.modifiedAtMs <= completedAt + RUN_ARTIFACT_TIME_TOLERANCE_MS,
  )
  if (files.length > WORLD_ARTIFACT_LIMITS.maxManifestEntries) {
    throw invalid('artifact_auto_discovery_too_many', `本轮修改了超过 ${WORLD_ARTIFACT_LIMITS.maxManifestEntries} 个文件，请使用产物 manifest 明确发布范围`)
  }
  return files.map((file) => ({
    path: file.relativePath,
    title: basename(file.relativePath),
    kind: artifactKindFromPath(file.relativePath),
  }))
}

function artifactKindFromPath(path: string): WorldArtifactKind {
  const extension = extname(path).toLocaleLowerCase('en-US')
  if (extension === '.html' || extension === '.htm') return 'html'
  if (extension === '.md' || extension === '.markdown') return 'markdown'
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'].includes(extension)) return 'image'
  if (['.pdf', '.doc', '.docx', '.odt', '.rtf'].includes(extension)) return 'document'
  if (['.json', '.csv', '.tsv', '.xlsx', '.xls'].includes(extension)) return 'data'
  if (['.zip', '.tar', '.gz', '.7z'].includes(extension)) return 'archive'
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java', '.kt', '.swift', '.css', '.scss', '.sql', '.sh', '.ps1'].includes(extension)) return 'code'
  return 'other'
}

function parseManifestEntry(value: unknown): WorldArtifactPublishManifestEntry {
  const object = record(value)
  if (object === undefined || Object.keys(object).some((key) => !['path', 'title', 'kind', 'entrypoint', 'description'].includes(key))) {
    throw invalid('artifact_manifest_entry_invalid', '产物 manifest 条目包含未知字段')
  }
  const path = requiredString(object.path, 'manifest path')
  const title = requiredString(object.title, 'manifest title')
  const kind = object.kind
  if (!isArtifactKind(kind)) throw invalid('artifact_manifest_kind_invalid', '产物类型无效')
  normalizeRelativePath(path, 'manifest path')
  if (object.entrypoint !== undefined) normalizeRelativePath(requiredString(object.entrypoint, 'manifest entrypoint'), 'manifest entrypoint')
  if (object.description !== undefined && typeof object.description !== 'string') throw invalid('artifact_manifest_description_invalid', '产物说明无效')
  return {
    path,
    title,
    kind,
    ...(object.entrypoint === undefined ? {} : { entrypoint: requiredString(object.entrypoint, 'manifest entrypoint') }),
    ...(object.description === undefined ? {} : { description: object.description as string }),
  }
}

interface SourceInspection {
  kind: 'file' | 'directory'
  byteLength: number
  sha256: string
}

async function inspectSource(root: string, sourcePath: string): Promise<SourceInspection> {
  await assertNoSymlinkSegments(root, sourcePath)
  let info
  try { info = await lstat(sourcePath) } catch (error) { throw isMissingPath(error) ? notFound('artifact_source_not_found', '源文件不存在') : error }
  if (info.isSymbolicLink()) throw conflict('artifact_symlink_rejected', '不允许发布符号链接')
  if (info.isFile()) {
    if (info.size > WORLD_ARTIFACT_LIMITS.maxFileBytes) throw invalid('artifact_size_rejected', '产物文件超过大小限制')
    const body = await readFile(sourcePath)
    return { kind: 'file', byteLength: body.byteLength, sha256: sha256(body) }
  }
  if (!info.isDirectory()) throw invalid('artifact_source_invalid', '源路径必须是文件或目录')
  const files = await collectProjectFiles(sourcePath, 0)
  const hash = createHash('sha256')
  let total = 0
  for (const file of files) {
    const body = await readFile(file.absolutePath)
    total += body.byteLength
    hash.update(file.relativePath)
    hash.update('\0')
    hash.update(body)
  }
  if (total > WORLD_ARTIFACT_LIMITS.maxProjectBytes) throw invalid('artifact_project_size_rejected', '项目总大小超过限制')
  return { kind: 'directory', byteLength: total, sha256: hash.digest('hex') }
}

async function resolveAgentWorkspace(root: WorldRoot, workspacePath: string): Promise<string | undefined> {
  // The runtime hands back the workspace path it was launched with, which may
  // still carry the operator's own symlink (a state root below `/var`). A
  // lexical path can never be compared against the canonical world root, so
  // canonicalise it here; the walk keeps refusing a symlink hop below `files`.
  let candidate: string
  try {
    candidate = await resolveCanonicalPathWithoutSymlinkHops(workspacePath, root.filesPath)
  } catch (error) {
    if (error instanceof SymlinkHopError) throw conflict('artifact_workspace_invalid', 'AgentRun 工作区真实路径越界')
    if (isMissingPath(error)) throw notFound('artifact_workspace_missing', 'AgentRun 工作区不存在')
    throw error
  }
  const restricted = await realpath(root.restrictedFilesPath)
  if (candidate.toLowerCase() === restricted.toLowerCase()) return undefined
  if (!isPathWithin(root.filesPath, candidate)) throw conflict('artifact_workspace_invalid', 'AgentRun 工作区不属于当前世界 files')
  let info
  try {
    info = await lstat(candidate)
  } catch (error) {
    if (isMissingPath(error)) throw notFound('artifact_workspace_missing', 'AgentRun 工作区不存在')
    throw error
  }
  if (info.isSymbolicLink() || !info.isDirectory()) throw conflict('artifact_workspace_invalid', 'AgentRun 工作区必须是实际目录')
  const relativePath = toPosix(relative(root.filesPath, candidate))
  if (relativePath.split('/')[0]?.toLowerCase() === '.dsh') throw conflict('artifact_workspace_invalid', 'AgentRun 工作区不能位于 .dsh 控制目录')
  await assertNoSymlinkSegments(root.filesPath, candidate)
  return candidate
}

async function existingPath(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (isMissingPath(error)) return false
    throw error
  }
}

async function projectTree(directory: string): Promise<Array<{ path: string; kind: 'file'; byteLength: number }>> {
  const files = await collectProjectFiles(directory, 0)
  return files.map((file) => ({ path: file.relativePath, kind: 'file' as const, byteLength: file.byteLength }))
}

async function copySourceAtomically(root: string, sourcePath: string, destination: string, source: SourceInspection): Promise<void> {
  await mkdir(dirname(destination), { recursive: true })
  await assertNoSymlinkSegments(root, sourcePath)
  if (source.kind === 'file') {
    const handle = await open(destination, 'wx', 0o600)
    try {
      await handle.close()
      await copyFile(sourcePath, destination)
    } catch (error) {
      await handle.close().catch(() => undefined)
      throw error
    }
    return
  }
  // Project publication is copied into a temporary directory; the caller
  // renames the final file for regular artifacts. Projects are intentionally
  // bounded by collectProjectFiles and preserve deterministic relative paths.
  await rm(destination, { recursive: true, force: true })
  await mkdir(destination, { recursive: true })
  const files = await collectProjectFiles(sourcePath, 0)
  for (const file of files) {
    const target = join(destination, file.relativePath)
    await mkdir(dirname(target), { recursive: true })
    await copyFile(file.absolutePath, target)
  }
}

interface ProjectFile { absolutePath: string; relativePath: string; depth: number; byteLength: number; modifiedAtMs: number }

async function collectProjectFiles(directory: string, depth: number): Promise<ProjectFile[]> {
  if (depth > WORLD_ARTIFACT_LIMITS.maxProjectDepth) throw invalid('artifact_depth_rejected', '项目目录层级超过限制')
  await assertNoSymlinkSegments(directory, directory)
  const entries = await readdir(directory, { withFileTypes: true })
  const files: ProjectFile[] = []
  for (const entry of entries) {
    if (['.git', 'node_modules', 'cache', '.dsh'].includes(entry.name.toLowerCase())) continue
    const absolutePath = join(directory, entry.name)
    if (entry.isSymbolicLink()) throw conflict('artifact_symlink_rejected', '项目中不允许符号链接')
    if (entry.isDirectory()) {
      const nested = await collectProjectFiles(absolutePath, depth + 1)
      for (const file of nested) files.push({ ...file, relativePath: `${entry.name}/${file.relativePath}`, depth: file.depth + 1 })
    } else if (entry.isFile()) {
      const info = await lstat(absolutePath)
      if (info.size > WORLD_ARTIFACT_LIMITS.maxFileBytes) throw invalid('artifact_size_rejected', '项目文件超过大小限制')
      files.push({ absolutePath, relativePath: entry.name, depth, byteLength: info.size, modifiedAtMs: info.mtimeMs })
    }
    if (files.length > WORLD_ARTIFACT_LIMITS.maxProjectFiles) throw invalid('artifact_file_count_rejected', '项目文件数量超过限制')
  }
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath))
}

async function assertSafeFile(root: string, candidate: string, maxBytes: number): Promise<void> {
  if (!isPathWithin(root, candidate)) throw conflict('artifact_path_invalid', '产物路径越界')
  await assertNoSymlinkSegments(root, candidate)
  const info = await lstat(candidate)
  if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) throw conflict('artifact_path_invalid', '产物路径不是安全文件')
  const resolved = await realpath(candidate)
  if (!isPathWithin(root, resolved)) throw conflict('artifact_path_invalid', '产物真实路径越界')
  if (info.isFile() && info.size > maxBytes) throw invalid('artifact_size_rejected', '产物超过大小限制')
}

async function assertNoSymlinkSegments(root: string, candidate: string): Promise<void> {
  if (!isPathWithin(root, candidate)) throw conflict('artifact_path_invalid', '产物路径越界')
  const rootResolved = resolve(root)
  const relativePath = relative(rootResolved, resolve(candidate))
  if (relativePath.startsWith('..') || relativePath === '') return
  let current = rootResolved
  for (const segment of relativePath.split(sep)) {
    current = join(current, segment)
    let info
    try { info = await lstat(current) } catch (error) { if (isMissingPath(error)) continue; throw error }
    if (info.isSymbolicLink()) throw conflict('artifact_symlink_rejected', '产物路径包含符号链接')
  }
}

function normalizeRelativePath(value: string, label: string): string {
  const normalized = value.trim().replaceAll('\\', '/')
  if (!normalized || normalized.includes('\0') || normalized.startsWith('/') || normalized.startsWith('//') || /^[A-Za-z]:\//.test(normalized)) {
    throw invalid('artifact_path_invalid', `${label} 不是安全相对路径`)
  }
  const segments = normalized.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) throw invalid('artifact_path_invalid', `${label} 包含越界片段`)
  if (segments[0]?.toLowerCase() === '.dsh') throw invalid('artifact_path_invalid', `${label} 不允许指向 .dsh 控制目录`)
  return segments.join('/')
}

function toPosix(value: string): string { return value.replaceAll('\\', '/') }
function isAbsoluteLike(value: string): boolean { return value.startsWith('/') || value.startsWith('//') || /^[A-Za-z]:\//.test(value) }
function isArtifactKind(value: unknown): value is WorldArtifactKind { return typeof value === 'string' && ['image', 'html', 'markdown', 'document', 'code', 'data', 'archive', 'project', 'other'].includes(value) }
function requiredString(value: unknown, label: string): string { if (typeof value !== 'string' || !value.trim()) throw invalid('artifact_manifest_invalid', `${label} 不能为空`); return value.trim() }
function record(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined }
function sha256(value: Buffer): string { return createHash('sha256').update(value).digest('hex') }
function stableArtifactId(worldId: string, agentRunId: string, sourceRelativePath: string): string {
  const digest = createHash('sha256').update(`${worldId}\0${agentRunId}\0${sourceRelativePath}`).digest('hex')
  // UUID-shaped ids keep the public contract familiar while remaining stable
  // across process restarts and safe as directory names.
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`
}
function mimeTypeFor(kind: WorldArtifactKind, path: string): string {
  if (kind === 'html' || extname(path).toLowerCase() === '.html') return 'text/html; charset=utf-8'
  if (kind === 'markdown' || extname(path).toLowerCase() === '.md') return 'text/markdown; charset=utf-8'
  if (kind === 'image') {
    const extension = extname(path).toLowerCase()
    return extension === '.png' ? 'image/png' : extension === '.webp' ? 'image/webp' : 'image/jpeg'
  }
  if (kind === 'data' || extname(path).toLowerCase() === '.json') return 'application/json; charset=utf-8'
  return 'application/octet-stream'
}
function isMissingPath(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === 'ENOENT' }
function notFound(code: string, message: string): ServiceError { return new ServiceError('not-found', code, message) }
function invalid(code: string, message: string): ServiceError { return new ServiceError('invalid', code, message) }
function conflict(code: string, message: string): ServiceError { return new ServiceError('conflict', code, message) }

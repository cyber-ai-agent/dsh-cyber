import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat } from 'node:fs/promises'
import { dirname, extname, join, parse as parsePath, relative, resolve, sep } from 'node:path'
import { inflateRawSync } from 'node:zlib'

import type {
  JsonObject,
  KnowledgeChunk,
  KnowledgeDocument,
  KnowledgeDocumentOrigin,
  KnowledgeDocumentStatus,
  KnowledgeCollection,
  KnowledgeCollectionOrigin,
} from '@dsh-cyber/contracts'
import type { WorldKnowledgeRepository } from '@dsh-cyber/persistence'

import { ServiceError } from './service-error.js'
import { KNOWLEDGE_DOCUMENT_LIMITS, KnowledgeParseError, parseKnowledgeDocument, type ParsedKnowledgeDocument } from './knowledge-document-parser.js'
import type { KnowledgeSearchPort, KnowledgeSearchResult } from './knowledge-search-port.js'
import { isPathWithin, type WorldRoot, type WorldRootService } from './world-root-service.js'

export const WORLD_KNOWLEDGE_LIMITS = {
  maxFileBytes: KNOWLEDGE_DOCUMENT_LIMITS.maxSourceBytes,
  maxPackBytes: 200 * 1024 * 1024,
  maxFiles: 500,
  maxDepth: 16,
  maxZipEntries: 500,
  maxZipExpandedBytes: 200 * 1024 * 1024,
  maxZipEntryBytes: 50 * 1024 * 1024,
  maxZipRatio: 1_000,
  maxTextBytes: 4 * 1024 * 1024,
} as const

export type KnowledgeOrigin = KnowledgeDocumentOrigin
export type { KnowledgeChunk, KnowledgeCollection, KnowledgeDocument, KnowledgeDocumentOrigin, KnowledgeDocumentStatus, KnowledgeCollectionOrigin } from '@dsh-cyber/contracts'
export type KnowledgeRepositoryPort = Pick<WorldKnowledgeRepository, 'listCollections' | 'getCollection' | 'upsertCollection' | 'listDocuments' | 'getDocument' | 'upsertDocument' | 'replaceChunks' | 'deleteDocument' | 'deleteCollection' | 'markMissing'>

export interface WorldKnowledgeLibraryServiceOptions {
  repository: KnowledgeRepositoryPort
  roots: WorldRootService
  search?: KnowledgeSearchPort
  /** The SQLite/contract authority is injected here; root creation alone is not a World existence check. */
  getWorld?: (worldId: string) => { id: string; workspaceId: string } | undefined | Promise<{ id: string; workspaceId: string } | undefined>
  clock?: () => string
  idFactory?: () => string
  onChanged?: (worldId: string, payload: JsonObject) => void
  readArtifact?: (worldId: string, artifactId: string) => Promise<{ fileName: string; mimeType?: string; body: Buffer; title?: string }>
}

export interface ImportKnowledgeFileInput {
  workspaceId: string
  worldId: string
  bytes: Buffer
  fileName: string
  mimeType?: string
  relativePath?: string
  title?: string
  origin?: KnowledgeOrigin
  collectionId?: string
  collectionName?: string
  collectionOrigin?: KnowledgeCollection['origin']
  sourceUrl?: string
  artifactId?: string
}

export interface ImportKnowledgeTextInput extends Omit<ImportKnowledgeFileInput, 'bytes' | 'fileName' | 'origin'> {
  title: string
  text: string
}

export interface KnowledgeImportReport {
  collection?: KnowledgeCollection
  documents: KnowledgeDocument[]
  skipped: string[]
  totalBytes: number
}

export class WorldKnowledgeLibraryService {
  readonly #repository: KnowledgeRepositoryPort
  readonly #roots: WorldRootService
  readonly #search?: KnowledgeSearchPort
  readonly #getWorld?: WorldKnowledgeLibraryServiceOptions['getWorld']
  readonly #clock: () => string
  readonly #idFactory: () => string
  readonly #onChanged?: WorldKnowledgeLibraryServiceOptions['onChanged']
  readonly #readArtifact?: WorldKnowledgeLibraryServiceOptions['readArtifact']

  constructor(options: WorldKnowledgeLibraryServiceOptions) {
    this.#repository = options.repository
    this.#roots = options.roots
    if (options.search !== undefined) this.#search = options.search
    this.#getWorld = options.getWorld
    this.#clock = options.clock ?? (() => new Date().toISOString())
    this.#idFactory = options.idFactory ?? randomUUID
    this.#onChanged = options.onChanged
    this.#readArtifact = options.readArtifact
  }

  listCollections(worldId: string): KnowledgeCollection[] {
    return this.#repository.listCollections(worldId)
  }

  listDocuments(worldId: string, filter: { collectionId?: string; status?: KnowledgeDocumentStatus; query?: string } = {}): KnowledgeDocument[] {
    return this.#repository.listDocuments(worldId, filter)
  }

  async importFile(input: ImportKnowledgeFileInput): Promise<KnowledgeDocument> {
    const world = await this.#world(input.worldId, input.workspaceId)
    const parsed = await this.#parse(input.bytes, input.fileName, input.mimeType, input.title)
    const relativePath = normalizeLibraryPath(input.relativePath ?? input.fileName)
    const libraryPath = await this.#safeLibraryPath(input.worldId, relativePath)
    const collection = input.collectionName === undefined
      ? input.collectionId === undefined ? undefined : this.#repository.getCollection?.(input.worldId, input.collectionId)
      : this.#repository.upsertCollection({
          ...(input.collectionId === undefined ? {} : { id: input.collectionId }),
          worldId: input.worldId,
          name: cleanName(input.collectionName, '知识库'),
          ...(input.collectionOrigin === undefined ? { origin: 'manual' as const } : { origin: input.collectionOrigin }),
          relativeRoot: collectionRoot(relativePath),
        })
    if (input.collectionId !== undefined && collection === undefined) throw notFound('knowledge_collection_not_found', '知识集合不存在')
    await writeAtomically(libraryPath, input.bytes)
    const now = this.#clock()
    const document = this.#repository.upsertDocument({
      workspaceId: world.workspaceId,
      worldId: input.worldId,
      ...(collection === undefined ? {} : { collectionId: collection.id }),
      relativePath,
      title: parsed.title,
      mimeType: parsed.mimeType,
      byteLength: input.bytes.byteLength,
      sha256: sha256(input.bytes),
      origin: input.origin ?? 'upload',
      ...(input.sourceUrl === undefined ? {} : { sourceUrl: normalizeSourceUrl(input.sourceUrl) }),
      ...(input.artifactId === undefined ? {} : { artifactId: input.artifactId }),
      status: 'pending',
      chunkCount: 0,
    })
    try {
      this.#repository.replaceChunks({ worldId: input.worldId, documentId: document.id, chunks: parsed.chunks.map((chunk) => toChunk(this.#idFactory(), input.worldId, document.id, chunk, now)) })
      const indexed = this.#repository.upsertDocument({
        ...document,
        status: 'indexed',
        chunkCount: parsed.chunks.length,
        indexedAt: now,
      })
      this.#changed(input.worldId, { type: 'knowledge.document.changed', documentId: indexed.id, status: indexed.status })
      return indexed
    } catch (error) {
      this.#repository.upsertDocument({ ...document, status: 'failed', chunkCount: 0 })
      throw error
    }
  }

  async createFromText(input: ImportKnowledgeTextInput): Promise<KnowledgeDocument> {
    const title = cleanName(input.title, '未命名知识')
    const relativePath = input.relativePath ?? `notes/${safeFileName(title)}.md`
    return this.importFile({ ...input, fileName: `${safeFileName(title)}.md`, relativePath, bytes: Buffer.from(input.text, 'utf8'), origin: 'paste', mimeType: 'text/markdown', title })
  }

  async importDirectory(input: { workspaceId: string; worldId: string; sourcePath: string; collectionName?: string }): Promise<KnowledgeImportReport> {
    await this.#world(input.worldId, input.workspaceId)
    const sourceRoot = await safeExternalDirectory(input.sourcePath)
    const entries = await collectFiles(sourceRoot, 0)
    if (entries.length > WORLD_KNOWLEDGE_LIMITS.maxFiles) throw tooLarge('knowledge_file_count_rejected', '知识包文件数量超过限制')
    const collectionName = input.collectionName ?? sourceRoot.split(/[\\/]/).pop() ?? '文件夹知识包'
    const collection = this.#repository.upsertCollection({ worldId: input.worldId, name: cleanName(collectionName, '文件夹知识包'), origin: 'folder', relativeRoot: `collections/${safeFileName(collectionName)}` })
    const documents: KnowledgeDocument[] = []
    const skipped: string[] = []
    let totalBytes = 0
    for (const entry of entries) {
      totalBytes += entry.byteLength
      if (totalBytes > WORLD_KNOWLEDGE_LIMITS.maxPackBytes) throw tooLarge('knowledge_pack_size_rejected', '知识包总大小超过限制')
      if (!isSupportedFile(entry.relativePath)) { skipped.push(entry.relativePath); continue }
      try {
        documents.push(await this.importFile({ workspaceId: input.workspaceId, worldId: input.worldId, bytes: await readFile(entry.absolutePath), fileName: entry.relativePath, relativePath: `collections/${safeFileName(collectionName)}/${entry.relativePath}`, origin: 'filesystem', collectionId: collection.id }))
      } catch (error) {
        if (error instanceof KnowledgeParseError && error.code === 'unsupported_format') { skipped.push(entry.relativePath); continue }
        throw error
      }
    }
    return { collection, documents, skipped, totalBytes }
  }

  async importZip(input: { workspaceId: string; worldId: string; bytes: Buffer; collectionName?: string }): Promise<KnowledgeImportReport> {
    await this.#world(input.worldId, input.workspaceId)
    if (input.bytes.byteLength > WORLD_KNOWLEDGE_LIMITS.maxPackBytes) throw tooLarge('knowledge_pack_size_rejected', '知识包总大小超过限制')
    const entries = unpackKnowledgeZip(input.bytes)
    const collectionName = input.collectionName ?? 'ZIP 知识包'
    const collection = this.#repository.upsertCollection({ worldId: input.worldId, name: cleanName(collectionName, 'ZIP 知识包'), origin: 'zip', relativeRoot: `collections/${safeFileName(collectionName)}` })
    const documents: KnowledgeDocument[] = []
    const skipped: string[] = []
    let totalBytes = 0
    for (const entry of entries) {
      totalBytes += entry.bytes.byteLength
      if (totalBytes > WORLD_KNOWLEDGE_LIMITS.maxPackBytes) throw tooLarge('knowledge_zip_expanded_size_rejected', 'ZIP 解压后的总大小超过限制')
      if (!isSupportedFile(entry.name)) { skipped.push(entry.name); continue }
      documents.push(await this.importFile({ workspaceId: input.workspaceId, worldId: input.worldId, bytes: entry.bytes, fileName: entry.name, relativePath: `collections/${safeFileName(collectionName)}/${entry.name}`, origin: 'filesystem', collectionId: collection.id }))
    }
    return { collection, documents, skipped, totalBytes }
  }

  async importArtifact(input: { workspaceId: string; worldId: string; artifactId: string; collectionId?: string }): Promise<KnowledgeDocument> {
    if (this.#readArtifact === undefined) throw unavailable('knowledge_artifact_bridge_unavailable', '当前服务没有配置产物读取桥接')
    const artifact = await this.#readArtifact(input.worldId, input.artifactId)
    return this.importFile({
      workspaceId: input.workspaceId,
      worldId: input.worldId,
      bytes: artifact.body,
      fileName: artifact.fileName,
      ...(artifact.mimeType === undefined ? {} : { mimeType: artifact.mimeType }),
      ...(artifact.title === undefined ? {} : { title: artifact.title }),
      origin: 'artifact',
      artifactId: input.artifactId,
      relativePath: `artifacts/${safeFileName(input.artifactId)}/${normalizeLibraryPath(artifact.fileName)}`,
      ...(input.collectionId === undefined ? {} : { collectionId: input.collectionId }),
    })
  }

  async scan(worldId: string, workspaceId?: string): Promise<KnowledgeImportReport> {
    const world = await this.#world(worldId, workspaceId)
    const libraryPath = await this.#libraryPath(worldId)
    const existing = new Map(this.#repository.listDocuments(worldId).map((document) => [document.relativePath, document]))
    const entries = await collectFiles(libraryPath, 0)
    const documents: KnowledgeDocument[] = []
    const skipped: string[] = []
    let totalBytes = 0
    const seen = new Set<string>()
    for (const entry of entries) {
      const relativePath = toPosix(relative(libraryPath, entry.absolutePath))
      seen.add(relativePath)
      totalBytes += entry.byteLength
      if (!isSupportedFile(relativePath)) { skipped.push(relativePath); continue }
      const bytes = await readFile(entry.absolutePath)
      const digest = sha256(bytes)
      const previous = existing.get(relativePath)
      if (previous !== undefined && previous.sha256 === digest && previous.byteLength === bytes.byteLength && previous.status === 'indexed') {
        documents.push(previous)
        continue
      }
      documents.push(await this.importFile({ workspaceId: world.workspaceId, worldId, bytes, fileName: relativePath, relativePath, origin: 'filesystem', ...(previous?.collectionId === undefined ? {} : { collectionId: previous.collectionId }) }))
    }
    for (const document of existing.values()) {
      if (!seen.has(document.relativePath)) this.#repository.markMissing?.(worldId, document.id)
    }
    this.#changed(worldId, { type: 'knowledge.scan.completed', documentCount: documents.length })
    return { documents, skipped, totalBytes }
  }

  async reindex(worldId: string, documentId: string): Promise<KnowledgeDocument> {
    const document = this.#repository.getDocument(worldId, documentId)
    if (document === undefined) throw notFound('knowledge_document_not_found', '知识文档不存在')
    const libraryPath = await this.#safeLibraryPath(worldId, document.relativePath)
    let bytes: Buffer
    try { bytes = await readFile(libraryPath) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { this.#repository.markMissing?.(worldId, documentId); throw notFound('knowledge_document_missing', '知识文档源文件不存在') }; throw error }
    return this.importFile({ workspaceId: document.workspaceId, worldId, bytes, fileName: document.relativePath, relativePath: document.relativePath, origin: document.origin, ...(document.collectionId === undefined ? {} : { collectionId: document.collectionId }), ...(document.sourceUrl === undefined ? {} : { sourceUrl: document.sourceUrl }), ...(document.artifactId === undefined ? {} : { artifactId: document.artifactId }) })
  }

  async removeDocument(worldId: string, documentId: string): Promise<boolean> {
    const document = this.#repository.getDocument(worldId, documentId)
    if (document === undefined) return false
    await rm(await this.#safeLibraryPath(worldId, document.relativePath), { force: true })
    const removed = this.#repository.deleteDocument(worldId, documentId)
    if (removed) this.#changed(worldId, { type: 'knowledge.document.changed', documentId, status: 'removed' })
    return removed
  }

  async removeCollection(worldId: string, collectionId: string): Promise<boolean> {
    const collection = this.#repository.getCollection?.(worldId, collectionId)
    const documents = this.#repository.listDocuments(worldId, { collectionId })
    for (const document of documents) await rm(await this.#safeLibraryPath(worldId, document.relativePath), { force: true })
    const removed = this.#repository.deleteCollection(worldId, collectionId)
    if (removed) this.#changed(worldId, { type: 'knowledge.collection.changed', collectionId, status: 'removed', ...(collection === undefined ? {} : { name: collection.name }) })
    return removed
  }

  async search(worldId: string, query: string, limit = 6): Promise<KnowledgeSearchResult[]> {
    if (this.#search === undefined) return []
    return this.#search.search({ worldId, query, limit, maxChars: 6_000 })
  }

  async #parse(bytes: Buffer, fileName: string, mimeType?: string, title?: string): Promise<ParsedKnowledgeDocument> {
    try { return await parseKnowledgeDocument({ bytes, fileName, ...(mimeType === undefined ? {} : { mimeType }), ...(title === undefined ? {} : { title }) }) }
    catch (error) {
      if (error instanceof KnowledgeParseError) throw invalid(`knowledge_${error.code}`, error.message)
      throw error
    }
  }

  async #world(worldId: string, workspaceId?: string): Promise<{ id: string; workspaceId: string }> {
    if (!worldId.trim()) throw notFound('world_not_found', 'World not found')
    const world = await this.#getWorld?.(worldId)
    if (world === undefined && this.#getWorld !== undefined) throw notFound('world_not_found', 'World not found')
    if (world === undefined) return { id: worldId, workspaceId: workspaceId ?? '' }
    if (workspaceId !== undefined && world.workspaceId !== workspaceId) throw forbidden('knowledge_world_scope_mismatch', '知识来源不属于当前 World')
    return world
  }

  async #libraryPath(worldId: string): Promise<string> {
    const root = await this.#roots.ensure(worldId) as WorldRoot & { knowledgePath?: string; knowledgeLibraryPath?: string }
    const knowledgePath = root.knowledgePath ?? join(root.rootPath, 'knowledge')
    const libraryPath = root.knowledgeLibraryPath ?? join(knowledgePath, 'library')
    await mkdir(libraryPath, { recursive: true })
    await assertNoSymlinkSegments(root.rootPath, libraryPath)
    const resolved = await realpath(libraryPath)
    if (!isPathWithin(root.rootPath, resolved)) throw conflict('knowledge_path_invalid', '知识库路径越界')
    return resolved
  }

  async #safeLibraryPath(worldId: string, relativePath: string): Promise<string> {
    const library = await this.#libraryPath(worldId)
    const candidate = resolve(library, ...normalizeLibraryPath(relativePath).split('/'))
    if (!isPathWithin(library, candidate)) throw conflict('knowledge_path_invalid', '知识库路径越界')
    await mkdir(dirname(candidate), { recursive: true })
    await assertNoSymlinkSegments(library, dirname(candidate))
    return candidate
  }

  #changed(worldId: string, payload: JsonObject): void { this.#onChanged?.(worldId, payload) }
}

export interface KnowledgeZipEntry { name: string; bytes: Buffer }

export function unpackKnowledgeZip(bytes: Buffer): KnowledgeZipEntry[] {
  if (bytes.byteLength < 22) throw invalid('knowledge_zip_invalid', 'ZIP 归档过短')
  const eocd = findSignature(bytes, 0x06054b50, Math.max(0, bytes.length - 65_557))
  if (eocd < 0) throw invalid('knowledge_zip_invalid', 'ZIP 归档缺少结束记录')
  const diskNumber = bytes.readUInt16LE(eocd + 4)
  const centralDisk = bytes.readUInt16LE(eocd + 6)
  const entriesOnDisk = bytes.readUInt16LE(eocd + 8)
  const count = bytes.readUInt16LE(eocd + 10)
  const centralSize = bytes.readUInt32LE(eocd + 12)
  const centralOffset = bytes.readUInt32LE(eocd + 16)
  // ZIP64 uses sentinel values in the classic EOCD. The importer is
  // intentionally classic-ZIP only; rejecting it explicitly avoids treating
  // a 64-bit offset/size as a truncated 32-bit value.
  if (diskNumber === 0xffff || centralDisk === 0xffff || entriesOnDisk === 0xffff || count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw unsupported('knowledge_zip64_unsupported', '暂不支持 ZIP64 归档')
  }
  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== count) throw invalid('knowledge_zip_invalid', 'ZIP 多磁盘归档无效')
  const commentLength = bytes.readUInt16LE(eocd + 20)
  if (eocd + 22 + commentLength !== bytes.length) throw invalid('knowledge_zip_invalid', 'ZIP 结束记录无效')
  if (count > WORLD_KNOWLEDGE_LIMITS.maxZipEntries || centralOffset + centralSize > eocd) throw tooLarge('knowledge_zip_entry_limit', 'ZIP 条目数量或目录大小超过限制')
  const entries: KnowledgeZipEntry[] = []
  const names = new Set<string>()
  let cursor = centralOffset
  let expanded = 0
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > eocd || bytes.readUInt32LE(cursor) !== 0x02014b50) throw invalid('knowledge_zip_invalid', 'ZIP 中央目录无效')
    const flags = bytes.readUInt16LE(cursor + 8)
    const method = bytes.readUInt16LE(cursor + 10)
    const expectedCrc = bytes.readUInt32LE(cursor + 16)
    const compressedSize = bytes.readUInt32LE(cursor + 20)
    const uncompressedSize = bytes.readUInt32LE(cursor + 24)
    const nameLength = bytes.readUInt16LE(cursor + 28)
    const extraLength = bytes.readUInt16LE(cursor + 30)
    const commentLength = bytes.readUInt16LE(cursor + 32)
    const externalAttributes = bytes.readUInt32LE(cursor + 38)
    const localOffset = bytes.readUInt32LE(cursor + 42)
    const rawName = bytes.subarray(cursor + 46, cursor + 46 + nameLength)
    const name = rawName.toString('utf8')
    if (name.includes('\uFFFD')) throw invalid('knowledge_zip_invalid', 'ZIP 文件名不是有效 UTF-8')
    if (cursor + 46 + nameLength + extraLength + commentLength > eocd) throw invalid('knowledge_zip_invalid', 'ZIP 中央目录越界')
    cursor += 46 + nameLength + extraLength + commentLength
    if ((flags & 1) !== 0) throw unsupported('knowledge_zip_encrypted', '不支持加密 ZIP')
    if (name.endsWith('/') || ((externalAttributes >>> 16) & 0xf000) === 0xa000) continue
    const safeName = normalizeLibraryPath(name)
    const nameKey = safeName.normalize('NFKC').toLowerCase()
    if (names.has(nameKey)) throw invalid('knowledge_zip_duplicate_entry', 'ZIP 不得包含重复目标路径')
    names.add(nameKey)
    if (uncompressedSize === 0xffffffff || compressedSize === 0xffffffff || localOffset === 0xffffffff) throw unsupported('knowledge_zip64_unsupported', '暂不支持 ZIP64 条目')
    if (uncompressedSize > WORLD_KNOWLEDGE_LIMITS.maxZipEntryBytes || compressedSize > WORLD_KNOWLEDGE_LIMITS.maxZipEntryBytes) throw tooLarge('knowledge_zip_entry_size_rejected', 'ZIP 条目大小超过限制')
    if (compressedSize === 0 || uncompressedSize / Math.max(1, compressedSize) > WORLD_KNOWLEDGE_LIMITS.maxZipRatio) throw tooLarge('knowledge_zip_bomb_rejected', 'ZIP 压缩比超过限制')
    if (localOffset >= centralOffset || localOffset + 30 > centralOffset || bytes.readUInt32LE(localOffset) !== 0x04034b50) throw invalid('knowledge_zip_invalid', 'ZIP 本地文件头无效')
    const localFlags = bytes.readUInt16LE(localOffset + 6)
    const localMethod = bytes.readUInt16LE(localOffset + 8)
    const localNameLength = bytes.readUInt16LE(localOffset + 26)
    const localExtraLength = bytes.readUInt16LE(localOffset + 28)
    const localNameStart = localOffset + 30
    if (localMethod !== method || (localFlags & 1) !== 0 || localNameStart + localNameLength + localExtraLength > centralOffset || !bytes.subarray(localNameStart, localNameStart + localNameLength).equals(rawName)) {
      throw invalid('knowledge_zip_invalid', 'ZIP 本地文件头与中央目录不一致')
    }
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const dataEnd = dataStart + compressedSize
    if (dataEnd > centralOffset) throw invalid('knowledge_zip_invalid', 'ZIP 条目数据越界')
    const compressed = bytes.subarray(dataStart, dataEnd)
    let body: Buffer
    if (method === 0) body = Buffer.from(compressed)
    else if (method === 8) {
      try { body = Buffer.from(inflateRawSync(compressed)) } catch { throw invalid('knowledge_zip_invalid', 'ZIP 条目无法解压') }
    } else throw unsupported('knowledge_zip_method_unsupported', 'ZIP 仅支持 Store 和 Deflate')
    if (body.byteLength !== uncompressedSize) throw invalid('knowledge_zip_integrity_failed', 'ZIP 条目大小校验失败')
    if (crc32(body) !== expectedCrc) throw invalid('knowledge_zip_integrity_failed', 'ZIP 条目校验和不匹配')
    expanded += body.byteLength
    if (expanded > WORLD_KNOWLEDGE_LIMITS.maxZipExpandedBytes) throw tooLarge('knowledge_zip_expanded_size_rejected', 'ZIP 解压总大小超过限制')
    entries.push({ name: safeName, bytes: body })
  }
  if (cursor !== eocd) throw invalid('knowledge_zip_invalid', 'ZIP 中央目录长度不一致')
  return entries
}

function findSignature(bytes: Buffer, signature: number, start: number): number {
  if (bytes.length < 22) return -1
  for (let index = bytes.length - 22; index >= start; index -= 1) if (bytes.readUInt32LE(index) === signature) return index
  return -1
}

const CRC32_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1
  return value >>> 0
})

function crc32(value: Buffer): number {
  let checksum = 0xffffffff
  for (const byte of value) checksum = CRC32_TABLE[(checksum ^ byte) & 0xff]! ^ (checksum >>> 8)
  return (checksum ^ 0xffffffff) >>> 0
}

async function collectFiles(directory: string, depth: number): Promise<Array<{ absolutePath: string; relativePath: string; byteLength: number }>> {
  if (depth > WORLD_KNOWLEDGE_LIMITS.maxDepth) throw tooLarge('knowledge_depth_rejected', '知识目录层级超过限制')
  await assertNoSymlinkSegments(directory, directory)
  const items = await readdir(directory, { withFileTypes: true })
  const result: Array<{ absolutePath: string; relativePath: string; byteLength: number }> = []
  for (const item of items) {
    if (item.name.startsWith('.') || item.name === 'node_modules') continue
    const absolutePath = join(directory, item.name)
    if (item.isSymbolicLink()) throw conflict('knowledge_symlink_rejected', '知识库不允许符号链接')
    if (item.isDirectory()) {
      const nested = await collectFiles(absolutePath, depth + 1)
      for (const entry of nested) result.push({ ...entry, relativePath: `${item.name}/${entry.relativePath}` })
    } else if (item.isFile()) {
      const info = await lstat(absolutePath)
      if (info.size > WORLD_KNOWLEDGE_LIMITS.maxFileBytes) throw tooLarge('knowledge_file_size_rejected', '知识文件超过大小限制')
      result.push({ absolutePath, relativePath: item.name, byteLength: info.size })
    }
    if (result.length > WORLD_KNOWLEDGE_LIMITS.maxFiles) throw tooLarge('knowledge_file_count_rejected', '知识文件数量超过限制')
  }
  return result.sort((left, right) => left.relativePath.localeCompare(right.relativePath))
}

async function safeExternalDirectory(value: string): Promise<string> {
  if (!value.trim() || value.includes('\0')) throw invalid('knowledge_source_path_invalid', '源目录路径无效')
  const candidate = resolve(value)
  const info = await lstat(candidate)
  if (info.isSymbolicLink() || !info.isDirectory()) throw invalid('knowledge_source_path_invalid', '源目录必须是实际目录')
  const walked = await assertUnredirectedPath(candidate)
  const resolved = await realpath(candidate)
  if (!isSamePath(walked, resolved)) throw conflict('knowledge_source_path_invalid', '源目录真实路径越界')
  return resolved
}

/**
 * 源目录不允许被符号链接改写位置。不能简单地对两侧都做 realpath 再比较：
 * 那样等式恒成立，任何中间段指向别处的符号链接都会被放行。
 *
 * 语义：逐段解析路径，每一段的真实路径必须仍然等于「父段真实路径 + 该段名」。
 * 唯一的放宽是文件系统根下的第一段——macOS 的 `/var -> private/var`、
 * `/tmp -> private/tmp` 这类平台别名让 `os.tmpdir()` 天然带一次重定向，
 * 而根级链接只有 root 能创建，且仍必须落在同一个文件系统根内。
 * 因此「合法的临时目录被接受」与「越界符号链接被拒绝」同时成立。
 */
async function assertUnredirectedPath(candidate: string): Promise<string> {
  const { root } = parsePath(candidate)
  const segments = relative(root, candidate).split(sep).filter((segment) => segment.length > 0)
  let lexical = root
  let real = await realpath(root)
  for (const [index, segment] of segments.entries()) {
    lexical = join(lexical, segment)
    const stepReal = await realpath(lexical)
    if (!isSamePath(join(real, segment), stepReal)) {
      const platformRootAlias = index === 0 && isPathWithin(real, stepReal)
      if (!platformRootAlias) throw conflict('knowledge_source_path_invalid', '源目录真实路径越界')
    }
    real = stepReal
  }
  return real
}

function isSamePath(left: string, right: string): boolean {
  return isPathWithin(left, right) && isPathWithin(right, left)
}

async function assertNoSymlinkSegments(root: string, candidate: string): Promise<void> {
  const rootResolved = resolve(root)
  const candidateResolved = resolve(candidate)
  if (!isPathWithin(rootResolved, candidateResolved)) throw conflict('knowledge_path_invalid', '知识库路径越界')
  const relativePath = relative(rootResolved, candidateResolved)
  let current = rootResolved
  for (const segment of relativePath.split(sep)) {
    if (!segment) continue
    current = join(current, segment)
    try { if ((await lstat(current)).isSymbolicLink()) throw conflict('knowledge_symlink_rejected', '知识库路径包含符号链接') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
}

function normalizeLibraryPath(value: string): string {
  const raw = value.trim().replaceAll('\\', '/')
  if (!raw || raw.includes('\0') || /[\u0001-\u001f\u007f]/.test(raw) || /%(?:2f|2e|5c)/i.test(raw) || raw.startsWith('/') || raw.startsWith('//') || /^[A-Za-z]:\//.test(raw)) throw invalid('knowledge_path_invalid', '知识库路径不是安全相对路径')
  let decoded: string
  try { decoded = decodeURIComponent(raw) } catch { throw invalid('knowledge_path_invalid', '知识库路径编码无效') }
  const segments = decoded.replaceAll('\\', '/').split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || /[:*?"<>|]/.test(segment) || /[ .]$/.test(segment) || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/i.test(segment))) throw invalid('knowledge_path_invalid', '知识库路径包含不安全片段')
  return segments.join('/')
}

function isSupportedFile(value: string): boolean { return ['.md', '.markdown', '.txt', '.text', '.json', '.pdf'].includes(extname(value).toLowerCase()) }
function collectionRoot(value: string): string { const first = value.split('/')[0] ?? 'root'; return `collections/${first}` }
function safeFileName(value: string): string { return cleanName(value, 'knowledge').replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 120) || 'knowledge' }
function cleanName(value: string, fallback: string): string { return value.replace(/[\0\r\n]/g, ' ').trim().slice(0, 180) || fallback }
function normalizeSourceUrl(value: string): string { try { const url = new URL(value); if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(); return url.toString() } catch { throw invalid('knowledge_source_url_invalid', '来源网址无效') } }
function toPosix(value: string): string { return value.replaceAll('\\', '/') }
function sha256(value: Buffer): string { return createHash('sha256').update(value).digest('hex') }
function toChunk(id: string, worldId: string, documentId: string, value: ParsedKnowledgeDocument['chunks'][number], createdAt: string): KnowledgeChunk { return { id, worldId, documentId, ordinal: value.ordinal, content: value.content, contentHash: sha256(Buffer.from(value.content, 'utf8')), startOffset: value.startOffset, endOffset: value.endOffset, createdAt } }
async function writeAtomically(destination: string, bytes: Buffer): Promise<void> { const temporary = `${destination}.tmp-${randomUUID()}`; await mkdir(dirname(destination), { recursive: true }); const handle = await open(temporary, 'wx', 0o600); try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }; await rename(temporary, destination) }
function invalid(code: string, message: string): ServiceError { return new ServiceError('invalid', code, message) }
function forbidden(code: string, message: string): ServiceError { return new ServiceError('forbidden', code, message) }
function notFound(code: string, message: string): ServiceError { return new ServiceError('not-found', code, message) }
function conflict(code: string, message: string): ServiceError { return new ServiceError('conflict', code, message) }
function tooLarge(code: string, message: string): ServiceError { return new ServiceError('too-large', code, message) }
function unsupported(code: string, message: string): ServiceError { return new ServiceError('unsupported', code, message) }
function unavailable(code: string, message: string): ServiceError { return new ServiceError('unavailable', code, message) }

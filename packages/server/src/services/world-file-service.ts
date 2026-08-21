import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'

import type { ChatAttachment, LocalAssetMimeType } from '@dsh-cyber/contracts'

import type { WorkspaceFileList, WorkspaceFilePreview } from './workspace-file-service.js'
import { WorkspaceFileService } from './workspace-file-service.js'
import { ServiceError } from './service-error.js'
import type { WorldRootService } from './world-root-service.js'

const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024
const ATTACHMENT_MIME_TYPES: readonly LocalAssetMimeType[] = [
  'image/png', 'image/jpeg', 'image/webp',
  'text/plain', 'text/markdown', 'application/json', 'application/pdf',
]

interface WorldAttachmentMetadata {
  schemaVersion: 1
  id: string
  name: string
  mimeType: LocalAssetMimeType
  byteLength: number
  sha256: string
  fileName: string
  createdAt: string
}

export class WorldFileService {
  readonly #roots: WorldRootService
  readonly #services = new Map<string, Promise<WorkspaceFileService>>()

  constructor(roots: WorldRootService) { this.#roots = roots }

  async list(worldId: string, path: string): Promise<WorkspaceFileList> { return (await this.#service(worldId)).list(path) }
  async preview(worldId: string, path: string): Promise<WorkspaceFilePreview> { return (await this.#service(worldId)).preview(path) }

  async uploadAttachment(worldId: string, input: { name: string; mimeType: string; dataBase64: string }): Promise<ChatAttachment> {
    const mimeType = allowedMimeType(input.mimeType)
    const bytes = decodeBase64(input.dataBase64)
    if (bytes.length < 1 || bytes.length > MAX_ATTACHMENT_BYTES) {
      throw new ServiceError('invalid', 'asset_size_rejected', '附件大小需在 1 byte 到 5 MiB 之间')
    }
    if (!matchesAttachmentSignature(bytes, mimeType)) {
      throw new ServiceError('invalid', 'asset_signature_rejected', '附件内容与声明的文件类型不匹配')
    }
    const root = await this.#roots.ensure(worldId)
    const id = randomUUID()
    const fileName = `${id}.${attachmentExtension(mimeType)}`
    const attachmentDirectory = join(root.assetsPath, 'attachments')
    await mkdir(attachmentDirectory, { recursive: true })
    const safeDirectory = await safeAttachmentDirectory(root.assetsPath, attachmentDirectory)
    const destination = join(safeDirectory, fileName)
    const metadataPath = join(safeDirectory, `${id}.json`)
    const metadata: WorldAttachmentMetadata = {
      schemaVersion: 1,
      id,
      name: input.name.trim().slice(0, 180) || '附件',
      mimeType,
      byteLength: bytes.length,
      sha256: sha256(bytes),
      fileName,
      createdAt: new Date().toISOString(),
    }
    try {
      await writeAtomically(destination, bytes)
      await writeAtomically(metadataPath, Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`, 'utf8'))
    } catch (error) {
      await Promise.all([unlink(destination).catch(() => undefined), unlink(metadataPath).catch(() => undefined)])
      throw error
    }
    return {
      assetId: id,
      name: metadata.name,
      mimeType,
      byteLength: bytes.length,
      url: `/api/worlds/${encodeURIComponent(worldId)}/assets/${encodeURIComponent(id)}`,
    }
  }

  async getAttachment(worldId: string, assetId: string): Promise<ChatAttachment> {
    const { metadata, filePath, rootAssetsPath } = await this.#loadAttachment(worldId, assetId)
    try {
      await assertSafeRegularFile(filePath, rootAssetsPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ServiceError('not-found', 'asset_not_found', '附件不存在')
      throw error
    }
    return {
      assetId: metadata.id,
      name: metadata.name,
      mimeType: metadata.mimeType,
      byteLength: metadata.byteLength,
      url: `/api/worlds/${encodeURIComponent(worldId)}/assets/${encodeURIComponent(metadata.id)}`,
    }
  }

  async readAttachment(worldId: string, assetId: string): Promise<{ body: Buffer; contentType: LocalAssetMimeType }> {
    const { metadata, filePath, rootAssetsPath } = await this.#loadAttachment(worldId, assetId)
    let body: Buffer
    try {
      await assertSafeRegularFile(filePath, rootAssetsPath)
      body = await readFile(filePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ServiceError('not-found', 'asset_not_found', '附件不存在')
      throw error
    }
    if (body.byteLength !== metadata.byteLength || sha256(body) !== metadata.sha256) {
      throw new ServiceError('conflict', 'asset_integrity_failed', '附件完整性校验失败')
    }
    return { body, contentType: metadata.mimeType }
  }

  async #loadAttachment(worldId: string, assetId: string): Promise<{ metadata: WorldAttachmentMetadata; filePath: string; rootAssetsPath: string }> {
    if (!/^[0-9a-f-]{36}$/i.test(assetId)) throw new ServiceError('not-found', 'asset_not_found', '附件不存在')
    const root = await this.#roots.ensure(worldId)
    const attachmentDirectory = join(root.assetsPath, 'attachments')
    const safeDirectory = await safeExistingAttachmentDirectory(root.assetsPath, attachmentDirectory)
    if (safeDirectory === undefined) throw new ServiceError('not-found', 'asset_not_found', '附件不存在')
    let metadata: WorldAttachmentMetadata
    try {
      const metadataPath = join(safeDirectory, `${assetId}.json`)
      await assertSafeRegularFile(metadataPath, root.assetsPath)
      metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as WorldAttachmentMetadata
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ServiceError('not-found', 'asset_not_found', '附件不存在')
      if (error instanceof ServiceError) throw error
      throw new ServiceError('conflict', 'asset_metadata_invalid', '附件元数据无效')
    }
    validateAttachmentMetadata(metadata, assetId)
    return { metadata, filePath: join(safeDirectory, metadata.fileName), rootAssetsPath: root.assetsPath }
  }

  #service(worldId: string): Promise<WorkspaceFileService> {
    let service = this.#services.get(worldId)
    if (service === undefined) {
      service = this.#roots.ensure(worldId).then((root) => new WorkspaceFileService(root.filesPath))
      this.#services.set(worldId, service)
    }
    return service
  }
}

function allowedMimeType(value: string): LocalAssetMimeType {
  if (!ATTACHMENT_MIME_TYPES.includes(value as LocalAssetMimeType)) {
    throw new ServiceError('invalid', 'invalid_enum', '不支持此附件类型')
  }
  return value as LocalAssetMimeType
}

function decodeBase64(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new ServiceError('invalid', 'invalid_base64', '附件数据不是有效 Base64')
  return Buffer.from(value, 'base64')
}

function matchesAttachmentSignature(bytes: Buffer, mimeType: LocalAssetMimeType): boolean {
  if (mimeType === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  if (mimeType === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  if (mimeType === 'image/webp') return bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  if (mimeType === 'application/pdf') return bytes.subarray(0, 5).toString('ascii') === '%PDF-'
  const text = bytes.toString('utf8')
  if (text.includes('\0') || text.includes('\uFFFD')) return false
  if (mimeType === 'application/json') {
    try { JSON.parse(text); return true } catch { return false }
  }
  return true
}

function attachmentExtension(mimeType: LocalAssetMimeType): string {
  return ({
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp',
    'text/plain': 'txt', 'text/markdown': 'md', 'application/json': 'json', 'application/pdf': 'pdf',
  } as Record<LocalAssetMimeType, string>)[mimeType]
}

function validateAttachmentMetadata(value: WorldAttachmentMetadata, assetId: string): void {
  if (
    value === undefined || value === null || typeof value !== 'object'
    || value.schemaVersion !== 1
    || value.id !== assetId
    || typeof value.name !== 'string' || value.name.trim() === '' || value.name.length > 180
    || !ATTACHMENT_MIME_TYPES.includes(value.mimeType)
    || !Number.isInteger(value.byteLength) || value.byteLength < 1 || value.byteLength > MAX_ATTACHMENT_BYTES
    || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)
    || typeof value.fileName !== 'string' || value.fileName !== `${assetId}.${attachmentExtension(value.mimeType)}`
    || typeof value.createdAt !== 'string' || Number.isNaN(Date.parse(value.createdAt))
  ) {
    throw new ServiceError('conflict', 'asset_metadata_invalid', '附件元数据无效')
  }
}

async function safeAttachmentDirectory(rootAssetsPath: string, directory: string): Promise<string> {
  const info = await lstat(directory)
  if (info.isSymbolicLink() || !info.isDirectory()) throw new ServiceError('conflict', 'asset_path_invalid', '附件目录无效')
  const resolved = await realpath(directory)
  if (!isPathWithin(rootAssetsPath, resolved)) throw new ServiceError('conflict', 'asset_path_invalid', '附件路径越界')
  return resolved
}

async function safeExistingAttachmentDirectory(rootAssetsPath: string, directory: string): Promise<string | undefined> {
  try {
    return await safeAttachmentDirectory(rootAssetsPath, directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function assertSafeRegularFile(filePath: string, rootPath: string): Promise<void> {
  const info = await lstat(filePath)
  if (info.isSymbolicLink() || !info.isFile()) throw new ServiceError('conflict', 'asset_path_invalid', '附件文件无效')
  const resolved = await realpath(filePath)
  if (!isPathWithin(rootPath, resolved)) throw new ServiceError('conflict', 'asset_path_invalid', '附件路径越界')
}

function isPathWithin(parent: string, candidate: string): boolean {
  const normalize = (value: string) => value.endsWith(sep) ? value.slice(0, -1) : value
  const base = normalize(parent).toLowerCase()
  const target = normalize(candidate).toLowerCase()
  return target === base || target.startsWith(`${base}${sep}`)
}

function sha256(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex') }

async function writeAtomically(destination: string, bytes: Buffer): Promise<void> {
  const temporary = `${destination}.tmp-${randomUUID()}`
  await mkdir(dirname(destination), { recursive: true })
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporary, destination)
}

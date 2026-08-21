import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'

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
    const destination = join(attachmentDirectory, fileName)
    const metadataPath = join(attachmentDirectory, `${id}.json`)
    await mkdir(attachmentDirectory, { recursive: true })
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

  async readAttachment(worldId: string, assetId: string): Promise<{ body: Buffer; contentType: LocalAssetMimeType }> {
    if (!/^[0-9a-f-]{36}$/i.test(assetId)) throw new ServiceError('not-found', 'asset_not_found', '附件不存在')
    const root = await this.#roots.ensure(worldId)
    const attachmentDirectory = join(root.assetsPath, 'attachments')
    let metadata: WorldAttachmentMetadata
    try {
      metadata = JSON.parse(await readFile(join(attachmentDirectory, `${assetId}.json`), 'utf8')) as WorldAttachmentMetadata
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ServiceError('not-found', 'asset_not_found', '附件不存在')
      throw error
    }
    if (metadata.schemaVersion !== 1 || metadata.id !== assetId || !ATTACHMENT_MIME_TYPES.includes(metadata.mimeType)) {
      throw new ServiceError('conflict', 'asset_metadata_invalid', '附件元数据无效')
    }
    const body = await readFile(join(attachmentDirectory, metadata.fileName))
    if (body.byteLength !== metadata.byteLength || sha256(body) !== metadata.sha256) {
      throw new ServiceError('conflict', 'asset_integrity_failed', '附件完整性校验失败')
    }
    return { body, contentType: metadata.mimeType }
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

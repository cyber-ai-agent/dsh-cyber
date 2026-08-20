import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type {
  ChatAttachment,
  LocalAsset,
  LocalAssetMimeType,
} from '@dsh-cyber/contracts'
import type { SqliteStore } from '@dsh-cyber/persistence'

import { ServiceError } from './service-error.js'

const MAX_BACKGROUND_BYTES = 5 * 1024 * 1024
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024
const BACKGROUND_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const
const ATTACHMENT_MIME_TYPES = [
  'image/png', 'image/jpeg', 'image/webp',
  'text/plain', 'text/markdown', 'application/json', 'application/pdf',
] as const

export interface UploadedBackground {
  asset: LocalAsset
  url: string
}

export interface UploadedAttachment {
  asset: LocalAsset
  attachment: ChatAttachment
}

export interface AssetContent {
  body: Buffer
  contentType: LocalAssetMimeType
}

export class AssetService {
  readonly #store: Pick<SqliteStore, 'getWorkspace' | 'saveLocalAsset' | 'getLocalAsset'>
  readonly #assetRoot: string

  constructor(
    store: Pick<SqliteStore, 'getWorkspace' | 'saveLocalAsset' | 'getLocalAsset'>,
    stateRoot: string,
  ) {
    this.#store = store
    this.#assetRoot = join(stateRoot, 'assets')
  }

  async uploadBackground(input: {
    workspaceId: string
    mimeType: string
    dataBase64: string
  }): Promise<UploadedBackground> {
    this.#requireWorkspace(input.workspaceId)
    const mimeType = allowedMimeType(input.mimeType, BACKGROUND_MIME_TYPES)
    const bytes = decodeBase64(input.dataBase64, 'Background data must be base64')
    if (bytes.length < 1 || bytes.length > MAX_BACKGROUND_BYTES) {
      throw new ServiceError('invalid', 'asset_size_rejected', 'Background image must be between 1 byte and 5 MiB')
    }
    if (!matchesImageSignature(bytes, mimeType)) {
      throw new ServiceError('invalid', 'asset_signature_rejected', 'Background image signature does not match its MIME type')
    }
    const id = randomUUID()
    const extension = mimeType === 'image/png' ? 'png' : mimeType === 'image/jpeg' ? 'jpg' : 'webp'
    const relativePath = `${input.workspaceId}/${id}.${extension}`
    const destination = await this.#writeAtomically(relativePath, bytes)
    try {
      const asset = this.#store.saveLocalAsset({
        id,
        workspaceId: input.workspaceId,
        kind: 'background',
        mimeType,
        sha256: sha256(bytes),
        relativePath,
        byteLength: bytes.length,
      })
      return { asset, url: `/api/assets/${asset.id}` }
    } catch (error) {
      await unlink(destination).catch(() => undefined)
      throw error
    }
  }

  async uploadAttachment(input: {
    workspaceId: string
    name: string
    mimeType: string
    dataBase64: string
  }): Promise<UploadedAttachment> {
    this.#requireWorkspace(input.workspaceId)
    const mimeType = allowedMimeType(input.mimeType, ATTACHMENT_MIME_TYPES)
    const bytes = decodeBase64(input.dataBase64, 'Attachment data must be base64')
    if (bytes.length < 1 || bytes.length > MAX_ATTACHMENT_BYTES) {
      throw new ServiceError('invalid', 'asset_size_rejected', 'Attachment must be between 1 byte and 5 MiB')
    }
    if (!matchesAttachmentSignature(bytes, mimeType)) {
      throw new ServiceError('invalid', 'asset_signature_rejected', 'Attachment content does not match its MIME type')
    }
    const id = randomUUID()
    const relativePath = `${input.workspaceId}/attachments/${id}.${attachmentExtension(mimeType)}`
    const destination = await this.#writeAtomically(relativePath, bytes)
    try {
      const asset = this.#store.saveLocalAsset({
        id,
        workspaceId: input.workspaceId,
        kind: 'attachment',
        mimeType,
        sha256: sha256(bytes),
        relativePath,
        byteLength: bytes.length,
      })
      return {
        asset,
        attachment: {
          assetId: asset.id,
          name: input.name.slice(0, 180),
          mimeType,
          byteLength: bytes.length,
          url: `/api/assets/${asset.id}`,
        },
      }
    } catch (error) {
      await unlink(destination).catch(() => undefined)
      throw error
    }
  }

  async read(assetId: string): Promise<AssetContent> {
    const asset = this.#store.getLocalAsset(assetId)
    if (asset === undefined) throw new ServiceError('not-found', 'asset_not_found', 'Asset not found')
    const body = await readFile(join(this.#assetRoot, asset.relativePath))
    if (sha256(body) !== asset.sha256) {
      throw new ServiceError('conflict', 'asset_integrity_failed', 'Local asset integrity check failed')
    }
    return { body, contentType: asset.mimeType }
  }

  #requireWorkspace(workspaceId: string): void {
    if (this.#store.getWorkspace(workspaceId) === undefined) {
      throw new ServiceError('not-found', 'workspace_not_found', 'Workspace not found')
    }
  }

  async #writeAtomically(relativePath: string, bytes: Buffer): Promise<string> {
    const destination = join(this.#assetRoot, relativePath)
    const temporary = `${destination}.tmp-${randomUUID()}`
    await mkdir(dirname(destination), { recursive: true })
    try {
      const handle = await open(temporary, 'wx', 0o600)
      try {
        await handle.writeFile(bytes)
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(temporary, destination)
      return destination
    } catch (error) {
      await unlink(temporary).catch(() => undefined)
      throw error
    }
  }
}

function allowedMimeType<T extends LocalAssetMimeType>(value: string, allowed: readonly T[]): T {
  if (!allowed.includes(value as T)) {
    throw new ServiceError('invalid', 'invalid_enum', 'mimeType has an unsupported value')
  }
  return value as T
}

function decodeBase64(value: string, message: string): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new ServiceError('invalid', 'invalid_base64', message)
  }
  return Buffer.from(value, 'base64')
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function matchesImageSignature(
  bytes: Buffer,
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp',
): boolean {
  if (mimeType === 'image/png') {
    return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  }
  if (mimeType === 'image/jpeg') {
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  }
  return bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
}

function matchesAttachmentSignature(bytes: Buffer, mimeType: LocalAssetMimeType): boolean {
  if (mimeType === 'image/png' || mimeType === 'image/jpeg' || mimeType === 'image/webp') {
    return matchesImageSignature(bytes, mimeType)
  }
  if (mimeType === 'application/pdf') return bytes.subarray(0, 5).toString('ascii') === '%PDF-'
  const text = bytes.toString('utf8')
  if (text.includes('\0') || text.includes('\uFFFD')) return false
  if (mimeType === 'application/json') {
    try {
      JSON.parse(text)
      return true
    } catch {
      return false
    }
  }
  return true
}

function attachmentExtension(mimeType: LocalAssetMimeType): string {
  return ({
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'text/plain': 'txt',
    'text/markdown': 'md',
    'application/json': 'json',
    'application/pdf': 'pdf',
  } as Record<LocalAssetMimeType, string>)[mimeType]
}

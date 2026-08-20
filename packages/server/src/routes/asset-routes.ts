import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'

import type { LocalAssetMimeType } from '@dsh-cyber/contracts'
import type { SqliteStore } from '@dsh-cyber/persistence'

import { HttpError } from '../http/errors.js'
import type { Router } from '../http/router.js'
import { readJson, requiredEnum, requiredString } from '../http/request.js'
import { writeBinary, writeJson } from '../http/response.js'

const MAX_BACKGROUND_BYTES = 5 * 1024 * 1024
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024

export interface AssetRoutesDependencies {
  store: SqliteStore
  stateRoot: string
}

export function registerAssetRoutes(router: Router, dependencies: AssetRoutesDependencies): void {
  const { store, stateRoot } = dependencies

  router.get(/^\/api\/workspaces\/([^/]+)\/assets$/, ({ response, params }) => {
    writeJson(response, 200, { items: store.listLocalAssets(params[0]!) })
  })

  router.post(/^\/api\/workspaces\/([^/]+)\/assets\/background$/, async ({ request, response, params }) => {
    const workspaceId = params[0]!
    if (store.getWorkspace(workspaceId) === undefined) {
      throw new HttpError(404, 'workspace_not_found', 'Workspace not found')
    }
    const body = await readJson(request)
    const mimeType = requiredEnum(body, 'mimeType', ['image/png', 'image/jpeg', 'image/webp'])
    const encoded = requiredString(body, 'dataBase64')
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
      throw new HttpError(422, 'invalid_base64', 'Background data must be base64')
    }
    const bytes = Buffer.from(encoded, 'base64')
    if (bytes.length < 1 || bytes.length > MAX_BACKGROUND_BYTES) {
      throw new HttpError(422, 'asset_size_rejected', 'Background image must be between 1 byte and 5 MiB')
    }
    if (!matchesImageSignature(bytes, mimeType)) {
      throw new HttpError(422, 'asset_signature_rejected', 'Background image signature does not match its MIME type')
    }
    const id = randomUUID()
    const extension = mimeType === 'image/png' ? 'png' : mimeType === 'image/jpeg' ? 'jpg' : 'webp'
    const relativePath = `${workspaceId}/${id}.${extension}`
    const assetRoot = join(stateRoot, 'assets')
    const destination = join(assetRoot, relativePath)
    const temporary = `${destination}.tmp-${randomUUID()}`
    await mkdir(join(assetRoot, workspaceId), { recursive: true })
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, destination)
    try {
      const asset = store.saveLocalAsset({
        id,
        workspaceId,
        kind: 'background',
        mimeType,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        relativePath,
        byteLength: bytes.length,
      })
      writeJson(response, 201, { asset, url: `/api/assets/${asset.id}` })
    } catch (error) {
      await unlink(destination).catch(() => undefined)
      throw error
    }
  })

  router.post(/^\/api\/workspaces\/([^/]+)\/assets\/attachment$/, async ({ request, response, params }) => {
    const workspaceId = params[0]!
    if (store.getWorkspace(workspaceId) === undefined) {
      throw new HttpError(404, 'workspace_not_found', 'Workspace not found')
    }
    const body = await readJson(request)
    const name = requiredString(body, 'name').slice(0, 180)
    const mimeType = requiredEnum(body, 'mimeType', [
      'image/png', 'image/jpeg', 'image/webp',
      'text/plain', 'text/markdown', 'application/json', 'application/pdf',
    ])
    const encoded = requiredString(body, 'dataBase64')
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
      throw new HttpError(422, 'invalid_base64', 'Attachment data must be base64')
    }
    const bytes = Buffer.from(encoded, 'base64')
    if (bytes.length < 1 || bytes.length > MAX_ATTACHMENT_BYTES) {
      throw new HttpError(422, 'asset_size_rejected', 'Attachment must be between 1 byte and 5 MiB')
    }
    if (!matchesAttachmentSignature(bytes, mimeType)) {
      throw new HttpError(422, 'asset_signature_rejected', 'Attachment content does not match its MIME type')
    }
    const id = randomUUID()
    const relativePath = `${workspaceId}/attachments/${id}.${attachmentExtension(mimeType)}`
    const assetRoot = join(stateRoot, 'assets')
    const destination = join(assetRoot, relativePath)
    const temporary = `${destination}.tmp-${randomUUID()}`
    await mkdir(join(assetRoot, workspaceId, 'attachments'), { recursive: true })
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, destination)
    try {
      const asset = store.saveLocalAsset({
        id,
        workspaceId,
        kind: 'attachment',
        mimeType,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        relativePath,
        byteLength: bytes.length,
      })
      writeJson(response, 201, {
        asset,
        attachment: { assetId: asset.id, name, mimeType, byteLength: bytes.length, url: `/api/assets/${asset.id}` },
      })
    } catch (error) {
      await unlink(destination).catch(() => undefined)
      throw error
    }
  })

  router.get(/^\/api\/assets\/([^/]+)$/, async ({ response, params }) => {
    const asset = store.getLocalAsset(params[0]!)
    if (asset === undefined) throw new HttpError(404, 'asset_not_found', 'Asset not found')
    const bytes = await readFile(join(stateRoot, 'assets', asset.relativePath))
    if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256) {
      throw new HttpError(409, 'asset_integrity_failed', 'Local asset integrity check failed')
    }
    writeBinary(response, 200, bytes, asset.mimeType)
  })
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

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type {
  CharacterAvatarAsset,
  CharacterAvatarAssetRendererKind,
  ChatAttachment,
  JsonObject,
  LocalAsset,
  LocalAssetMimeType,
} from '@dsh-cyber/contracts'
import type { SqliteStore } from '@dsh-cyber/persistence'

import { ServiceError } from './service-error.js'

const MAX_BACKGROUND_BYTES = 5 * 1024 * 1024
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024
const MAX_AVATAR_IMAGE_BYTES = 8 * 1024 * 1024
const MAX_AVATAR_VRM_BYTES = 20 * 1024 * 1024
const BACKGROUND_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const
const ATTACHMENT_MIME_TYPES = [
  'image/png', 'image/jpeg', 'image/webp',
  'text/plain', 'text/markdown', 'application/json', 'application/pdf',
] as const
const AVATAR_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'model/gltf-binary'] as const
const REQUIRED_VRM_BONES = ['hips', 'spine', 'head', 'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot', 'leftUpperArm', 'leftLowerArm', 'leftHand', 'rightUpperArm', 'rightLowerArm', 'rightHand'] as const

export interface UploadedBackground {
  asset: LocalAsset
  url: string
}

export interface UploadedAttachment {
  asset: LocalAsset
  attachment: ChatAttachment
}

export interface UploadedCharacterAvatar {
  asset: LocalAsset
  avatarAsset: CharacterAvatarAsset
  url: string
}

export interface AssetContent {
  body: Buffer
  contentType: LocalAssetMimeType
}

export class AssetService {
  readonly #store: Pick<SqliteStore, 'getWorkspace' | 'getEmployee' | 'saveLocalAsset' | 'deleteLocalAsset' | 'saveCharacterAvatarAsset' | 'getLocalAsset'>
  readonly #assetRoot: string

  constructor(
    store: Pick<SqliteStore, 'getWorkspace' | 'getEmployee' | 'saveLocalAsset' | 'deleteLocalAsset' | 'saveCharacterAvatarAsset' | 'getLocalAsset'>,
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

  async uploadCharacterAvatar(input: {
    employeeId: string
    name: string
    mimeType: string
    dataBase64: string
  }): Promise<UploadedCharacterAvatar> {
    const employee = this.#store.getEmployee(input.employeeId)
    if (employee === undefined || employee.status === 'archived') {
      throw new ServiceError('not-found', 'character_not_found', 'Character not found')
    }
    const mimeType = allowedMimeType(input.mimeType, AVATAR_MIME_TYPES)
    const bytes = decodeBase64(input.dataBase64, 'Character avatar data must be base64')
    const maximum = mimeType === 'model/gltf-binary' ? MAX_AVATAR_VRM_BYTES : MAX_AVATAR_IMAGE_BYTES
    if (bytes.length < 1 || bytes.length > maximum) {
      throw new ServiceError('invalid', 'avatar_asset_size_rejected', mimeType === 'model/gltf-binary' ? 'VRM/GLB must be between 1 byte and 20 MiB' : 'Avatar image must be between 1 byte and 8 MiB')
    }
    const inspection: { rendererKind: CharacterAvatarAssetRendererKind; validation: JsonObject } = mimeType === 'model/gltf-binary'
      ? inspectGlb(bytes)
      : { rendererKind: 'image-2d', validation: validateAvatarImage(bytes, mimeType) }
    const id = randomUUID()
    const extension = mimeType === 'model/gltf-binary' ? 'vrm' : mimeType === 'image/png' ? 'png' : mimeType === 'image/jpeg' ? 'jpg' : 'webp'
    const relativePath = `${employee.workspaceId}/avatars/${employee.id}/${id}.${extension}`
    const destination = await this.#writeAtomically(relativePath, bytes)
    try {
      const asset = this.#store.saveLocalAsset({
        id,
        workspaceId: employee.workspaceId,
        kind: 'avatar',
        mimeType,
        sha256: sha256(bytes),
        relativePath,
        byteLength: bytes.length,
      })
      try {
        const avatarAsset = this.#store.saveCharacterAvatarAsset({
          assetId: asset.id,
          workspaceId: employee.workspaceId,
          worldId: employee.worldId,
          employeeId: employee.id,
          rendererKind: inspection.rendererKind,
          originalName: input.name.trim().slice(0, 180),
          validation: inspection.validation,
        })
        return { asset, avatarAsset, url: `/api/assets/${asset.id}` }
      } catch (error) {
        this.#store.deleteLocalAsset(asset.id)
        throw error
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

function validateAvatarImage(bytes: Buffer, mimeType: Exclude<(typeof AVATAR_MIME_TYPES)[number], 'model/gltf-binary'>): JsonObject {
  if (!matchesImageSignature(bytes, mimeType)) {
    throw new ServiceError('invalid', 'avatar_signature_rejected', 'Avatar image signature does not match its MIME type')
  }
  return { format: mimeType, signatureVerified: true, previewable: true }
}

function inspectGlb(bytes: Buffer): { rendererKind: CharacterAvatarAssetRendererKind; validation: JsonObject } {
  if (bytes.length < 20 || bytes.subarray(0, 4).toString('ascii') !== 'glTF') {
    throw new ServiceError('invalid', 'avatar_vrm_invalid', 'VRM must be a binary glTF 2.0 file')
  }
  const version = bytes.readUInt32LE(4)
  const declaredLength = bytes.readUInt32LE(8)
  const jsonLength = bytes.readUInt32LE(12)
  const jsonChunkType = bytes.readUInt32LE(16)
  if (version !== 2 || declaredLength !== bytes.length || jsonChunkType !== 0x4e4f534a || jsonLength < 2 || 20 + jsonLength > bytes.length) {
    throw new ServiceError('invalid', 'avatar_vrm_invalid', 'VRM binary container is malformed')
  }
  let document: Record<string, unknown>
  try {
    document = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8').replace(/\u0000+$/u, '').trim()) as Record<string, unknown>
  } catch {
    throw new ServiceError('invalid', 'avatar_vrm_invalid', 'VRM metadata is not valid JSON')
  }
  const asset = objectRecord(document.asset)
  if (asset?.version !== '2.0') throw new ServiceError('invalid', 'avatar_vrm_invalid', 'VRM must use glTF 2.0')
  const meshes = Array.isArray(document.meshes) ? document.meshes.length : 0
  if (meshes < 1) throw new ServiceError('invalid', 'avatar_glb_mesh_required', 'GLB must contain at least one mesh')
  const externalUris = [...arrayRecords(document.buffers), ...arrayRecords(document.images)]
    .map((item) => item.uri)
    .filter((uri): uri is string => typeof uri === 'string' && !uri.startsWith('data:'))
  if (externalUris.length > 0) {
    throw new ServiceError('invalid', 'avatar_vrm_external_resource', 'VRM/GLB must be self-contained and cannot reference external files')
  }
  const extensions = objectRecord(document.extensions)
  const vrm = objectRecord(extensions?.VRMC_vrm)
  if (vrm === undefined) {
    return { rendererKind: 'mesh-preview', validation: { format: 'glb-2.0', gltfVersion: '2.0', meshes, selfContained: true, previewable: true, interactiveAvatar: false } }
  }
  const meta = objectRecord(vrm.meta)
  const extensionsUsed = Array.isArray(document.extensionsUsed) ? document.extensionsUsed : []
  const authors = Array.isArray(meta?.authors) ? meta.authors : []
  if (vrm.specVersion !== '1.0' || !extensionsUsed.includes('VRMC_vrm') || meta === undefined || typeof meta.name !== 'string' || meta.name.trim().length === 0 || authors.length === 0 || !authors.every((author) => typeof author === 'string' && author.trim().length > 0) || typeof meta.licenseUrl !== 'string' || meta.licenseUrl.trim().length === 0) {
    throw new ServiceError('invalid', 'avatar_vrm_invalid', 'VRMC_vrm must declare specVersion 1.0 and valid meta')
  }
  const humanoid = objectRecord(vrm.humanoid)
  const humanBones = objectRecord(humanoid?.humanBones)
  const nodeCount = Array.isArray(document.nodes) ? document.nodes.length : 0
  const missingBones = REQUIRED_VRM_BONES.filter((name) => {
    const bone = objectRecord(humanBones?.[name])
    return bone === undefined || typeof bone.node !== 'number' || !Number.isInteger(bone.node) || bone.node < 0 || bone.node >= nodeCount
  })
  if (humanBones === undefined || missingBones.length > 0) {
    throw new ServiceError('invalid', 'avatar_vrm_required', `VRM 1.0 is missing required humanoid bones: ${missingBones.join(', ')}`)
  }
  const requiredBoneNodes = REQUIRED_VRM_BONES.map((name) => objectRecord(humanBones[name])!.node as number)
  if (new Set(requiredBoneNodes).size !== requiredBoneNodes.length) {
    throw new ServiceError('invalid', 'avatar_vrm_required', 'VRM 1.0 required humanoid bones must reference distinct nodes')
  }
  const expressions = objectRecord(vrm.expressions)
  const presetExpressions = objectRecord(expressions?.preset)
  const expressionNames = Object.keys(presetExpressions ?? {})
  const visemeReady = ['aa', 'ih', 'ou', 'ee', 'oh'].every((name) => expressionNames.includes(name))
  return { rendererKind: 'vrm-3d', validation: {
      format: 'vrm-1.0', gltfVersion: '2.0', specVersion: '1.0', meshes,
      humanBoneCount: Object.keys(humanBones).length,
      expressionCount: Object.keys(presetExpressions ?? {}).length,
      visemeReady, hasLookAt: vrm.lookAt !== undefined,
      selfContained: true, previewable: true, interactiveAvatar: true,
    } }
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function arrayRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.map(objectRecord).filter((item): item is Record<string, unknown> => item !== undefined) : []
}

function attachmentExtension(mimeType: LocalAssetMimeType): string {
  return ({
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'model/gltf-binary': 'vrm',
    'text/plain': 'txt',
    'text/markdown': 'md',
    'application/json': 'json',
    'application/pdf': 'pdf',
  } as Record<LocalAssetMimeType, string>)[mimeType]
}

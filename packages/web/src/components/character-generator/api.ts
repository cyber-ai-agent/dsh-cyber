import { api } from '../../api.js'
import type {
  CharacterBlueprintDraft,
  CharacterGeneratorAnalyzeResult,
  CharacterGeneratorAvatarSelection,
  CharacterGeneratorCatalog,
  CharacterGeneratorPublishResult,
  CharacterSourceInput,
} from '@dsh-cyber/contracts'
import {
  CHARACTER_AVATAR_MAX_BYTES,
  normalizeCatalog,
  normalizeDraft,
} from './model.js'

const AVATAR_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const
type AvatarMimeType = (typeof AVATAR_MIME_TYPES)[number]

export async function loadCharacterGeneratorCatalog(
  workspaceId: string,
  worldTemplateId: string,
  signal?: AbortSignal,
): Promise<CharacterGeneratorCatalog> {
  const result = await api<unknown>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/character-generator/catalog?worldTemplateId=${encodeURIComponent(worldTemplateId)}`,
    signal === undefined ? undefined : { signal },
  )
  return normalizeCatalog(result)
}

export async function analyzeCharacterSource(
  workspaceId: string,
  source: CharacterSourceInput,
  targetWorldTemplateId: string,
  signal?: AbortSignal,
): Promise<CharacterGeneratorAnalyzeResult> {
  const result = await api<unknown>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/character-generator/analyze`,
    {
      method: 'POST',
      body: JSON.stringify({ source, targetWorldTemplateId }),
      ...(signal === undefined ? {} : { signal }),
    },
  )
  const record = isRecord(result) && 'draft' in result ? result.draft : result
  return { draft: normalizeDraft(record, targetWorldTemplateId) }
}

export async function publishCharacterDraft(
  workspaceId: string,
  source: CharacterSourceInput,
  draft: CharacterBlueprintDraft,
  avatar: CharacterGeneratorAvatarSelection | undefined,
  signal?: AbortSignal,
): Promise<CharacterGeneratorPublishResult> {
  const result = await api<unknown>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/character-generator/publish`,
    {
      method: 'POST',
      body: JSON.stringify({
        source,
        draft,
        targetWorldTemplateId: draft.targetWorldTemplateId,
        ...(avatar === undefined ? {} : { avatar }),
      }),
      ...(signal === undefined ? {} : { signal }),
    },
  )
  if (!isRecord(result) || !isRecord(result.item) || !isRecord(result.blueprint)) {
    throw new Error('角色包发布响应缺少角色模板或市场条目。')
  }
  return result as unknown as CharacterGeneratorPublishResult
}

export async function readUploadedAvatar(file: File): Promise<CharacterGeneratorAvatarSelection> {
  const mimeType = inferAvatarMimeType(file)
  if (file.size > CHARACTER_AVATAR_MAX_BYTES) throw new Error('头像文件不能超过 5 MiB。')
  const dataUrl = await readFileAsDataUrl(file)
  const dataBase64 = dataUrl.split(',')[1] ?? ''
  if (dataBase64.length === 0) throw new Error('头像文件读取失败。')
  return {
    kind: 'upload',
    fileName: file.name,
    mimeType,
    dataBase64,
  }
}

function inferAvatarMimeType(file: File): AvatarMimeType {
  const byType = file.type.toLowerCase() as AvatarMimeType
  if ((AVATAR_MIME_TYPES as readonly string[]).includes(byType)) return byType
  const extension = file.name.toLowerCase().split('.').pop()
  if (extension === 'png') return 'image/png'
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg'
  if (extension === 'webp') return 'image/webp'
  throw new Error('头像仅支持 PNG、JPEG 或 WebP。')
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error ?? new Error('文件读取失败。'))
    reader.readAsDataURL(file)
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

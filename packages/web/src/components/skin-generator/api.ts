import { api } from '../../api.js'
import type {
  CharacterSourceInput,
  SkinDraft,
  SkinGeneratorAnalyzeResult,
  SkinGeneratorBackdropSelection,
  SkinGeneratorCatalog,
  SkinGeneratorPublishResult,
} from '@dsh-cyber/contracts'
import { normalizeSkinCatalog, normalizeSkinDraft } from './model.js'

export async function loadSkinGeneratorCatalog(workspaceId: string, signal?: AbortSignal): Promise<SkinGeneratorCatalog> {
  const result = await api<unknown>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/skin-generator/catalog`,
    signal === undefined ? undefined : { signal },
  )
  return normalizeSkinCatalog(result)
}

export async function analyzeSkinSource(
  workspaceId: string,
  source: CharacterSourceInput,
  signal?: AbortSignal,
): Promise<SkinGeneratorAnalyzeResult> {
  const result = await api<unknown>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/skin-generator/analyze`,
    { method: 'POST', body: JSON.stringify({ source }), ...(signal === undefined ? {} : { signal }) },
  )
  const record = isRecord(result) ? result : {}
  const suggested = typeof record.suggestedBackdropId === 'string' ? record.suggestedBackdropId : undefined
  return {
    draft: normalizeSkinDraft('draft' in record ? record.draft : result),
    ...(suggested === undefined ? {} : { suggestedBackdropId: suggested }),
  }
}

export async function publishSkinDraft(
  workspaceId: string,
  source: CharacterSourceInput,
  draft: SkinDraft,
  backdrop: SkinGeneratorBackdropSelection | undefined,
  signal?: AbortSignal,
): Promise<SkinGeneratorPublishResult> {
  const result = await api<unknown>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/skin-generator/publish`,
    {
      method: 'POST',
      body: JSON.stringify({ source, draft, ...(backdrop === undefined ? {} : { backdrop }) }),
      ...(signal === undefined ? {} : { signal }),
    },
  )
  if (!isRecord(result) || !isRecord(result.item) || !isRecord(result.skin)) {
    throw new Error('皮肤包发布响应缺少皮肤声明或市场条目。')
  }
  return result as unknown as SkinGeneratorPublishResult
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

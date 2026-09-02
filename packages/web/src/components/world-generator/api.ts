import { api } from '../../api.js'
import type {
  CharacterSourceInput,
  WorldGeneratorAnalyzeResult,
  WorldGeneratorCatalog,
  WorldGeneratorPublishResult,
  WorldGeneratorSceneSelection,
  WorldThemeDraft,
} from '@dsh-cyber/contracts'
import { normalizeWorldCatalog, normalizeWorldDraft } from './model.js'

export async function loadWorldGeneratorCatalog(workspaceId: string, signal?: AbortSignal): Promise<WorldGeneratorCatalog> {
  const result = await api<unknown>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/world-generator/catalog`,
    signal === undefined ? undefined : { signal },
  )
  return normalizeWorldCatalog(result)
}

export async function analyzeWorldSource(
  workspaceId: string,
  source: CharacterSourceInput,
  targetWorldTemplateId: string,
  signal?: AbortSignal,
): Promise<WorldGeneratorAnalyzeResult> {
  const result = await api<unknown>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/world-generator/analyze`,
    { method: 'POST', body: JSON.stringify({ source }), ...(signal === undefined ? {} : { signal }) },
  )
  const record = isRecord(result) ? result : {}
  const suggested = typeof record.suggestedSceneId === 'string' ? record.suggestedSceneId : undefined
  return {
    draft: normalizeWorldDraft('draft' in record ? record.draft : result, targetWorldTemplateId),
    ...(suggested === undefined ? {} : { suggestedSceneId: suggested }),
  }
}

export async function publishWorldDraft(
  workspaceId: string,
  source: CharacterSourceInput,
  draft: WorldThemeDraft,
  scene: WorldGeneratorSceneSelection | undefined,
  signal?: AbortSignal,
): Promise<WorldGeneratorPublishResult> {
  const result = await api<unknown>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/world-generator/publish`,
    {
      method: 'POST',
      body: JSON.stringify({ source, draft, ...(scene === undefined ? {} : { scene }) }),
      ...(signal === undefined ? {} : { signal }),
    },
  )
  if (!isRecord(result) || !isRecord(result.item) || !isRecord(result.theme) || !Array.isArray(result.cast)) {
    throw new Error('世界包发布响应缺少主题包或市场条目。')
  }
  return result as unknown as WorldGeneratorPublishResult
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

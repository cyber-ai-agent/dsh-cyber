import { api } from '../../api.js'
import type {
  CharacterSourceInput,
  PluginDraft,
  PluginGeneratorAnalyzeResult,
  PluginGeneratorCatalog,
  PluginGeneratorPublishResult,
} from '@dsh-cyber/contracts'
import { normalizePluginCatalog, normalizePluginDraft } from './model.js'

export async function loadPluginGeneratorCatalog(workspaceId: string, signal?: AbortSignal): Promise<PluginGeneratorCatalog> {
  const result = await api<unknown>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/plugin-generator/catalog`,
    signal === undefined ? undefined : { signal },
  )
  return normalizePluginCatalog(result)
}

export async function analyzePluginSource(
  workspaceId: string,
  source: CharacterSourceInput,
  signal?: AbortSignal,
): Promise<PluginGeneratorAnalyzeResult> {
  const result = await api<unknown>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/plugin-generator/analyze`,
    { method: 'POST', body: JSON.stringify({ source }), ...(signal === undefined ? {} : { signal }) },
  )
  const record = isRecord(result) ? result : {}
  return { draft: normalizePluginDraft('draft' in record ? record.draft : result) }
}

export async function publishPluginDraft(
  workspaceId: string,
  source: CharacterSourceInput,
  draft: PluginDraft,
  signal?: AbortSignal,
): Promise<PluginGeneratorPublishResult> {
  const result = await api<unknown>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/plugin-generator/publish`,
    { method: 'POST', body: JSON.stringify({ source, draft }), ...(signal === undefined ? {} : { signal }) },
  )
  if (!isRecord(result) || !isRecord(result.item) || !isRecord(result.definition)) {
    throw new Error('插件包发布响应缺少指令声明或市场条目。')
  }
  return result as unknown as PluginGeneratorPublishResult
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

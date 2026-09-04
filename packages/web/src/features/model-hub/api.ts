import { api } from '../../api.js'

export interface HubCatalogEntry {
  id: string
  name: string
  badge?: string
  description: string
  signup: { text: string; url: string }
  baseUrl: string
  api: string
  providerKind: string
  credentialMode: 'api-key' | 'environment' | 'none'
  modelPlaceholder?: string
  popularModels: string[]
  defaults?: { contextWindow?: number; maxTokens?: number; webSearchBaseUrl?: string }
  balance?: string
}

export interface HubCatalogState {
  catalog: { schemaVersion: 1; version: string; providers: HubCatalogEntry[] }
  source: 'remote' | 'cache' | 'bundled'
  checkedAt: string
  notice?: string
}

export interface HubProvider {
  id: string
  workspaceId: string
  kind: 'builtin' | 'custom' | 'local'
  catalogRef?: string
  name: string
  baseUrl: string
  api: string
  providerKind: string
  credentialEnvName?: string
  modelCount: number
  credentialConfigured: boolean
  /** Last four characters of the stored key, for telling saved keys apart. */
  credentialTail?: string
  assignedCount: number
  balanceSupported: boolean
  signup?: { text: string; url: string }
  balanceKind?: string
}

export interface HubProfile {
  id: string
  workspaceId: string
  displayName: string
  modelId: string
  baseUrl: string
  api: string
  providerId?: string
  origin?: string
  isDefault: boolean
  settings: Record<string, unknown>
  capabilities?: { tools: string; json: string }
  probedAt?: string
  createdAt: string
  updatedAt: string
}

export interface DiscoveredModel {
  id: string
  displayName?: string
  contextLength?: number
  inputTypes?: string[]
  outputTypes?: string[]
  reasoning?: boolean
}

export interface ModelAssignmentRef {
  scope: string
  scopeId: string
  modelProfileId: string
}

export interface SyncOutcome {
  added: DiscoveredModel[]
  removed: Array<{ id: string; modelId: string }>
  changed: Array<{ modelId: string; profileId?: string; patch: Partial<Pick<DiscoveredModel, 'contextLength' | 'inputTypes' | 'outputTypes' | 'reasoning'>> }>
  unchanged: number
}

const enc = encodeURIComponent

export async function loadCatalog(signal?: AbortSignal): Promise<HubCatalogState> {
  return api<HubCatalogState>('/api/model-provider-catalog', signal === undefined ? undefined : { signal })
}

export async function refreshCatalog(): Promise<HubCatalogState> {
  return api<HubCatalogState>('/api/model-provider-catalog/refresh', { method: 'POST' })
}

export async function listProviders(workspaceId: string): Promise<HubProvider[]> {
  const result = await api<{ items: HubProvider[] }>(`/api/workspaces/${enc(workspaceId)}/model-providers`)
  return result.items
}

export async function saveProvider(
  workspaceId: string,
  input: {
    id?: string
    name: string
    baseUrl: string
    api: string
    providerKind: string
    catalogRef?: string
    apiKey?: string
    credentialEnvName?: string | null
    clearCredential?: boolean
  },
): Promise<HubProvider> {
  const result = await api<{ provider: HubProvider }>(`/api/workspaces/${enc(workspaceId)}/model-providers`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
  return result.provider
}

export async function deleteProvider(workspaceId: string, providerId: string): Promise<void> {
  await api<unknown>(`/api/workspaces/${enc(workspaceId)}/model-providers/${enc(providerId)}`, { method: 'DELETE' })
}

export async function testProvider(workspaceId: string, providerId: string): Promise<DiscoveredModel[]> {
  const result = await api<{ items: DiscoveredModel[] }>(
    `/api/workspaces/${enc(workspaceId)}/model-providers/${enc(providerId)}/test`,
    { method: 'POST' },
  )
  return result.items
}

export async function importModels(
  workspaceId: string,
  providerId: string,
  models: DiscoveredModel[],
): Promise<{ created: number; updated: number }> {
  return api<{ created: number; updated: number }>(
    `/api/workspaces/${enc(workspaceId)}/model-providers/${enc(providerId)}/import`,
    { method: 'POST', body: JSON.stringify({ models }) },
  )
}

export async function syncProvider(workspaceId: string, providerId: string): Promise<SyncOutcome> {
  return api<SyncOutcome>(`/api/workspaces/${enc(workspaceId)}/model-providers/${enc(providerId)}/sync`, { method: 'POST' })
}

export async function fetchBalance(workspaceId: string, providerId: string): Promise<{ lines: string[]; asOf: string }> {
  return api<{ lines: string[]; asOf: string }>(
    `/api/workspaces/${enc(workspaceId)}/model-providers/${enc(providerId)}/balance`,
    { method: 'POST' },
  )
}

export async function listProfiles(workspaceId: string): Promise<{ profiles: HubProfile[]; assignments: ModelAssignmentRef[] }> {
  const result = await api<{ items: HubProfile[]; assignments: ModelAssignmentRef[] }>(`/api/workspaces/${enc(workspaceId)}/model-profiles`)
  return { profiles: result.items, assignments: result.assignments ?? [] }
}

export async function removeProfile(workspaceId: string, profileId: string): Promise<void> {
  await api<unknown>(`/api/workspaces/${enc(workspaceId)}/model-profiles/${enc(profileId)}`, { method: 'DELETE' })
}


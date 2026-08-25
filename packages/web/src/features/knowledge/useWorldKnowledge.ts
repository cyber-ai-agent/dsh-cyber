import { useCallback, useEffect, useRef, useState } from 'react'

import { ApiError, api, jsonBody } from '../../api.js'
import { subscribeWorldLive } from '../../world-live-client.js'

export type KnowledgeCollectionOrigin = 'folder' | 'zip' | 'manual' | 'web' | 'artifact'
export type KnowledgeDocumentOrigin = 'upload' | 'paste' | 'web' | 'filesystem' | 'artifact'
export type KnowledgeDocumentStatus = 'pending' | 'indexed' | 'failed' | 'missing'

export interface KnowledgeCollection {
  id: string
  worldId: string
  name: string
  description?: string
  origin: KnowledgeCollectionOrigin
  relativeRoot: string
  documentCount: number
  indexedDocumentCount?: number
  createdAt: string
  updatedAt: string
}

export interface KnowledgeDocument {
  id: string
  workspaceId: string
  worldId: string
  collectionId?: string
  relativePath: string
  title: string
  mimeType: string
  byteLength: number
  sha256: string
  origin: KnowledgeDocumentOrigin
  sourceUrl?: string
  artifactId?: string
  status: KnowledgeDocumentStatus
  chunkCount: number
  createdAt: string
  updatedAt: string
  indexedAt?: string
}

export interface KnowledgeSearchResult {
  id: string
  worldId: string
  documentId: string
  chunkId?: string
  ordinal?: number
  title: string
  relativePath: string
  snippet: string
  score?: number
  sourceUrl?: string
  status?: KnowledgeDocumentStatus
  collectionName?: string
  updatedAt?: string
}

export interface KnowledgeLibrarySnapshot {
  collections: KnowledgeCollection[]
  documents: KnowledgeDocument[]
}

export type KnowledgeMutation = 'file' | 'pack' | 'paste' | 'web' | 'scan'

interface KnowledgeApiErrorBody {
  error?: {
    code?: string
    message?: string
  }
}

interface UseWorldKnowledgeOptions {
  worldId: string
  enabled?: boolean
  initialCollections?: KnowledgeCollection[]
  initialDocuments?: KnowledgeDocument[]
}

const EMPTY_COLLECTIONS: KnowledgeCollection[] = []
const EMPTY_DOCUMENTS: KnowledgeDocument[] = []

export interface UseWorldKnowledgeResult extends KnowledgeLibrarySnapshot {
  loading: boolean
  searching: boolean
  busyAction?: KnowledgeMutation
  error?: string
  searchError?: string
  searchQuery: string
  searchResults: KnowledgeSearchResult[]
  reload(): Promise<void>
  search(query: string): Promise<KnowledgeSearchResult[]>
  clearSearch(): void
  importFile(file: File): Promise<void>
  importPack(files: File[], collectionName?: string): Promise<void>
  createFromText(input: { title: string; content: string }): Promise<void>
  importFromWeb(input: { url: string; title?: string }): Promise<void>
  rescan(): Promise<void>
}

const collectionOrigins = new Set<KnowledgeCollectionOrigin>(['folder', 'zip', 'manual', 'web', 'artifact'])
const documentOrigins = new Set<KnowledgeDocumentOrigin>(['upload', 'paste', 'web', 'filesystem', 'artifact'])
const documentStatuses = new Set<KnowledgeDocumentStatus>(['pending', 'indexed', 'failed', 'missing'])

export function knowledgeLibraryPath(worldId: string, suffix = ''): string {
  return `/api/worlds/${encodeURIComponent(worldId)}/knowledge/library${suffix}`
}

export function knowledgeSearchPath(worldId: string, query: string, limit = 8): string {
  const params = new URLSearchParams({ q: query, limit: String(limit) })
  return `/api/worlds/${encodeURIComponent(worldId)}/knowledge/search?${params.toString()}`
}

export function normalizeKnowledgeCollection(value: unknown, worldId: string): KnowledgeCollection | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.name !== 'string') return undefined
  if (typeof value.worldId === 'string' && value.worldId !== worldId) return undefined
  const origin = asEnum(value.origin, collectionOrigins, 'manual')
  return {
    id: value.id,
    worldId,
    name: value.name,
    ...(typeof value.description === 'string' ? { description: value.description } : {}),
    origin,
    relativeRoot: typeof value.relativeRoot === 'string' ? value.relativeRoot : '',
    documentCount: asNumber(value.documentCount),
    ...(typeof value.indexedDocumentCount === 'number' ? { indexedDocumentCount: value.indexedDocumentCount } : {}),
    createdAt: asString(value.createdAt),
    updatedAt: asString(value.updatedAt),
  }
}

export function normalizeKnowledgeDocument(value: unknown, worldId: string): KnowledgeDocument | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.title !== 'string') return undefined
  if (typeof value.worldId === 'string' && value.worldId !== worldId) return undefined
  return {
    id: value.id,
    workspaceId: typeof value.workspaceId === 'string' ? value.workspaceId : '',
    worldId,
    ...(typeof value.collectionId === 'string' ? { collectionId: value.collectionId } : {}),
    relativePath: typeof value.relativePath === 'string' ? value.relativePath : '',
    title: value.title,
    mimeType: typeof value.mimeType === 'string' ? value.mimeType : 'text/plain',
    byteLength: asNumber(value.byteLength),
    sha256: typeof value.sha256 === 'string' ? value.sha256 : '',
    origin: asEnum(value.origin, documentOrigins, 'upload'),
    ...(typeof value.sourceUrl === 'string' ? { sourceUrl: value.sourceUrl } : {}),
    ...(typeof value.artifactId === 'string' ? { artifactId: value.artifactId } : {}),
    status: asEnum(value.status, documentStatuses, 'pending'),
    chunkCount: asNumber(value.chunkCount),
    createdAt: asString(value.createdAt),
    updatedAt: asString(value.updatedAt),
    ...(typeof value.indexedAt === 'string' ? { indexedAt: value.indexedAt } : {}),
  }
}

export function normalizeKnowledgeSnapshot(value: unknown, worldId: string): KnowledgeLibrarySnapshot {
  if (Array.isArray(value)) {
    return {
      collections: [],
      documents: value.map((item) => normalizeKnowledgeDocument(item, worldId)).filter(isDefined),
    }
  }
  if (!isRecord(value)) return { collections: [], documents: [] }
  const collections = Array.isArray(value.collections)
    ? value.collections.map((item) => normalizeKnowledgeCollection(item, worldId)).filter(isDefined)
    : []
  const documents = Array.isArray(value.documents)
    ? value.documents.map((item) => normalizeKnowledgeDocument(item, worldId)).filter(isDefined)
    : []
  return { collections, documents }
}

export function normalizeKnowledgeSearchResults(value: unknown, worldId: string): KnowledgeSearchResult[] {
  const source = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.results)
      ? value.results
      : isRecord(value) && Array.isArray(value.items)
        ? value.items
        : []
  return source.map((item) => normalizeKnowledgeSearchResult(item, worldId)).filter(isDefined)
}

function normalizeKnowledgeSearchResult(value: unknown, worldId: string): KnowledgeSearchResult | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.worldId === 'string' && value.worldId !== worldId) return undefined
  const documentId = typeof value.documentId === 'string' ? value.documentId : typeof value.document_id === 'string' ? value.document_id : undefined
  const chunkId = typeof value.chunkId === 'string' ? value.chunkId : undefined
  const ordinal = typeof value.ordinal === 'number' ? value.ordinal : undefined
  const id = typeof value.id === 'string' ? value.id : chunkId ?? `${documentId}:${ordinal ?? 0}`
  if (id === undefined || documentId === undefined) return undefined
  return {
    id,
    worldId,
    documentId,
    ...(chunkId === undefined ? {} : { chunkId }),
    ...(ordinal === undefined ? {} : { ordinal }),
    title: typeof value.title === 'string' ? value.title : '未命名资料',
    relativePath: typeof value.relativePath === 'string' ? value.relativePath : '',
    snippet: typeof value.snippet === 'string' ? value.snippet : typeof value.content === 'string' ? value.content.slice(0, 260) : '',
    ...(typeof value.score === 'number' ? { score: value.score } : {}),
    ...(typeof value.sourceUrl === 'string' ? { sourceUrl: value.sourceUrl } : {}),
    ...(documentStatuses.has(value.status as KnowledgeDocumentStatus) ? { status: value.status as KnowledgeDocumentStatus } : {}),
    ...(typeof value.collectionName === 'string' ? { collectionName: value.collectionName } : {}),
    ...(typeof value.updatedAt === 'string' ? { updatedAt: value.updatedAt } : {}),
  }
}

export function useWorldKnowledge(options: UseWorldKnowledgeOptions): UseWorldKnowledgeResult {
  const { worldId, enabled = true } = options
  const initialCollections = options.initialCollections ?? EMPTY_COLLECTIONS
  const initialDocuments = options.initialDocuments ?? EMPTY_DOCUMENTS
  const [collections, setCollections] = useState<KnowledgeCollection[]>(initialCollections)
  const [documents, setDocuments] = useState<KnowledgeDocument[]>(initialDocuments)
  const [loading, setLoading] = useState(enabled)
  const [searching, setSearching] = useState(false)
  const [busyAction, setBusyAction] = useState<KnowledgeMutation>()
  const [error, setError] = useState<string>()
  const [searchError, setSearchError] = useState<string>()
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<KnowledgeSearchResult[]>([])
  const requestGeneration = useRef(0)

  const reload = useCallback(async () => {
    if (!enabled) {
      setLoading(false)
      return
    }
    const generation = ++requestGeneration.current
    setLoading(true)
    setError(undefined)
    try {
      const response = await api<unknown>(knowledgeLibraryPath(worldId))
      const snapshot = normalizeKnowledgeSnapshot(response, worldId)
      if (generation !== requestGeneration.current) return
      setCollections(snapshot.collections)
      setDocuments(snapshot.documents)
    } catch (cause) {
      if (generation === requestGeneration.current) setError(toUserMessage(cause, '知识库暂时无法读取，请稍后重试。'))
    } finally {
      if (generation === requestGeneration.current) setLoading(false)
    }
  }, [enabled, worldId])

  useEffect(() => {
    setCollections(initialCollections)
    setDocuments(initialDocuments)
    setSearchQuery('')
    setSearchResults([])
    setSearchError(undefined)
    void reload()
  }, [initialCollections, initialDocuments, reload])

  useEffect(() => {
    if (!enabled) return undefined
    return subscribeWorldLive(worldId, 'world-knowledge', () => { void reload() })
  }, [enabled, reload, worldId])

  const runMutation = useCallback(async (action: KnowledgeMutation, request: () => Promise<unknown>) => {
    if (!enabled) throw new Error('当前世界暂未连接本地知识库。')
    setBusyAction(action)
    setError(undefined)
    try {
      await request()
      await reload()
    } catch (cause) {
      const message = toUserMessage(cause, action === 'scan' ? '重新扫描失败，请稍后重试。' : '知识库操作失败，请检查内容后重试。')
      setError(message)
      throw new Error(message)
    } finally {
      setBusyAction(undefined)
    }
  }, [enabled, reload])

  const search = useCallback(async (query: string) => {
    const trimmed = query.trim()
    setSearchQuery(trimmed)
    setSearchError(undefined)
    if (trimmed.length === 0) {
      setSearchResults([])
      return []
    }
    if (!enabled) {
      setSearchResults([])
      return []
    }
    setSearching(true)
    try {
      const response = await api<unknown>(knowledgeSearchPath(worldId, trimmed))
      const results = normalizeKnowledgeSearchResults(response, worldId)
      setSearchResults(results)
      return results
    } catch (cause) {
      const message = toUserMessage(cause, '暂时无法搜索知识库，请稍后重试。')
      setSearchError(message)
      setSearchResults([])
      return []
    } finally {
      setSearching(false)
    }
  }, [enabled, worldId])

  const clearSearch = useCallback(() => {
    setSearchQuery('')
    setSearchResults([])
    setSearchError(undefined)
  }, [])

  const importFile = useCallback(async (file: File) => {
    await runMutation('file', () => uploadKnowledgeFiles(worldId, [file], 'upload'))
  }, [runMutation, worldId])

  const importPack = useCallback(async (files: File[], collectionName?: string) => {
    await runMutation('pack', () => uploadKnowledgeFiles(worldId, files, files.length === 1 && files[0]?.name.toLocaleLowerCase().endsWith('.zip') ? 'zip' : 'folder', collectionName))
  }, [runMutation, worldId])

  const createFromText = useCallback(async (input: { title: string; content: string }) => {
    await runMutation('paste', () => api<unknown>(knowledgeLibraryPath(worldId, '/paste'), jsonBody({ title: input.title.trim(), text: input.content })))
  }, [runMutation, worldId])

  const importFromWeb = useCallback(async (input: { url: string; title?: string }) => {
    const url = input.url.trim()
    if (!url) throw new Error('请输入网页地址。')
    await runMutation('web', () => api<unknown>(knowledgeLibraryPath(worldId, '/web'), jsonBody({
      url,
      ...(input.title?.trim() ? { title: input.title.trim() } : {}),
    })))
  }, [runMutation, worldId])

  const rescan = useCallback(async () => {
    await runMutation('scan', () => api<unknown>(knowledgeLibraryPath(worldId, '/scan'), jsonBody({})))
  }, [runMutation, worldId])

  return {
    collections,
    documents,
    loading,
    searching,
    ...(busyAction === undefined ? {} : { busyAction }),
    ...(error === undefined ? {} : { error }),
    ...(searchError === undefined ? {} : { searchError }),
    searchQuery,
    searchResults,
    reload,
    search,
    clearSearch,
    importFile,
    importPack,
    createFromText,
    importFromWeb,
    rescan,
  }
}

async function uploadKnowledgeFiles(worldId: string, files: File[], origin: 'upload' | 'folder' | 'zip', collectionName?: string): Promise<unknown> {
  if (files.length === 0) throw new Error('请选择要导入的文件。')
  const form = new FormData()
  const relativePaths = files.map((file) => {
    const candidate = file as File & { webkitRelativePath?: string }
    return candidate.webkitRelativePath || file.name
  })
  files.forEach((file) => form.append('files', file, file.name))
  form.append('relativePaths', JSON.stringify(relativePaths))
  form.append('origin', origin)
  if (collectionName?.trim()) form.append('collectionName', collectionName.trim())
  return requestForm(knowledgeLibraryPath(worldId, '/import'), form)
}

async function requestForm(path: string, body: FormData): Promise<unknown> {
  const response = await fetch(path, { method: 'POST', body })
  if (!response.ok) {
    const payload = await response.json().catch(() => undefined) as KnowledgeApiErrorBody | undefined
    throw new ApiError(response.status, payload?.error?.message ?? `Request failed: ${response.status}`, payload?.error?.code)
  }
  return response.json().catch(() => undefined)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function asEnum<T extends string>(value: unknown, allowed: Set<T>, fallback: T): T {
  return typeof value === 'string' && allowed.has(value as T) ? value as T : fallback
}

function toUserMessage(cause: unknown, fallback: string): string {
  if (cause instanceof ApiError && cause.status === 404) return '当前服务还没有启用知识库，请稍后再试。'
  if (cause instanceof Error && /[\u3400-\u9fff]/u.test(cause.message) && !cause.message.startsWith('Request failed:')) return cause.message
  return fallback
}

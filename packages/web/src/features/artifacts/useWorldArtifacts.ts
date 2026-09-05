import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  WorldArtifact,
  WorldArtifactEvidenceGrade,
  WorldArtifactKind,
  WorldArtifactStatus,
  WorldArtifactVersion,
  WorldArtifactVersionEvidence,
} from '@dsh-cyber/contracts'

import { api } from '../../api.js'
import { subscribeWorldLive } from '../../world-live-client.js'

export type ArtifactKindFilter = 'all' | WorldArtifactKind | 'text' | 'json'

export interface ArtifactFileEntry {
  path: string
  title?: string
  kind?: WorldArtifactKind | 'text' | 'json'
  mimeType?: string
  byteLength?: number
  content?: string
  src?: string
}

export interface ArtifactPreviewPayload {
  content?: string
  src?: string
  mimeType?: string
  byteLength?: number
  files?: ArtifactFileEntry[]
  version?: WorldArtifactVersion
}

export interface ArtifactRecord extends WorldArtifact {
  currentVersionInfo?: WorldArtifactVersion
  versions?: WorldArtifactVersion[]
  preview?: ArtifactPreviewPayload
  files?: ArtifactFileEntry[]
  /** What the host can prove about each version's origin, detail view only. */
  evidence?: WorldArtifactVersionEvidence[]
}

const EVIDENCE_GRADES: readonly WorldArtifactEvidenceGrade[] = [
  'host-observed', 'shared-window', 'manifest-declared', 'unproven-window', 'owner-published', 'unknown',
]

/**
 * One short sentence per grade. Only `host-observed` may read as proof; every
 * other line has to say plainly what the host could not establish.
 */
export function artifactEvidenceLabel(grade: WorldArtifactEvidenceGrade): { label: string; hint: string } {
  const labels: Record<WorldArtifactEvidenceGrade, { label: string; hint: string }> = {
    'host-observed': { label: '宿主已核实落盘', hint: '本次运行执行期间，宿主观察到这份内容写入当前世界工作目录，同一时刻没有其他运行。' },
    'shared-window': { label: '归属未确认', hint: '宿主观察到了写入，但同一时刻还有其他运行，或文件在运行结束后又被改动，无法确定由哪次运行产生。' },
    'manifest-declared': { label: '按角色清单登记', hint: '文件真实存在并已校验复制，但宿主没有这次运行的写入观察记录，无法证明由本次运行产生。' },
    'unproven-window': { label: '仅按时间匹配，未验证', hint: '只按运行的开始与结束时间挑选了这个文件，并发情况下可能属于另一次运行。' },
    'owner-published': { label: '由你手动发布', hint: '这份产物由用户或宿主直接发布，不涉及角色运行归属。' },
    unknown: { label: '来源记录已缺失', hint: '宿主没有保留这次发布的观察记录，无法说明它的归属。' },
  }
  return labels[grade]
}

function normalizeEvidence(value: unknown): WorldArtifactVersionEvidence | undefined {
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as Record<string, unknown>
  const grade = EVIDENCE_GRADES.find((known) => known === candidate.grade)
  if (typeof candidate.version !== 'number' || grade === undefined) return undefined
  return {
    version: candidate.version,
    grade,
    // Proof is a host statement, never inferred in the browser: an unknown
    // payload must degrade to "not proven".
    proven: candidate.proven === true && grade === 'host-observed',
    ...(typeof candidate.observedAt === 'string' ? { observedAt: candidate.observedAt } : {}),
    ...(typeof candidate.contentMatchesObservation === 'boolean' ? { contentMatchesObservation: candidate.contentMatchesObservation } : {}),
    ...(Array.isArray(candidate.concurrentRunIds) ? { concurrentRunIds: candidate.concurrentRunIds.filter((id): id is string => typeof id === 'string') } : {}),
    ...(typeof candidate.scanTruncated === 'boolean' ? { scanTruncated: candidate.scanTruncated } : {}),
  }
}

export interface ArtifactListResponse {
  items?: unknown
  artifacts?: unknown
}

export interface ArtifactMutationInput {
  workspaceId: string
  title: string
  description?: string
  kind: WorldArtifactKind
  sourceRelativePath: string
  entrypoint?: string
}

interface ArtifactReferenceResponse {
  artifact?: unknown
  item?: unknown
}

function worldArtifactsPath(worldId: string, suffix = ''): string {
  return `/api/worlds/${encodeURIComponent(worldId)}/artifacts${suffix}`
}

function artifactPath(worldId: string, artifactId: string, suffix = ''): string {
  return `${worldArtifactsPath(worldId, `/${encodeURIComponent(artifactId)}`)}${suffix}`
}

export function artifactFileUrl(worldId: string, artifactId: string, version?: number, selectedPath?: string): string {
  return artifactPreviewUrl(worldId, artifactId, version, selectedPath)
}

export function artifactPreviewUrl(worldId: string, artifactId: string, version?: number, selectedPath?: string): string {
  const params = new URLSearchParams()
  if (selectedPath !== undefined) params.set('path', selectedPath)
  const query = params.size === 0 ? '' : `?${params.toString()}`
  const pathVersion = version === undefined ? '' : `/${encodeURIComponent(String(version))}`
  return artifactPath(worldId, artifactId, `/preview${pathVersion}${query}`)
}

export function artifactKindLabel(kind: WorldArtifactKind | 'text' | 'json'): string {
  const labels: Record<WorldArtifactKind | 'text' | 'json', string> = {
    image: '图片',
    html: '网页',
    markdown: 'Markdown',
    document: '文档',
    code: '代码',
    data: '数据',
    archive: '压缩包',
    project: '项目',
    other: '文件',
    text: '文本',
    json: 'JSON',
  }
  return labels[kind]
}

export function artifactKindFromPath(path: string, mimeType?: string): WorldArtifactKind | 'text' | 'json' {
  const lower = `${path} ${mimeType ?? ''}`.toLocaleLowerCase()
  if (lower.includes('json')) return 'json'
  if (lower.includes('markdown') || /\.(md|markdown)$/i.test(path)) return 'markdown'
  if (lower.includes('html') || /\.(html?|xhtml)$/i.test(path)) return 'html'
  if (lower.includes('pdf')) return 'document'
  if (lower.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg|avif)$/i.test(path)) return 'image'
  if (lower.includes('javascript') || lower.includes('typescript') || lower.includes('text/css') || lower.includes('text/x-') || /\.(ts|tsx|js|jsx|css|scss|html?|py|java|go|rs|sql|sh|xml|yml|yaml)$/i.test(path)) return 'code'
  if (lower.startsWith('text/') || /\.(txt|log|csv)$/i.test(path)) return 'text'
  return 'other'
}

export function normalizeArtifact(value: unknown): ArtifactRecord | undefined {
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as Record<string, unknown>
  if (typeof candidate.id !== 'string' || typeof candidate.title !== 'string' || typeof candidate.worldId !== 'string') return undefined
  const kind = candidate.kind
  if (typeof kind !== 'string') return undefined
  const status = candidate.status
  const currentVersion = typeof candidate.currentVersion === 'number' ? candidate.currentVersion : 1
  const currentVersionInfo = normalizeVersion(candidate.currentVersionInfo ?? candidate.currentVersionRecord ?? candidate.version)
  const versions = Array.isArray(candidate.versions)
    ? candidate.versions.map(normalizeVersion).filter((version): version is WorldArtifactVersion => version !== undefined)
    : undefined
  const preview = normalizePreview(candidate.preview)
  const files = Array.isArray(candidate.files)
    ? candidate.files.map(normalizeFile).filter((file): file is ArtifactFileEntry => file !== undefined)
    : preview?.files
  return {
    id: candidate.id,
    workspaceId: typeof candidate.workspaceId === 'string' ? candidate.workspaceId : '',
    worldId: candidate.worldId,
    title: candidate.title,
    ...(typeof candidate.description === 'string' ? { description: candidate.description } : {}),
    kind: kind as WorldArtifactKind,
    status: status === 'archived' || status === 'missing' ? status : 'active',
    currentVersion,
    createdByKind: candidate.createdByKind === 'owner' ? 'owner' : 'employee',
    createdById: typeof candidate.createdById === 'string' ? candidate.createdById : '',
    createdAt: typeof candidate.createdAt === 'string' ? candidate.createdAt : new Date(0).toISOString(),
    updatedAt: typeof candidate.updatedAt === 'string' ? candidate.updatedAt : new Date(0).toISOString(),
    ...(currentVersionInfo === undefined ? {} : { currentVersionInfo }),
    ...(versions === undefined ? {} : { versions }),
    ...(preview === undefined ? {} : { preview }),
    ...(files === undefined ? {} : { files }),
  }
}

function normalizeVersion(value: unknown): WorldArtifactVersion | undefined {
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as Record<string, unknown>
  if (typeof candidate.artifactId !== 'string' || typeof candidate.version !== 'number' || typeof candidate.relativePath !== 'string') return undefined
  return {
    artifactId: candidate.artifactId,
    version: candidate.version,
    relativePath: candidate.relativePath,
    ...(typeof candidate.entrypoint === 'string' ? { entrypoint: candidate.entrypoint } : {}),
    ...(typeof candidate.mimeType === 'string' ? { mimeType: candidate.mimeType } : {}),
    byteLength: typeof candidate.byteLength === 'number' ? candidate.byteLength : 0,
    sha256: typeof candidate.sha256 === 'string' ? candidate.sha256 : '',
    ...(typeof candidate.sourceRelativePath === 'string' ? { sourceRelativePath: candidate.sourceRelativePath } : {}),
    ...(typeof candidate.employeeId === 'string' ? { employeeId: candidate.employeeId } : {}),
    ...(typeof candidate.sessionId === 'string' ? { sessionId: candidate.sessionId } : {}),
    ...(typeof candidate.workTurnId === 'string' ? { workTurnId: candidate.workTurnId } : {}),
    ...(typeof candidate.agentRunId === 'string' ? { agentRunId: candidate.agentRunId } : {}),
    createdAt: typeof candidate.createdAt === 'string' ? candidate.createdAt : new Date(0).toISOString(),
  }
}

function normalizeFile(value: unknown): ArtifactFileEntry | undefined {
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as Record<string, unknown>
  if (typeof candidate.path !== 'string') return undefined
  return {
    path: candidate.path,
    ...(typeof candidate.title === 'string' ? { title: candidate.title } : {}),
    ...(typeof candidate.kind === 'string' ? { kind: candidate.kind as Exclude<ArtifactFileEntry['kind'], undefined> } : {}),
    ...(typeof candidate.mimeType === 'string' ? { mimeType: candidate.mimeType } : {}),
    ...(typeof candidate.byteLength === 'number' ? { byteLength: candidate.byteLength } : {}),
    ...(typeof candidate.content === 'string' ? { content: candidate.content } : {}),
    ...(typeof candidate.src === 'string' ? { src: candidate.src } : {}),
  }
}

function normalizePreview(value: unknown): ArtifactPreviewPayload | undefined {
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as Record<string, unknown>
  const files = Array.isArray(candidate.files)
    ? candidate.files.map(normalizeFile).filter((file): file is ArtifactFileEntry => file !== undefined)
    : undefined
  const version = normalizeVersion(candidate.version)
  if (typeof candidate.content !== 'string' && typeof candidate.src !== 'string' && files === undefined && version === undefined) return undefined
  return {
    ...(typeof candidate.content === 'string' ? { content: candidate.content } : {}),
    ...(typeof candidate.src === 'string' ? { src: candidate.src } : {}),
    ...(typeof candidate.mimeType === 'string' ? { mimeType: candidate.mimeType } : {}),
    ...(typeof candidate.byteLength === 'number' ? { byteLength: candidate.byteLength } : {}),
    ...(files === undefined ? {} : { files }),
    ...(version === undefined ? {} : { version }),
  }
}

export async function listWorldArtifacts(worldId: string, filter: { query?: string; kind?: ArtifactKindFilter; status?: WorldArtifactStatus } = {}): Promise<ArtifactRecord[]> {
  const params = new URLSearchParams()
  if (filter.query?.trim()) params.set('search', filter.query.trim())
  if (filter.kind && filter.kind !== 'all' && filter.kind !== 'text' && filter.kind !== 'json') params.set('kind', filter.kind)
  if (filter.status) params.set('status', filter.status)
  const response = await api<ArtifactListResponse>(`${worldArtifactsPath(worldId)}${params.size > 0 ? `?${params.toString()}` : ''}`)
  const values = Array.isArray(response.items) ? response.items : Array.isArray(response.artifacts) ? response.artifacts : []
  return values.map(normalizeArtifact).filter((artifact): artifact is ArtifactRecord => artifact !== undefined)
}

export async function getWorldArtifact(worldId: string, artifactId: string): Promise<ArtifactRecord> {
  const response = await api<ArtifactRecord | ArtifactReferenceResponse>(artifactPath(worldId, artifactId))
  const value = normalizeArtifactView(response)
  if (value === undefined) throw new Error('产物信息格式无效')
  return value
}

export async function fetchArtifactPreview(worldId: string, artifact: ArtifactRecord, version?: number, selectedPath?: string): Promise<ArtifactPreviewPayload> {
  const selectedKind = selectedPath === undefined ? artifact.kind : artifactKindFromPath(selectedPath)
  const mimeTypeHint = selectedPath === undefined ? artifact.currentVersionInfo?.mimeType ?? mimeTypeForKind(artifact.kind) : undefined
  // HTML must remain a direct, controlled preview response. Fetching it into a
  // blob URL would bypass the host response CSP and make origin reasoning less
  // obvious; the iframe itself supplies the required sandbox boundary.
  if (selectedKind === 'html' || mimeTypeHint?.includes('html')) return { src: artifactPreviewUrl(worldId, artifact.id, version, selectedPath), mimeType: 'text/html' }
  if (selectedKind === 'image' || mimeTypeHint?.startsWith('image/') || mimeTypeHint === 'application/pdf' || selectedPath?.toLowerCase().endsWith('.pdf')) return { src: artifactPreviewUrl(worldId, artifact.id, version, selectedPath), ...(mimeTypeHint === undefined ? {} : { mimeType: mimeTypeHint }) }
  const response = await fetch(artifactPreviewUrl(worldId, artifact.id, version, selectedPath))
  if (!response.ok) throw new Error(`无法读取产物预览（${response.status}）`)
  const mimeType = response.headers.get('content-type') ?? artifact.currentVersionInfo?.mimeType
  if (mimeType?.includes('application/json')) {
    const body = await response.json() as unknown
    // Only the project-root endpoint returns a host-owned tree. A JSON file
    // may contain arbitrary keys such as content/src/entries; all are data.
    if (artifact.kind === 'project' && selectedPath === undefined && isProjectTree(body)) return { files: body.entries.map((entry) => ({ path: entry.path, ...(typeof entry.byteLength === 'number' ? { byteLength: entry.byteLength } : {}) })), mimeType: 'application/json' }
    return { content: JSON.stringify(body, null, 2), mimeType: 'application/json' }
  }
  if (mimeType && !mimeType.startsWith('text/') && !/(?:^application\/(?:json|javascript|ecmascript|xml)|\+(?:json|xml))(?:;|$)/i.test(mimeType)) {
    await response.body?.cancel()
    return { src: artifactPreviewUrl(worldId, artifact.id, version, selectedPath), mimeType }
  }
  return { content: await response.text(), ...(mimeType === undefined ? {} : { mimeType }) }
}

function isProjectTree(value: unknown): value is { entries: Array<{ path: string; byteLength?: number }> } {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { entries?: unknown }).entries)) return false
  return (value as { entries: unknown[] }).entries.every((entry) => entry !== null && typeof entry === 'object' && typeof (entry as { path?: unknown }).path === 'string')
}

export function normalizeArtifactView(value: unknown): ArtifactRecord | undefined {
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as Record<string, unknown>
  const artifact = normalizeArtifact(candidate.artifact ?? candidate.item ?? value)
  if (artifact === undefined) return undefined
  const evidence = Array.isArray(candidate.evidence)
    ? candidate.evidence.map(normalizeEvidence).filter((entry): entry is WorldArtifactVersionEvidence => entry !== undefined)
    : undefined
  const versions = Array.isArray(candidate.versions)
    ? candidate.versions.map(normalizeVersion).filter((version): version is WorldArtifactVersion => version !== undefined)
    : artifact.versions
  if (versions === undefined) return { ...artifact, ...(evidence === undefined ? {} : { evidence }) }
  const currentVersionInfo = versions.find((version) => version.version === artifact.currentVersion)
  return {
    ...artifact,
    versions,
    ...(evidence === undefined ? {} : { evidence }),
    ...(currentVersionInfo === undefined ? {} : { currentVersionInfo }),
  }
}

function mimeTypeForKind(kind: WorldArtifactKind): string | undefined {
  if (kind === 'html') return 'text/html'
  if (kind === 'image') return 'image/*'
  if (kind === 'data') return 'application/json'
  if (kind === 'markdown') return 'text/markdown'
  if (kind === 'code') return 'text/plain'
  return undefined
}

export function useWorldArtifacts({ worldId, enabled = true, initialArtifacts = [] }: { worldId: string; enabled?: boolean; initialArtifacts?: ArtifactRecord[] }) {
  const [artifacts, setArtifacts] = useState<ArtifactRecord[]>(initialArtifacts)
  const [loading, setLoading] = useState(enabled && initialArtifacts.length === 0)
  const [error, setError] = useState<string>()
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<ArtifactKindFilter>('all')
  const [selectedArtifactId, setSelectedArtifactId] = useState<string>()
  const requestGeneration = useRef(0)
  const currentScope = useRef('')
  const currentWorld = useRef(worldId)
  currentWorld.current = worldId
  const scope = JSON.stringify([worldId, enabled, query, kind])
  currentScope.current = scope

  useEffect(() => {
    setArtifacts(initialArtifacts.filter((item) => item.worldId === worldId))
    setSelectedArtifactId(undefined)
    setError(undefined)
    setQuery('')
    setKind('all')
  }, [worldId])

  const reload = useCallback(async () => {
    if (!enabled) return
    const generation = ++requestGeneration.current
    const isCurrent = () => generation === requestGeneration.current && currentScope.current === scope
    setLoading(true)
    setError(undefined)
    try {
      const next = await listWorldArtifacts(worldId, { query, kind })
      if (isCurrent()) setArtifacts(next.filter((item) => item.worldId === worldId))
    } catch (cause) {
      if (isCurrent()) setError(cause instanceof Error ? cause.message : '产物列表加载失败')
    } finally {
      if (isCurrent()) setLoading(false)
    }
  }, [enabled, kind, query, worldId, scope])

  useEffect(() => {
    if (!enabled) return
    void reload()
    return () => { requestGeneration.current += 1 }
  }, [enabled, reload])

  useEffect(() => {
    if (!enabled || typeof EventSource === 'undefined') return
    return subscribeWorldLive(worldId, 'world-artifact', () => { void reload() })
  }, [enabled, reload, worldId])

  useEffect(() => {
    if (!enabled || selectedArtifactId === undefined) return
    const current = artifacts.find((artifact) => artifact.id === selectedArtifactId)
    if (current?.versions !== undefined) return
    let active = true
    void getWorldArtifact(worldId, selectedArtifactId).then((detail) => {
      if (!active) return
      setArtifacts((items) => items.map((item) => item.id === detail.id ? detail : item))
    }).catch((cause) => {
      if (active) setError(cause instanceof Error ? cause.message : '产物详情加载失败')
    })
    return () => { active = false }
  }, [artifacts, enabled, selectedArtifactId, worldId])

  const publishFromWorkspace = useCallback(async (input: ArtifactMutationInput) => {
    const response = await api<ArtifactRecord | ArtifactReferenceResponse>(worldArtifactsPath(worldId, '/publish'), {
      method: 'POST',
      body: JSON.stringify(input),
    })
    const record = normalizeArtifact('artifact' in response ? response.artifact : 'item' in response ? response.item : response)
    if (record === undefined) throw new Error('发布结果格式无效')
    if (currentWorld.current !== worldId) return record
    requestGeneration.current += 1
    setArtifacts((current) => [record, ...current.filter((item) => item.id !== record.id)])
    setSelectedArtifactId(record.id)
    return record
  }, [worldId])

  const rename = useCallback(async (artifactId: string, title: string) => {
    const response = await api<ArtifactRecord | ArtifactReferenceResponse>(artifactPath(worldId, artifactId), { method: 'PATCH', body: JSON.stringify({ title }) })
    const record = normalizeArtifact('artifact' in response ? response.artifact : 'item' in response ? response.item : response)
    if (record === undefined) throw new Error('重命名结果格式无效')
    if (currentWorld.current !== worldId) return record
    requestGeneration.current += 1
    setArtifacts((current) => current.map((item) => item.id === record.id ? record : item))
    return record
  }, [worldId])

  const archive = useCallback(async (artifactId: string) => {
    const response = await api<ArtifactRecord | ArtifactReferenceResponse>(artifactPath(worldId, artifactId, '/archive'), { method: 'POST', body: JSON.stringify({}) })
    const record = normalizeArtifact('artifact' in response ? response.artifact : 'item' in response ? response.item : response)
    if (record === undefined) throw new Error('归档结果格式无效')
    if (currentWorld.current !== worldId) return record
    requestGeneration.current += 1
    setArtifacts((current) => current.map((item) => item.id === record.id ? record : item))
    return record
  }, [worldId])

  const worldArtifacts = useMemo(() => artifacts.filter((artifact) => artifact.worldId === worldId), [artifacts, worldId])
  const filteredArtifacts = useMemo(() => {
    if (kind === 'all') return worldArtifacts
    return worldArtifacts.filter((artifact) => artifact.kind === kind || (kind === 'text' && artifact.kind === 'other') || (kind === 'json' && artifact.kind === 'data'))
  }, [worldArtifacts, kind])

  return { artifacts: filteredArtifacts, allArtifacts: worldArtifacts, loading, error, query, setQuery, kind, setKind, selectedArtifactId, setSelectedArtifactId, reload, publishFromWorkspace, rename, archive }
}

export function useArtifactReferences(worldId: string, artifactRefs: string[]) {
  const [artifacts, setArtifacts] = useState<ArtifactRecord[]>([])
  const [loading, setLoading] = useState(artifactRefs.length > 0)
  const [error, setError] = useState<string>()
  const refKey = artifactRefs.join('|')
  useEffect(() => {
    let current = true
    if (artifactRefs.length === 0) {
      setArtifacts([])
      setLoading(false)
      setError(undefined)
      return () => { current = false }
    }
    setLoading(true)
    setError(undefined)
    void Promise.all(artifactRefs.map((id) => getWorldArtifact(worldId, id).catch(() => undefined))).then((values) => {
      if (!current) return
      setArtifacts(values.filter((value): value is ArtifactRecord => value !== undefined))
      setLoading(false)
    }).catch((cause) => {
      if (!current) return
      setError(cause instanceof Error ? cause.message : '产物卡片加载失败')
      setLoading(false)
    })
    return () => { current = false }
  }, [refKey, worldId])
  return { artifacts, loading, error }
}

import { Archive, ArrowLeft, FileArrowUp, FolderOpen, MagnifyingGlass, Package, Plus, SpinnerGap } from '@phosphor-icons/react'
import { useEffect, useState } from 'react'
import type { World, WorldArtifactKind } from '@dsh-cyber/contracts'
import { formatDateTime } from '../../i18n/format.js'

import { ArtifactDetail } from './ArtifactDetail.js'
import {
  artifactKindLabel,
  useArtifactReferences,
  useWorldArtifacts,
  type ArtifactKindFilter,
  type ArtifactMutationInput,
  type ArtifactRecord,
} from './useWorldArtifacts.js'

export interface ArtifactCenterProps {
  world: World
  demoMode?: boolean
  canAddToKnowledge?: boolean
  focusArtifactId?: string
  onFocusArtifact?(artifactId: string | undefined): void
  initialArtifacts?: ArtifactRecord[]
}

const filters: Array<{ id: ArtifactKindFilter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'image', label: '图片' },
  { id: 'html', label: '网页' },
  { id: 'markdown', label: 'Markdown' },
  { id: 'document', label: '文档' },
  { id: 'project', label: '项目' },
  { id: 'code', label: '代码' },
]

export function ArtifactCenter({ world, demoMode = false, canAddToKnowledge, focusArtifactId, onFocusArtifact, initialArtifacts = [] }: ArtifactCenterProps) {
  const [publishOpen, setPublishOpen] = useState(false)
  const artifactsState = useWorldArtifacts({ worldId: world.id, enabled: !demoMode, initialArtifacts })
  const { artifacts, loading, error, query, setQuery, kind, setKind, selectedArtifactId, setSelectedArtifactId, reload, publishFromWorkspace, rename, archive } = artifactsState
  const selected = artifactsState.allArtifacts.find((artifact) => artifact.id === selectedArtifactId)
  const knowledgeActionAllowed = !demoMode && canAddToKnowledge !== false

  useEffect(() => {
    if (focusArtifactId !== undefined) setSelectedArtifactId(focusArtifactId)
  }, [focusArtifactId, setSelectedArtifactId])

  useEffect(() => {
    onFocusArtifact?.(selectedArtifactId)
  }, [onFocusArtifact, selectedArtifactId])

  if (selected !== undefined) return <ArtifactDetail worldId={world.id} artifact={selected} demoMode={demoMode} canAddToKnowledge={knowledgeActionAllowed} onBack={() => setSelectedArtifactId(undefined)} onRename={async (title) => { await rename(selected.id, title) }} onArchive={async () => { await archive(selected.id) }} />

  return <section className="artifact-center" aria-label="世界产物中心">
    <header className="artifact-center__header">
      <div><h2>世界产物</h2><p>只展示已明确发布、可持续引用的世界文件。</p></div>
      <button type="button" className="artifact-button artifact-button--primary" onClick={() => setPublishOpen(true)}><FileArrowUp size={17} />从工作目录发布</button>
    </header>
    <div className="artifact-center__toolbar">
      <label className="artifact-search"><MagnifyingGlass size={17} /><span className="sr-only">搜索产物</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索产物名称或来源" /></label>
      <nav className="artifact-filters" aria-label="产物类型筛选">{filters.map((filter) => <button type="button" key={filter.id} className={kind === filter.id ? 'is-active' : ''} aria-pressed={kind === filter.id} onClick={() => setKind(filter.id)}>{filter.label}</button>)}</nav>
    </div>
    {error === undefined ? null : <div className="artifact-center__error" role="alert"><strong>产物列表暂时不可用</strong><span>{error}</span><button type="button" onClick={() => void reload()}>重试</button></div>}
    {loading ? <div className="artifact-center__state" role="status"><SpinnerGap size={22} className="spin" /><span>正在加载产物…</span></div> : artifacts.length === 0 ? <ArtifactEmptyState onPublish={() => setPublishOpen(true)} /> : <ul className="artifact-list" aria-label="产物列表">{artifacts.map((artifact) => <ArtifactCard key={artifact.id} artifact={artifact} onOpen={() => setSelectedArtifactId(artifact.id)} />)}</ul>}
    {publishOpen ? <PublishArtifactDialog busy={false} onClose={() => setPublishOpen(false)} onPublish={async (input) => { await publishFromWorkspace({ workspaceId: world.workspaceId, ...input }); setPublishOpen(false) }} /> : null}
  </section>
}

function ArtifactCard({ artifact, onOpen }: { artifact: ArtifactRecord; onOpen(): void }) {
  const version = artifact.currentVersionInfo
  return <li><article className={`artifact-card${artifact.status === 'archived' ? ' is-archived' : ''}`}>
    <button type="button" className="artifact-card__main" onClick={onOpen} aria-label={`打开产物 ${artifact.title}`}>
      <span className="artifact-card__mark" aria-hidden="true">{artifact.kind === 'project' ? <FolderOpen size={22} /> : <Package size={22} />}</span>
      <span className="artifact-card__copy"><strong>{artifact.title}</strong><span>{artifactKindLabel(artifact.kind)} · v{artifact.currentVersion}</span><small>{version?.sourceRelativePath ?? version?.relativePath ?? '已发布产物'} · {formatDate(artifact.updatedAt)}</small></span>
      {artifact.status === 'archived' ? <Archive size={16} className="artifact-card__archived" aria-label="已归档" /> : null}
    </button>
    <div className="artifact-card__actions"><button type="button" onClick={onOpen}>预览</button><button type="button" aria-label={`打开 ${artifact.title} 更多操作`} title="更多操作" onClick={onOpen}>更多</button></div>
  </article></li>
}

function ArtifactEmptyState({ onPublish }: { onPublish(): void }) {
  return <div className="artifact-center__empty"><div className="artifact-center__empty-mark"><Package size={28} /></div><h3>这个世界还没有已发布产物</h3><p>工作目录中的临时文件不会自动出现在这里。完成一轮工作后，从工作目录明确发布，版本和来源才会被记录。</p><button type="button" className="artifact-button artifact-button--primary" onClick={onPublish}><FileArrowUp size={17} />发布第一个产物</button></div>
}

function PublishArtifactDialog({ busy, onClose, onPublish }: { busy: boolean; onClose(): void; onPublish(input: Omit<ArtifactMutationInput, 'workspaceId'>): Promise<void> }) {
  const [title, setTitle] = useState('')
  const [sourceRelativePath, setSourceRelativePath] = useState('')
  const [description, setDescription] = useState('')
  const [kind, setKind] = useState<WorldArtifactKind>('other')
  const [entrypoint, setEntrypoint] = useState('')
  const [error, setError] = useState<string>()
  const [submitting, setSubmitting] = useState(false)
  const submit = async () => {
    if (busy || submitting) return
    if (!title.trim() || !sourceRelativePath.trim()) { setError('请填写名称和工作目录相对路径。'); return }
    setError(undefined)
    setSubmitting(true)
    try { await onPublish({ title: title.trim(), sourceRelativePath: sourceRelativePath.trim(), kind, ...(description.trim() ? { description: description.trim() } : {}), ...(entrypoint.trim() ? { entrypoint: entrypoint.trim() } : {}) }) } catch (cause) { setError(cause instanceof Error ? cause.message : '发布失败') } finally { setSubmitting(false) }
  }
  const isBusy = busy || submitting
  return <div className="artifact-dialog-backdrop" role="presentation"><section className="artifact-dialog" role="dialog" aria-modal="true" aria-labelledby="publish-artifact-heading" aria-busy={isBusy} onKeyDown={(event) => { if (event.key === 'Escape' && !isBusy) onClose() }}><header><div><h2 id="publish-artifact-heading">从工作目录发布</h2><p>只填写当前世界工作目录内的相对路径，服务端会再次校验路径和内容。</p></div><button type="button" className="artifact-icon-button" aria-label="关闭发布产物" disabled={isBusy} onClick={onClose}><ArrowLeft size={17} /></button></header><div className="artifact-dialog__body"><label>产物名称<input value={title} onChange={(event) => setTitle(event.target.value)} autoFocus /></label><label>工作目录相对路径<input value={sourceRelativePath} onChange={(event) => setSourceRelativePath(event.target.value)} placeholder="例如 dist/index.html" /></label><label>类型<select value={kind} onChange={(event) => setKind(event.target.value as WorldArtifactKind)}><option value="image">图片</option><option value="html">网页</option><option value="markdown">Markdown</option><option value="document">文档</option><option value="code">代码</option><option value="data">数据</option><option value="project">项目</option><option value="other">其他</option></select></label><label>入口文件（项目可选）<input value={entrypoint} onChange={(event) => setEntrypoint(event.target.value)} placeholder="例如 dist/index.html" /></label><label>说明（可选）<textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} /></label>{error === undefined ? null : <p className="artifact-dialog__error" role="alert">{error}</p>}</div><footer><button type="button" className="artifact-button" disabled={isBusy} onClick={onClose}>取消</button><button type="button" className="artifact-button artifact-button--primary" disabled={isBusy} onClick={() => void submit()}><FileArrowUp size={16} />{isBusy ? '正在发布…' : '发布产物'}</button></footer></section></div>
}

export function ArtifactReferenceCards({ worldId, artifactRefs, onOpen }: { worldId: string; artifactRefs: string[]; onOpen(artifactId: string): void }) {
  const { artifacts, loading, error } = useArtifactReferences(worldId, artifactRefs)
  if (artifactRefs.length === 0) return null
  if (loading) return <div className="chat-artifact-refs" role="status"><SpinnerGap size={16} className="spin" /><span>正在载入产物卡…</span></div>
  if (artifacts.length === 0) return <div className="chat-artifact-refs chat-artifact-refs--error" role="status"><span>{error ?? '这条消息引用的产物暂不可用。'}</span></div>
  return <section className="chat-artifact-refs" aria-label="消息中的产物"><header><Package size={16} /><strong>已生成 {artifacts.length} 个产物</strong></header><ul>{artifacts.map((artifact) => <li key={artifact.id}><button type="button" onClick={() => onOpen(artifact.id)}><span><strong>{artifact.title}</strong><small>{artifactKindLabel(artifact.kind)} · v{artifact.currentVersion}</small></span><span>预览</span></button></li>)}</ul></section>
}

export function artifactRefsFromMetadata(metadata: Record<string, unknown>): string[] {
  const value = metadata.artifactRefs
  if (!Array.isArray(value)) return []
  return value.map((entry) => typeof entry === 'string' ? entry : entry && typeof entry === 'object' && typeof (entry as { id?: unknown }).id === 'string' ? (entry as { id: string }).id : undefined).filter((id): id is string => id !== undefined && id.length > 0 && !/[\\/]/.test(id))
}

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : formatDateTime(date, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

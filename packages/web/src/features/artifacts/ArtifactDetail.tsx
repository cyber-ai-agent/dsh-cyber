import { Archive, ArrowLeft, Clock, IdentificationBadge, LinkSimple, PencilSimple, PlusCircle } from '@phosphor-icons/react'
import { useState } from 'react'

import { artifactFileUrl, artifactKindLabel, type ArtifactRecord } from './useWorldArtifacts.js'
import { ArtifactPreview } from './ArtifactPreview.js'

interface ArtifactDetailProps {
  worldId: string
  artifact: ArtifactRecord
  onBack(): void
  onRename(title: string): Promise<void>
  onArchive(): Promise<void>
}

export function ArtifactDetail({ worldId, artifact, onBack, onRename, onArchive }: ArtifactDetailProps) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(artifact.title)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string>()
  const currentVersion = artifact.currentVersionInfo
  const versions = artifact.versions ?? (currentVersion === undefined ? [] : [currentVersion])

  const rename = async () => {
    const next = title.trim()
    if (!next || next === artifact.title || busy) { setEditing(false); return }
    setBusy(true)
    setStatus(undefined)
    try {
      await onRename(next)
      setEditing(false)
      setStatus('产物名称已更新')
    } catch (cause) {
      setStatus(cause instanceof Error ? cause.message : '重命名失败')
    } finally {
      setBusy(false)
    }
  }

  const archive = async () => {
    if (busy || typeof window !== 'undefined' && !window.confirm('归档后这个产物仍可在历史记录中找到，确定继续吗？')) return
    setBusy(true)
    setStatus(undefined)
    try {
      await onArchive()
      setStatus('产物已归档')
    } catch (cause) {
      setStatus(cause instanceof Error ? cause.message : '归档失败')
    } finally {
      setBusy(false)
    }
  }

  return <section className="artifact-detail" aria-label={`${artifact.title}产物详情`}>
    <header className="artifact-detail__header">
      <button type="button" className="artifact-detail__back" onClick={onBack} aria-label="返回产物列表" title="返回产物列表"><ArrowLeft size={17} />返回产物</button>
      <div className="artifact-detail__title-row">
        {editing ? <input aria-label="产物名称" value={title} onChange={(event) => setTitle(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void rename(); if (event.key === 'Escape') setEditing(false) }} autoFocus /> : <h2>{artifact.title}</h2>}
        {editing ? <button type="button" className="artifact-button artifact-button--primary" disabled={busy || title.trim().length === 0} onClick={() => void rename()}>保存名称</button> : <button type="button" className="artifact-icon-button" aria-label="重命名产物" title="重命名产物" onClick={() => setEditing(true)}><PencilSimple size={17} /></button>}
      </div>
      <p>{artifact.description ?? '世界内可持续引用的已发布产物。'}</p>
      <div className="artifact-detail__actions">
        <a className="artifact-button" href={artifactFileUrl(worldId, artifact.id, artifact.currentVersion)} target="_blank" rel="noreferrer"><LinkSimple size={16} />打开文件</a>
        <button type="button" className="artifact-button" disabled={busy || artifact.status === 'archived'} onClick={() => void archive()}><Archive size={16} />{artifact.status === 'archived' ? '已归档' : '归档'}</button>
        <button type="button" className="artifact-button artifact-button--future" disabled title="知识库将在后续版本开放"><PlusCircle size={16} />加入知识（即将开放）</button>
      </div>
      {status === undefined ? null : <p className="artifact-detail__status" role="status">{status}</p>}
    </header>

    <div className="artifact-detail__body">
      <div className="artifact-detail__preview"><ArtifactPreview worldId={worldId} artifact={artifact} /></div>
      <section className="artifact-detail__metadata" aria-labelledby="artifact-provenance-heading">
        <h3 id="artifact-provenance-heading">来源与版本</h3>
        <dl>
          <div><dt>类型</dt><dd>{artifactKindLabel(artifact.kind)}</dd></div>
          <div><dt>当前版本</dt><dd>v{artifact.currentVersion}</dd></div>
          <div><dt>创建者</dt><dd><IdentificationBadge size={15} />{artifact.createdByKind === 'owner' ? '世界所有者' : artifact.createdById || '角色'}</dd></div>
          {currentVersion?.sourceRelativePath === undefined ? null : <div><dt>工作目录来源</dt><dd><code>{currentVersion.sourceRelativePath}</code></dd></div>}
          {currentVersion?.relativePath === undefined ? null : <div><dt>发布路径</dt><dd><code>{currentVersion.relativePath}</code></dd></div>}
          {currentVersion?.sessionId === undefined ? null : <div><dt>会话</dt><dd><code>{currentVersion.sessionId}</code></dd></div>}
          {currentVersion?.workTurnId === undefined ? null : <div><dt>工作回合</dt><dd><code>{currentVersion.workTurnId}</code></dd></div>}
          {currentVersion?.agentRunId === undefined ? null : <div><dt>角色运行</dt><dd><code>{currentVersion.agentRunId}</code></dd></div>}
          <div><dt>更新时间</dt><dd><Clock size={15} />{formatDate(artifact.updatedAt)}</dd></div>
        </dl>
      </section>
      <section className="artifact-detail__versions" aria-labelledby="artifact-version-heading">
        <h3 id="artifact-version-heading">版本历史</h3>
        {versions.length === 0 ? <p className="artifact-detail__muted">暂无版本记录</p> : <ol>{[...versions].sort((a, b) => b.version - a.version).map((version) => <li key={version.version} className={version.version === artifact.currentVersion ? 'is-current' : ''}><span>v{version.version}</span><code>{version.relativePath}</code><small>{formatDate(version.createdAt)}</small></li>)}</ol>}
      </section>
    </div>
  </section>
}

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' })
}

import {
  ArrowSquareOut,
  ArrowLeft,
  CaretDoubleRight,
  CaretRight,
  File,
  FileCode,
  FileText,
  GlobeHemisphereWest,
  IdentificationBadge,
  Image,
  Folder,
  SpinnerGap,
} from '@phosphor-icons/react'
import { useEffect, useMemo, useState } from 'react'
import type { EmployeeDossier as EmployeeDossierData } from '@dsh-cyber/contracts'

import type { CyberEmployee, DockTab } from '../types.js'
import { EmployeeDossier } from './EmployeeDossier.js'
import { EmployeeDossierDirectory } from './EmployeeDossierDirectory.js'
import { WorldView } from './WorldView.js'

interface ArtifactDockProps {
  demoMode: boolean
  activeTab: DockTab
  selectedEmployee?: CyberEmployee
  dossiers: Record<string, EmployeeDossierData>
  employees: CyberEmployee[]
  worldName: string
  sceneImage?: string
  onTabChange(tab: DockTab): void
  onCollapse(): void
  onSelectEmployee(employeeId: string): void
  onDirectEmployee(employee: CyberEmployee): void
  onManageEmployee(employee: CyberEmployee): void
  onShowAllDossiers(): void
}

interface DemoArtifact {
  id: string
  name: string
  size: string
  updatedAt: string
  kind: 'markdown' | 'code' | 'image'
  content: string
}

interface WorkspaceFileEntry {
  name: string
  path: string
  kind: 'directory' | 'file'
  size: number
  updatedAt: string
  previewKind?: 'text' | 'image'
}

interface WorkspaceFileList {
  path: string
  parentPath?: string
  items: WorkspaceFileEntry[]
}

interface WorkspacePreview {
  entry: WorkspaceFileEntry
  content?: string
  url: string
}

const tabs: Array<{ id: DockTab; label: string; icon: typeof File }> = [
  { id: 'world', label: '世界', icon: GlobeHemisphereWest },
  { id: 'dossier', label: '档案', icon: IdentificationBadge },
  { id: 'files', label: '文件', icon: File },
  { id: 'preview', label: '预览', icon: Image },
]

const demoArtifacts: DemoArtifact[] = [
  {
    id: 'architecture',
    name: 'v0.3.0-架构设计.md',
    size: '1.2 MB',
    updatedAt: '10:33',
    kind: 'markdown',
    content: '# v0.3.0 发布架构\n\n本方案覆盖租户隔离、审计日志和告警规则三条主链路。\n\n## 验收边界\n\n- 租户数据不可越权访问\n- 审计事件可查询并具备完整来源\n- 告警规则支持去重与恢复\n\n```text\ntenant → policy → audit → alert\n```',
  },
  {
    id: 'audit-schema',
    name: '审计日志建表.sql',
    size: '3.4 KB',
    updatedAt: '10:34',
    kind: 'code',
    content: 'CREATE TABLE audit_events (\n  id TEXT PRIMARY KEY,\n  tenant_id TEXT NOT NULL,\n  actor_id TEXT NOT NULL,\n  action TEXT NOT NULL,\n  created_at TEXT NOT NULL\n);',
  },
  {
    id: 'alert-rules',
    name: '告警规则配置.yaml',
    size: '2.1 KB',
    updatedAt: '10:35',
    kind: 'code',
    content: 'rules:\n  - id: tenant-access-denied\n    severity: high\n    dedupeWindow: 5m\n    notify: security-team',
  },
]

export function ArtifactDock({
  demoMode,
  activeTab,
  selectedEmployee,
  dossiers,
  employees,
  worldName,
  sceneImage,
  onTabChange,
  onCollapse,
  onSelectEmployee,
  onDirectEmployee,
  onManageEmployee,
  onShowAllDossiers,
}: ArtifactDockProps) {
  const [selectedArtifactId, setSelectedArtifactId] = useState(demoArtifacts[0]?.id)
  const [workspaceFiles, setWorkspaceFiles] = useState<WorkspaceFileList>({ path: '', items: [] })
  const [workspacePreview, setWorkspacePreview] = useState<WorkspacePreview>()
  const [filesLoading, setFilesLoading] = useState(false)
  const [fileError, setFileError] = useState<string>()
  const selectedArtifact = useMemo(
    () => demoArtifacts.find((artifact) => artifact.id === selectedArtifactId),
    [selectedArtifactId],
  )

  const openArtifact = (artifact: DemoArtifact) => {
    setSelectedArtifactId(artifact.id)
    onTabChange('preview')
  }

  const loadWorkspaceDirectory = async (path = '') => {
    setFilesLoading(true)
    setFileError(undefined)
    try {
      const response = await fetch(`/api/workspace/files?path=${encodeURIComponent(path)}`)
      const payload = await response.json() as WorkspaceFileList & { error?: { message?: string } }
      if (!response.ok) throw new Error(payload.error?.message ?? '工作区目录读取失败')
      setWorkspaceFiles(payload)
    } catch (cause) {
      setFileError(cause instanceof Error ? cause.message : '工作区目录读取失败')
    } finally {
      setFilesLoading(false)
    }
  }

  const openWorkspaceEntry = async (entry: WorkspaceFileEntry) => {
    if (entry.kind === 'directory') {
      await loadWorkspaceDirectory(entry.path)
      return
    }
    if (entry.previewKind === undefined) {
      setFileError('此文件类型暂不支持安全预览。')
      return
    }
    const url = `/api/workspace/file?path=${encodeURIComponent(entry.path)}`
    setFileError(undefined)
    setWorkspacePreview({ entry, url })
    onTabChange('preview')
    if (entry.previewKind === 'text') {
      try {
        const response = await fetch(url)
        if (!response.ok) throw new Error(`文件预览失败（${response.status}）`)
        const content = await response.text()
        setWorkspacePreview({ entry, url, content })
      } catch (cause) {
        setFileError(cause instanceof Error ? cause.message : '文件预览失败')
      }
    }
  }

  useEffect(() => {
    if (!demoMode && activeTab === 'files' && workspaceFiles.items.length === 0 && !filesLoading) {
      void loadWorkspaceDirectory(workspaceFiles.path)
    }
  }, [activeTab, demoMode])

  return (
    <section className="artifact-dock" aria-label="产物与世界侧边栏">
      <header className="dock-tabs">
        <nav aria-label="侧边栏工具">
          {tabs.map((tab) => {
            const Icon = tab.icon
            return (
              <button
                key={tab.id}
                type="button"
                className={activeTab === tab.id ? 'is-active' : ''}
                onClick={() => onTabChange(tab.id)}
              >
                <Icon size={15} />
                <span>{tab.label}</span>
              </button>
            )
          })}
        </nav>
        <button className="icon-button" type="button" aria-label="收起侧边栏" onClick={onCollapse}>
          <CaretDoubleRight size={17} />
        </button>
      </header>

      <div className="dock-content">
        {activeTab === 'world' ? (
          <WorldView worldName={worldName} employees={employees} {...(sceneImage === undefined ? {} : { sceneImage })} onSelectEmployee={onSelectEmployee} />
        ) : null}
        {activeTab === 'dossier' ? (
          selectedEmployee !== undefined && dossiers[selectedEmployee.id] !== undefined
            ? <EmployeeDossier
                dossier={dossiers[selectedEmployee.id]!}
                employees={employees}
                avatarIndex={selectedEmployee.avatarIndex}
                onDirect={() => onDirectEmployee(selectedEmployee)}
                onManage={() => onManageEmployee(selectedEmployee)}
                onBack={onShowAllDossiers}
              />
            : <EmployeeDossierDirectory
                employees={employees}
                dossiers={dossiers}
                onOpen={onSelectEmployee}
                onDirect={onDirectEmployee}
                onManage={onManageEmployee}
              />
        ) : null}
        {activeTab === 'files' ? (
          demoMode
            ? <FileBrowser files={demoArtifacts} onOpen={openArtifact} />
            : <WorkspaceFileBrowser
                value={workspaceFiles}
                loading={filesLoading}
                {...(fileError === undefined ? {} : { error: fileError })}
                onOpen={(entry) => void openWorkspaceEntry(entry)}
                onBack={(path) => void loadWorkspaceDirectory(path)}
              />
        ) : null}
        {activeTab === 'preview' ? (
          demoMode && selectedArtifact !== undefined
            ? <ArtifactPreview artifact={selectedArtifact} />
            : workspacePreview === undefined
              ? <DockEmpty icon={Image} title="没有可预览的文件" copy="从文件列表选择文本、代码或图片后，可在这里预览。" />
              : <WorkspaceFilePreview value={workspacePreview} {...(fileError === undefined ? {} : { error: fileError })} />
        ) : null}
      </div>
    </section>
  )
}

function WorkspaceFileBrowser({ value, loading, error, onOpen, onBack }: { value: WorkspaceFileList; loading: boolean; error?: string; onOpen(entry: WorkspaceFileEntry): void; onBack(path: string): void }) {
  return (
    <div className="file-browser workspace-file-browser">
      <header>
        <button type="button" disabled={value.parentPath === undefined} aria-label="返回上级目录" onClick={() => value.parentPath !== undefined && onBack(value.parentPath)}><ArrowLeft size={15} /></button>
        <strong>{value.path || '工作区根目录'}</strong>
        <span>{value.items.length} 项</span>
      </header>
      {error === undefined ? null : <div className="file-browser__error">{error}</div>}
      {loading ? <div className="dock-empty"><SpinnerGap className="spin" size={24} /><strong>正在读取目录</strong></div> : (
        <div className="file-list">
          {value.items.length === 0 ? <div className="dialog-empty">此目录没有可显示的文件。</div> : value.items.map((entry) => {
            const Icon = entry.kind === 'directory' ? Folder : fileIcon(entry)
            return (
              <button key={entry.path} type="button" onClick={() => onOpen(entry)}>
                <Icon size={20} />
                <span><strong>{entry.name}</strong><small>{entry.kind === 'directory' ? '目录' : `${formatBytes(entry.size)} · ${entry.previewKind === undefined ? '不可预览' : '可预览'}`}</small></span>
                <CaretRight size={14} />
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function WorkspaceFilePreview({ value, error }: { value: WorkspacePreview; error?: string }) {
  const isImage = value.entry.previewKind === 'image'
  return (
    <article className="artifact-preview workspace-file-preview">
      <header>
        {isImage ? <Image size={20} /> : <FileCode size={20} />}
        <div><strong>{value.entry.name}</strong><span>{formatBytes(value.entry.size)} · 本地工作区只读预览</span></div>
        <button type="button" onClick={() => window.open(value.url, '_blank', 'noopener,noreferrer')}><ArrowSquareOut size={15} />新标签打开</button>
      </header>
      {error === undefined ? null : <div className="file-browser__error">{error}</div>}
      {isImage
        ? <div className="workspace-image-preview"><img src={value.url} alt={value.entry.name} /></div>
        : value.content === undefined
          ? <div className="dock-empty"><SpinnerGap className="spin" size={24} /><strong>正在加载文件</strong></div>
          : <pre className="artifact-preview__document"><code>{value.content}</code></pre>}
    </article>
  )
}

function fileIcon(entry: WorkspaceFileEntry): typeof File {
  if (entry.previewKind === 'image') return Image
  if (/\.(?:md|txt)$/i.test(entry.name)) return FileText
  if (entry.previewKind === 'text') return FileCode
  return File
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KB`
  return `${(value / 1_048_576).toFixed(1)} MB`
}

function FileBrowser({ files, onOpen }: { files: DemoArtifact[]; onOpen(artifact: DemoArtifact): void }) {
  return (
    <div className="file-browser">
      <header><strong>世界产物</strong><span>{files.length} 项</span></header>
      <div className="file-list">
        {files.map((artifact) => {
          const Icon = artifact.kind === 'markdown' ? FileText : artifact.kind === 'code' ? FileCode : Image
          return (
            <button key={artifact.id} type="button" onClick={() => onOpen(artifact)}>
              <Icon size={20} />
              <span><strong>{artifact.name}</strong><small>{artifact.size} · {artifact.updatedAt} 更新</small></span>
              <span className="file-list__action">预览</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function ArtifactPreview({ artifact }: { artifact: DemoArtifact }) {
  const openInNewTab = () => {
    const blob = new Blob([artifact.content], { type: artifact.kind === 'markdown' ? 'text/markdown;charset=utf-8' : 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    window.open(url, '_blank', 'noopener,noreferrer')
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }
  return (
    <article className="artifact-preview">
      <header>
        <FileText size={20} />
        <div><strong>{artifact.name}</strong><span>{artifact.size} · {artifact.updatedAt} 更新</span></div>
        <button type="button" onClick={openInNewTab}><ArrowSquareOut size={15} />新标签打开</button>
      </header>
      <pre className="artifact-preview__document"><code>{artifact.content}</code></pre>
    </article>
  )
}

function DockEmpty({ icon: Icon, title, copy }: { icon: typeof File; title: string; copy: string }) {
  return <div className="dock-empty"><Icon size={30} /><strong>{title}</strong><p>{copy}</p></div>
}

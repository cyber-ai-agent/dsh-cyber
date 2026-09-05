import {
  ArrowsClockwise,
  Books,
  CheckCircle,
  ClipboardText,
  Clock,
  FileArrowUp,
  FileText,
  FolderOpen,
  GlobeSimple,
  LinkSimple,
  MagnifyingGlass,
  Package,
  SpinnerGap,
  UploadSimple,
  WarningCircle,
  X,
} from '@phosphor-icons/react'
import { useEffect, useRef, useState, type ChangeEvent, type FormEvent, type MutableRefObject, type ReactNode, type RefObject } from 'react'

import type { KnowledgeConsolidationJob, World } from '@dsh-cyber/contracts'

import { formatDateTime } from '../../i18n/format.js'
import { useI18n } from '../../i18n/runtime.js'

import type {
  KnowledgeCollection,
  KnowledgeDocument,
  KnowledgeDocumentStatus,
  KnowledgeSearchResult,
  UseWorldKnowledgeResult,
} from './useWorldKnowledge.js'

export interface KnowledgeLibraryProps {
  world: World
  demoMode: boolean
  state: UseWorldKnowledgeResult
}

type DialogKind = 'paste' | 'web' | undefined
type KnowledgeConsolidationState = 'pending' | 'queued' | 'success' | 'error'

interface KnowledgeConsolidationEntry {
  state: KnowledgeConsolidationState
  message: string
}

export function KnowledgeLibrary({ world, demoMode, state }: KnowledgeLibraryProps) {
  const { t } = useI18n()
  const [dialog, setDialog] = useState<DialogKind>()
  const [importMenuOpen, setImportMenuOpen] = useState(false)
  const [queryInput, setQueryInput] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const zipInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)
  const importButtonRef = useRef<HTMLButtonElement>(null)
  const actionsDisabled = demoMode || state.busyAction !== undefined
  const hasSearch = state.searchQuery.length > 0
  const indexedCount = state.documents.filter((document) => document.status === 'indexed').length
  const lastUpdated = latestUpdatedAt([...state.collections, ...state.documents])
  const consolidationJobs = state.consolidationJobs ?? []
  const consolidationByDocument = consolidationEntriesBySource(consolidationJobs, 'document', t)

  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    void state.search(queryInput)
  }

  const clearSearch = () => {
    setQueryInput('')
    state.clearSearch()
  }

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (file === undefined) return
    void state.importFile(file).catch(() => undefined)
  }

  const handlePackChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files ?? [])
    event.currentTarget.value = ''
    if (files.length === 0) return
    void state.importPack(files, inferCollectionName(files)).catch(() => undefined)
  }

  const consolidateDocument = async (document: KnowledgeDocument) => {
    if (demoMode || document.status !== 'indexed') return
    const latest = latestConsolidationJob(consolidationJobs, 'document', document.id)
    if (latest?.status === 'failed') await state.retryConsolidation(latest.id)
    else if (latest === undefined) await state.consolidate('document', document.id)
  }

  return <section className="knowledge-library" aria-label={`${world.name} - ${t('knowledge.libraryTitle', '知识库')}`} aria-busy={state.loading || state.busyAction !== undefined}>
    <header className="knowledge-library__header">
      <div>
        <h3>{t('knowledge.libraryTitle', '知识库')}</h3>
      </div>
      <div className="knowledge-library__actions" aria-label={t('knowledge.libraryImportAction', '知识库导入操作')}>
        <input ref={fileInputRef} className="knowledge-visually-hidden" type="file" accept=".md,.markdown,.txt,.json,.pdf,text/markdown,text/plain,application/json,application/pdf" onChange={handleFileChange} disabled={actionsDisabled} aria-label={t('knowledge.libraryImportFile', '选择要导入的资料文件')} />
        <input ref={zipInputRef} className="knowledge-visually-hidden" type="file" accept=".zip,application/zip" onChange={handlePackChange} disabled={actionsDisabled} aria-label={t('knowledge.libraryImportZip', '选择 ZIP 知识包')} />
        <input ref={folderInputRef} className="knowledge-visually-hidden" type="file" accept=".md,.markdown,.txt,.json,.pdf" multiple onChange={handlePackChange} disabled={actionsDisabled} {...({ webkitdirectory: '' } as unknown as Record<string, string>)} aria-label={t('knowledge.libraryImportFolder', '选择知识文件夹')} />
        <div className="knowledge-import-menu-wrap">
          <button ref={importButtonRef} type="button" className="knowledge-action knowledge-action--primary" onClick={() => setImportMenuOpen((open) => !open)} disabled={actionsDisabled} aria-expanded={importMenuOpen} aria-controls="knowledge-import-menu" title={demoMode ? t('knowledge.libraryDemoNotice', '演示世界未连接本地知识库') : t('knowledge.libraryImportTitle', '选择文件、ZIP 知识包或文件夹')}><FileArrowUp size={16} aria-hidden="true" />{t('knowledge.libraryImportAction', '导入资料')}</button>
          {importMenuOpen ? <div id="knowledge-import-menu" className="knowledge-import-menu" role="menu" aria-label={t('knowledge.libraryImportTitle', '选择导入方式')} onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); setImportMenuOpen(false); importButtonRef.current?.focus() } }}>
            <button type="button" role="menuitem" onClick={() => { setImportMenuOpen(false); fileInputRef.current?.click() }}><FileText size={16} aria-hidden="true" /><span><strong>{t('knowledge.libraryImportFile', '导入文件')}</strong><small>{t('knowledge.libraryImportFileDesc', 'Markdown、TXT、JSON、PDF')}</small></span></button>
            <button type="button" role="menuitem" onClick={() => { setImportMenuOpen(false); zipInputRef.current?.click() }}><Package size={16} aria-hidden="true" /><span><strong>{t('knowledge.libraryImportZip', '导入 ZIP 知识包')}</strong><small>{t('knowledge.libraryImportZipDesc', '保留压缩包内的目录')}</small></span></button>
            <button type="button" role="menuitem" onClick={() => { setImportMenuOpen(false); folderInputRef.current?.click() }}><FolderOpen size={16} aria-hidden="true" /><span><strong>{t('knowledge.libraryImportFolder', '导入文件夹')}</strong><small>{t('knowledge.libraryImportFolderDesc', '批量导入资料目录')}</small></span></button>
            <button type="button" role="menuitem" onClick={() => { setImportMenuOpen(false); setDialog('paste') }}><ClipboardText size={16} aria-hidden="true" /><span>{t('knowledge.libraryPasteAction', '粘贴内容')}</span></button>
            <button type="button" role="menuitem" onClick={() => { setImportMenuOpen(false); setDialog('web') }}><GlobeSimple size={16} aria-hidden="true" /><span>{t('knowledge.libraryWebAction', '从网页导入')}</span></button>
            <button type="button" role="menuitem" onClick={() => { setImportMenuOpen(false); void state.rescan().catch(() => undefined) }}><ArrowsClockwise size={16} aria-hidden="true" /><span>{t('knowledge.libraryRescanAction', '重新扫描')}</span></button>
          </div> : null}
        </div>
      </div>
    </header>

    {demoMode ? <div className="knowledge-notice knowledge-notice--disabled" role="status"><WarningCircle size={17} aria-hidden="true" /><span>{t('knowledge.libraryDemoNotice', '演示世界未连接本地知识库，导入与扫描入口暂不可用。')}</span></div> : null}
    {state.error === undefined ? null : <div className="knowledge-notice knowledge-notice--error" role="alert"><WarningCircle size={17} aria-hidden="true" /><span>{state.error}</span><button type="button" onClick={() => void state.reload()} disabled={state.loading}>{t('knowledge.libraryRetry', '重试')}</button></div>}
    <KnowledgeConsolidationPanel state={state} />

    <form className="knowledge-search" role="search" onSubmit={submitSearch}>
      <MagnifyingGlass size={17} aria-hidden="true" />
      <label className="knowledge-visually-hidden" htmlFor="knowledge-library-search">{t('knowledge.librarySearchPlaceholder', '搜索知识库')}</label>
      <input id="knowledge-library-search" name="q" type="search" value={queryInput} onChange={(event) => setQueryInput(event.target.value)} placeholder={t('knowledge.librarySearchPlaceholder', '搜索资料、标题或网页来源')} disabled={demoMode || state.searching} autoComplete="off" />
      {hasSearch || queryInput.length > 0 ? <button type="button" className="knowledge-search__clear" onClick={clearSearch} aria-label={t('knowledge.librarySearchClear', '清除知识库搜索')} title={t('knowledge.librarySearchClear', '清除搜索')}><X size={16} aria-hidden="true" /></button> : null}
      <button type="submit" className="knowledge-search__submit" disabled={demoMode || state.searching || queryInput.trim().length === 0} aria-label={t('knowledge.librarySearchSubmit', '搜索知识库')} title={t('knowledge.librarySearchSubmit', '搜索知识库')}>{state.searching ? <SpinnerGap size={16} className="knowledge-spin" aria-hidden="true" /> : <span>{t('knowledge.librarySearchSubmit', '搜索')}</span>}</button>
    </form>

    {state.searchError === undefined ? null : <div className="knowledge-notice knowledge-notice--error knowledge-notice--inline" role="alert"><WarningCircle size={16} aria-hidden="true" /><span>{state.searchError}</span></div>}

    <p className="knowledge-statusline" title={`${t('knowledge.libraryStatUpdated', '更新')} ${formatDate(lastUpdated, t)}`}>{state.documents.length} 份资料 <span>·</span> {indexedCount === state.documents.length ? '全部已索引' : `${state.documents.length - indexedCount} 份待处理`}</p>

    {state.loading ? <div className="knowledge-state" role="status"><SpinnerGap size={22} className="knowledge-spin" aria-hidden="true" /><span>{t('knowledge.libraryLoading', '正在读取知识库…')}</span></div> : hasSearch ? <SearchResults results={state.searchResults} query={state.searchQuery} /> : <>
      <DocumentSection documents={state.documents} consolidationByDocument={consolidationByDocument} demoMode={demoMode} onConsolidate={(document) => void consolidateDocument(document)} />
      {state.collections.length === 0 ? null : <details className="dock-detail-fold"><summary>知识包 <span>{state.collections.length}</span></summary><CollectionSection collections={state.collections} documents={state.documents} /></details>}
    </>}

    {dialog === 'paste' ? <PasteDialog busy={state.busyAction === 'paste'} onClose={() => setDialog(undefined)} onSubmit={async (input) => { await state.createFromText(input); setDialog(undefined) }} /> : null}
    {dialog === 'web' ? <WebImportDialog busy={state.busyAction === 'web'} onClose={() => setDialog(undefined)} onSubmit={async (input) => { await state.importFromWeb(input); setDialog(undefined) }} /> : null}
  </section>
}

function KnowledgeConsolidationPanel({ state }: { state: UseWorldKnowledgeResult }) {
  const { t, formatDateTime: localDateTime } = useI18n()
  const [expanded, setExpanded] = useState(false)
  const jobs = state.consolidationJobs ?? []
  const actionable = jobs.filter((job) => job.status === 'failed' || job.status === 'queued' || job.status === 'running')
  const visible = expanded ? actionable : actionable.slice(0, 4)
  if (actionable.length === 0 && state.consolidationError === undefined) return null
  const failedCount = jobs.filter((job) => job.status === 'failed').length
  const activeCount = jobs.filter((job) => job.status === 'queued' || job.status === 'running').length
  return <section className="knowledge-consolidation" aria-label={t('knowledge.consolidationTitle', '知识整理任务')}><details><summary>{failedCount > 0 ? `${failedCount} 项整理需要处理 · ${friendlyConsolidationError(actionable.find((job) => job.status === 'failed')?.errorCode, t)}` : `${activeCount} 项资料正在整理`}</summary>
    <header><div><strong>{t('knowledge.consolidationTitle', '知识整理任务')}</strong><span>{failedCount > 0 ? t('knowledge.consolidationFailedSummary', '{count} 个任务失败', { count: failedCount }) : t('knowledge.consolidationActiveSummary', '{count} 个任务处理中', { count: activeCount })}</span></div>{activeCount > 0 ? <SpinnerGap size={16} className="knowledge-spin" aria-label={t('knowledge.consolidationActiveSummary', '知识整理处理中')} /> : <WarningCircle size={16} aria-hidden="true" />}</header>
    {state.consolidationError === undefined ? null : <p className="knowledge-consolidation__error" role="alert">{state.consolidationError}</p>}
    {visible.length === 0 ? null : <ul>{visible.map((job) => <li key={job.id} className={`knowledge-consolidation__job knowledge-consolidation__job--${job.status}`}>
      <span><strong>{consolidationSourceLabel(job, t)}</strong><small>{friendlyConsolidationError(job.errorCode, t)} · {consolidationJobContext(job, t)} · {safeFormatJobTime(job.updatedAt, localDateTime)}</small></span>
      {job.status === 'failed' ? <button type="button" disabled={state.retryingJobId !== undefined} onClick={() => void state.retryConsolidation(job.id).catch(() => undefined)}>{state.retryingJobId === job.id ? t('workbench.retrying', '正在重试…') : t('knowledge.libraryRetry', '重试')}</button> : <em>{job.status === 'running' ? t('knowledge.consolidatePending', '正在加入…') : t('knowledge.consolidateQueued', '已排队')}</em>}
    </li>)}</ul>}
    {actionable.length <= 4 ? null : <button type="button" className="knowledge-consolidation__more" aria-expanded={expanded} onClick={() => setExpanded((current) => !current)}>{expanded ? t('knowledge.consolidationCollapse', '收起任务') : t('knowledge.consolidationMore', '查看全部 {count} 个任务', { count: actionable.length })}</button>}
  </details></section>
}

function consolidationEntriesBySource(jobs: KnowledgeConsolidationJob[], sourceType: KnowledgeConsolidationJob['sourceType'], t: (key: string, fallback: string, variables?: Record<string, string | number>) => string): Record<string, KnowledgeConsolidationEntry> {
  const output: Record<string, KnowledgeConsolidationEntry> = {}
  for (const job of jobs) {
    if (job.sourceType !== sourceType || output[job.sourceId] !== undefined) continue
    output[job.sourceId] = job.status === 'completed'
      ? { state: 'success', message: consolidationSuccessMessage(job, t) }
      : job.status === 'failed'
        ? { state: 'error', message: t('knowledge.statusFailed', '处理失败') }
        : { state: 'queued', message: job.status === 'running' ? t('knowledge.consolidatePending', '正在加入…') : t('knowledge.consolidateQueued', '已排队') }
  }
  return output
}

/**
 * A finished job covers one chunk window, not necessarily the whole document.
 * Saying 已加入知识图谱 while most of a long file has never been read would be
 * the product lying about its own state, so a partial source says how far it
 * actually got and only a full one drops the counter.
 */
function consolidationSuccessMessage(job: KnowledgeConsolidationJob, t: (key: string, fallback: string, variables?: Record<string, string | number>) => string): string {
  const done = job.processedChunks
  const total = job.chunkTotal
  if (done === undefined || total === undefined || total === 0 || done >= total) return t('knowledge.consolidateSuccess', '已加入知识图谱')
  return t('knowledge.consolidatePartial', '已加入知识图谱 {done}/{total} 块', { done, total })
}

function latestConsolidationJob(jobs: KnowledgeConsolidationJob[], sourceType: KnowledgeConsolidationJob['sourceType'], sourceId: string): KnowledgeConsolidationJob | undefined {
  return jobs.find((job) => job.sourceType === sourceType && job.sourceId === sourceId)
}

function consolidationSourceLabel(job: KnowledgeConsolidationJob, t: (key: string, fallback: string, variables?: Record<string, string | number>) => string): string {
  if (job.sourceType === 'conversation') return t('knowledge.consolidationSourceConversation', '会话知识')
  if (job.sourceType === 'artifact') return t('knowledge.originArtifact', '世界产物')
  return t('knowledge.documentSectionTitle', '资料')
}

function friendlyConsolidationError(code: string | undefined, t: (key: string, fallback: string) => string): string {
  if (code === undefined) return t('knowledge.consolidateQueued', '已排队')
  if (/timeout/iu.test(code)) return t('knowledge.consolidationTimeout', '模型整理超时')
  if (/rate_limited/iu.test(code)) return '模型服务限流，请稍后重试'
  if (/credential/iu.test(code)) return '模型密钥不可用，请检查模型连接'
  if (/unconfigured/iu.test(code)) return '请先在模型中心配置可用模型'
  if (/response_invalid|text_invalid|schema|parse/iu.test(code)) return t('knowledge.consolidationInvalidResponse', '模型返回格式无效')
  return t('knowledge.consolidationGenericFailure', '知识整理失败')
}

function consolidationJobContext(job: KnowledgeConsolidationJob, t: (key: string, fallback: string, variables?: Record<string, string | number>) => string): string {
  const attempt = t('knowledge.consolidationAttempt', '第 {count} 次尝试', { count: job.attempt })
  if (job.sourceType !== 'conversation') return attempt
  return `${t('knowledge.consolidationRange', '消息 {from}–{to}', { from: job.fromCursor, to: job.toCursor })} · ${attempt}`
}

function safeFormatJobTime(value: string, formatter: (value: string | number | Date, options?: Intl.DateTimeFormatOptions) => string): string {
  if (!value || Number.isNaN(Date.parse(value))) return value || '—'
  return formatter(value, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function CollectionSection({ collections, documents }: { collections: KnowledgeCollection[]; documents: KnowledgeDocument[] }) {
  const { t } = useI18n()
  return <section className="knowledge-section" aria-labelledby="knowledge-collections-heading">
    <header className="knowledge-section__heading"><div><h4 id="knowledge-collections-heading">{t('knowledge.collectionSectionTitle', '知识包')}</h4><span>{t('knowledge.collectionSectionSubtitle', '按来源整理的资料集合')}</span></div><b>{collections.length}</b></header>
    {collections.length === 0 ? <div className="knowledge-empty knowledge-empty--compact"><FolderOpen size={20} aria-hidden="true" /><span>{t('knowledge.collectionEmptyTitle', '还没有知识包')}</span><small>{t('knowledge.collectionEmptyDesc', '导入文件夹或 ZIP 后，会在这里保留目录和来源。')}</small></div> : <ul className="knowledge-rows" aria-label={t('knowledge.collectionSectionTitle', '知识包列表')}>{collections.map((collection) => <CollectionRow key={collection.id} collection={collection} documents={documents} />)}</ul>}
  </section>
}

function CollectionRow({ collection, documents }: { collection: KnowledgeCollection; documents: KnowledgeDocument[] }) {
  const { t } = useI18n()
  const collectionDocuments = documents.filter((document) => document.collectionId === collection.id)
  const indexed = collectionDocuments.length > 0 ? collectionDocuments.filter((document) => document.status === 'indexed').length : collection.indexedDocumentCount ?? 0
  const originKey = `knowledge.origin${collection.origin.charAt(0).toUpperCase() + collection.origin.slice(1)}`
  return <li className="knowledge-row knowledge-row--collection">
    <span className="knowledge-row__icon" aria-hidden="true"><Package size={18} /></span>
    <span className="knowledge-row__body"><strong>{collection.name}</strong><small>{t(originKey, collection.origin)} · {t('knowledge.libraryStatSourcesUnit', '{count} 份资料', { count: collection.documentCount })}</small></span>
    <span className="knowledge-row__evidence"><span>{t('knowledge.libraryStatSources', '来源')} {collection.relativeRoot || '未指定目录'}</span><span>{t('knowledge.libraryStatIndexed', '索引')} {indexed}/{collection.documentCount}</span><span>{t('knowledge.libraryStatUpdated', '更新')} {formatDate(collection.updatedAt, t)}</span></span>
  </li>
}

function DocumentSection({ documents, consolidationByDocument, demoMode, onConsolidate }: { documents: KnowledgeDocument[]; consolidationByDocument: Record<string, KnowledgeConsolidationEntry>; demoMode: boolean; onConsolidate(document: KnowledgeDocument): void }) {
  const { t } = useI18n()
  return <section className="knowledge-section" aria-labelledby="knowledge-documents-heading">
    <header className="knowledge-section__heading"><div><h4 id="knowledge-documents-heading">{t('knowledge.documentSectionTitle', '资料')}</h4><span>{t('knowledge.documentSectionSubtitle', '可检索的原始内容')}</span></div><b>{documents.length}</b></header>
    {documents.length === 0 ? <div className="knowledge-empty"><FileText size={23} aria-hidden="true" /><strong>{t('knowledge.documentEmptyTitle', '还没有资料')}</strong><span>{t('knowledge.documentEmptyDesc', '导入 Markdown、TXT、JSON、PDF，或粘贴一段内容开始建立这个世界的参考资料。')}</span></div> : <ul className="knowledge-rows" aria-label={t('knowledge.documentSectionTitle', '知识资料列表')}>{documents.map((document) => <DocumentRow key={document.id} document={document} consolidation={consolidationByDocument[document.id]} demoMode={demoMode} onConsolidate={onConsolidate} />)}</ul>}
  </section>
}

function DocumentRow({ document, consolidation, demoMode, onConsolidate }: { document: KnowledgeDocument; consolidation?: KnowledgeConsolidationEntry | undefined; demoMode: boolean; onConsolidate(document: KnowledgeDocument): void }) {
  const { t } = useI18n()
  const consolidationActive = consolidation?.state === 'pending' || consolidation?.state === 'queued' || consolidation?.state === 'success'
  const canConsolidate = document.status === 'indexed' && !demoMode && !consolidationActive
  const originKey = `knowledge.origin${document.origin.charAt(0).toUpperCase() + document.origin.slice(1)}`
  const statusKey = `knowledge.status${document.status.charAt(0).toUpperCase() + document.status.slice(1)}`
  return <li className="knowledge-document"><details><summary>
    <span className="knowledge-row__icon" aria-hidden="true"><FileText size={18} /></span>
    <span className="knowledge-row__body"><strong>{document.title}</strong><small>{t(originKey, document.origin)} · {formatDate(document.updatedAt, t)}</small></span>
    <span className="knowledge-row__status"><span className={`knowledge-status knowledge-status--${document.status}`}><StatusIcon status={document.status} aria-hidden="true" />{t(statusKey, document.status)}</span></span>
    </summary><div className="knowledge-document__details"><p>{document.chunkCount} 段 · {formatBytes(document.byteLength)}</p>
    <span className="knowledge-row__evidence"><span>{t('knowledge.libraryStatSources', '来源')} {document.sourceUrl || document.relativePath || '本地资料'}</span><span>{t('knowledge.libraryStatUpdated', '更新')} {formatDate(document.updatedAt, t)}</span></span>
    {document.status === 'indexed' ? <span className="knowledge-row__consolidation"><button type="button" className="knowledge-row__consolidation-button" onClick={() => onConsolidate(document)} disabled={!canConsolidate} aria-describedby={`knowledge-consolidation-${document.id}`} title={demoMode ? t('knowledge.libraryDemoNotice', '演示世界暂不可整理知识') : consolidation?.state === 'error' ? t('knowledge.consolidateButton', '重新加入知识图谱') : t('knowledge.consolidateButton', '吸收到知识图谱')}>{consolidation?.state === 'pending' ? t('knowledge.consolidatePending', '正在加入…') : consolidation?.state === 'queued' ? t('knowledge.consolidateQueued', '已排队') : consolidation?.state === 'success' ? consolidation.message : t('knowledge.consolidateButton', '吸收到知识图谱')}</button>{consolidation === undefined ? null : <small id={`knowledge-consolidation-${document.id}`} className={`knowledge-row__consolidation-status knowledge-row__consolidation-status--${consolidation.state}`} role={consolidation.state === 'error' ? 'alert' : 'status'} aria-live="polite">{consolidation.message}</small>}</span> : null}
  </div></details></li>
}

function SearchResults({ results, query }: { results: KnowledgeSearchResult[]; query: string }) {
  const { t } = useI18n()
  return <section className="knowledge-section knowledge-section--search" aria-labelledby="knowledge-search-results-heading" aria-live="polite">
    <header className="knowledge-section__heading"><div><h4 id="knowledge-search-results-heading">{t('knowledge.librarySearchResults', '搜索结果')}</h4><span>“{query}”</span></div><b>{results.length}</b></header>
    {results.length === 0 ? <div className="knowledge-empty"><MagnifyingGlass size={22} aria-hidden="true" /><strong>没有找到匹配资料</strong><span>换一个关键词，或先导入一份资料。</span></div> : <ul className="knowledge-rows knowledge-search-results" aria-label="知识库搜索结果">{results.map((result) => <li key={result.id} className="knowledge-row knowledge-row--result"><span className="knowledge-row__icon" aria-hidden="true"><LinkSimple size={18} /></span><span className="knowledge-row__body"><strong>{result.title}</strong><small>{result.collectionName || t('knowledge.libraryTitle', '知识库')} · {result.relativePath || '来源路径未提供'}</small><span className="knowledge-result__snippet">{result.snippet || '该资料片段没有可显示的摘要。'}</span></span><span className="knowledge-row__evidence"><span>{t('knowledge.libraryStatSources', '来源')} {result.sourceUrl || result.relativePath || '本地资料'}</span><span>相关度 {formatScore(result.score)}</span><span>{t('knowledge.libraryStatUpdated', '更新')} {formatDate(result.updatedAt, t)}</span></span></li>)}</ul>}
  </section>
}

function PasteDialog({ busy, onClose, onSubmit }: { busy: boolean; onClose(): void; onSubmit(input: { title: string; content: string }): Promise<void> }) {
  const { t } = useI18n()
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [error, setError] = useState<string>()
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (title.trim().length === 0 || content.trim().length === 0) { setError('请填写标题和内容。'); return }
    setError(undefined)
    try { await onSubmit({ title: title.trim(), content }) } catch (cause) { setError(cause instanceof Error ? cause.message : '保存失败，请稍后重试。') }
  }
  return <KnowledgeDialogShell title={t('knowledge.pasteTitle', '粘贴内容')} description={t('knowledge.pasteDesc', '内容会保存为当前世界的一份本地 Markdown 资料。')} busy={busy} onClose={onClose} labelledBy="knowledge-paste-title" describedBy="knowledge-paste-description">
    <form className="knowledge-dialog__form" onSubmit={(event) => void submit(event)}>
      <p id="knowledge-paste-description" className="knowledge-dialog__hint">{t('knowledge.pasteHint', '外部文字只作为资料保存，不会改变角色权限或执行世界操作。')}</p>
      <label htmlFor="knowledge-paste-name">{t('knowledge.pasteNameLabel', '资料标题')}</label>
      <input id="knowledge-paste-name" data-dialog-autofocus name="title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder={t('knowledge.pasteNamePlaceholder', '例如：产品定位笔记')} autoComplete="off" disabled={busy} />
      <label htmlFor="knowledge-paste-content">{t('knowledge.pasteContentLabel', '资料内容')}</label>
      <textarea id="knowledge-paste-content" name="content" value={content} onChange={(event) => setContent(event.target.value)} placeholder={t('knowledge.pasteContentPlaceholder', '粘贴需要长期参考的内容')} rows={9} disabled={busy} />
      {error === undefined ? null : <p className="knowledge-dialog__error" role="alert">{error}</p>}
      <footer><button type="button" className="knowledge-button" onClick={onClose} disabled={busy}>{t('knowledge.cancel', '取消')}</button><button type="submit" className="knowledge-button knowledge-button--primary" disabled={busy}><UploadSimple size={16} aria-hidden="true" />{busy ? t('knowledge.pasteSubmitting', '正在保存…') : t('knowledge.pasteSubmit', '保存到知识库')}</button></footer>
    </form>
  </KnowledgeDialogShell>
}

function WebImportDialog({ busy, onClose, onSubmit }: { busy: boolean; onClose(): void; onSubmit(input: { url: string; title?: string }): Promise<void> }) {
  const { t } = useI18n()
  const [url, setUrl] = useState('')
  const [title, setTitle] = useState('')
  const [error, setError] = useState<string>()
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const value = { url, ...(title.trim() ? { title: title.trim() } : {}) }
    if (url.trim().length === 0) { setError('请输入网页地址。'); return }
    setError(undefined)
    try { await onSubmit(value) } catch (cause) { setError(cause instanceof Error ? cause.message : '网页导入失败，请稍后重试。') }
  }
  return <KnowledgeDialogShell title={t('knowledge.webTitle', '从网页导入')} description={t('knowledge.webDesc', '网页会先转换为可检索的文字，原网址会保留在资料来源中。')} busy={busy} onClose={onClose} labelledBy="knowledge-web-title" describedBy="knowledge-web-description">
    <form className="knowledge-dialog__form" onSubmit={(event) => void submit(event)}>
      <p id="knowledge-web-description" className="knowledge-dialog__hint">{t('knowledge.webHint', '只导入你有权访问的公开内容。网页中的指令文字会被视为普通资料。')}</p>
      <label htmlFor="knowledge-web-url">{t('knowledge.webUrlLabel', '网页地址')}</label><input id="knowledge-web-url" data-dialog-autofocus name="url" type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder={t('knowledge.webUrlPlaceholder', 'https://example.com/article')} autoComplete="url" disabled={busy} />
      <label htmlFor="knowledge-web-title-input">{t('knowledge.webNameLabel', '资料标题（可选）')}</label><input id="knowledge-web-title-input" name="title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder={t('knowledge.webNamePlaceholder', '留空则使用网页标题')} autoComplete="off" disabled={busy} />
      {error === undefined ? null : <p className="knowledge-dialog__error" role="alert">{error}</p>}
      <footer><button type="button" className="knowledge-button" onClick={onClose} disabled={busy}>{t('knowledge.cancel', '取消')}</button><button type="submit" className="knowledge-button knowledge-button--primary" disabled={busy}><GlobeSimple size={16} aria-hidden="true" />{busy ? t('knowledge.webSubmitting', '正在导入…') : t('knowledge.webSubmit', '保存到知识库')}</button></footer>
    </form>
  </KnowledgeDialogShell>
}

function KnowledgeDialogShell({ title, description, busy, onClose, labelledBy, describedBy, children }: { title: string; description: string; busy: boolean; onClose(): void; labelledBy: string; describedBy: string; children: ReactNode }) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  const busyRef = useRef(busy)
  onCloseRef.current = onClose
  busyRef.current = busy

  useDialogFocus(dialogRef, onCloseRef, busyRef)

  return <div className="knowledge-dialog-backdrop" role="presentation"><div ref={dialogRef} className="knowledge-dialog" role="dialog" aria-modal="true" aria-labelledby={labelledBy} aria-describedby={describedBy} aria-busy={busy}><header><div><h2 id={labelledBy}>{title}</h2><p>{description}</p></div><button type="button" className="knowledge-icon-button" onClick={onClose} disabled={busy} aria-label={`关闭${title}`} title="关闭"><X size={18} aria-hidden="true" /></button></header>{children}</div></div>
}

function useDialogFocus(dialogRef: RefObject<HTMLDivElement | null>, onCloseRef: MutableRefObject<() => void>, busyRef: MutableRefObject<boolean>) {
  const focusableSelector = 'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
  // The focus trap is intentionally small and native: knowledge dialogs only
  // have one form, but Escape/Tab still need to behave predictably in a Dock.
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    const timer = window.setTimeout(() => dialogRef.current?.querySelector<HTMLElement>('[data-dialog-autofocus]')?.focus(), 0)
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (!busyRef.current) onCloseRef.current()
        return
      }
      if (event.key !== 'Tab' || dialogRef.current === null) return
      const focusables = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(focusableSelector))
      if (focusables.length === 0) { event.preventDefault(); return }
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('keydown', onKeyDown)
      previous?.focus()
    }
  }, [dialogRef, focusableSelector, onCloseRef, busyRef])
}

function StatusIcon({ status, ...props }: { status: KnowledgeDocumentStatus; 'aria-hidden'?: 'true' | 'false' }) {
  if (status === 'indexed') return <CheckCircle size={13} {...props} />
  if (status === 'failed' || status === 'missing') return <WarningCircle size={13} {...props} />
  return <Clock size={13} {...props} />
}

function inferCollectionName(files: File[]): string {
  const first = files[0]
  if (first === undefined) return '新知识包'
  const relativePath = (first as File & { webkitRelativePath?: string }).webkitRelativePath
  if (relativePath) return relativePath.split('/')[0] || '新知识包'
  return first.name.replace(/\.zip$/i, '') || '新知识包'
}

function latestUpdatedAt(items: Array<{ updatedAt: string }>): string {
  return items.map((item) => item.updatedAt).filter((value) => value.length > 0).sort().at(-1) ?? ''
}

function formatDate(value: string | undefined, t?: (key: string, fallback: string) => string): string {
  if (!value) return t ? t('knowledge.libraryStatUpdatedNone', '尚未记录') : '尚未记录'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : formatDateTime(date, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

function formatScore(value: number | undefined): string {
  return value === undefined ? '—' : value.toFixed(2)
}

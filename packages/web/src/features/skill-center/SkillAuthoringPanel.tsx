import { FileArrowUp, FolderOpen, MagicWand, Package, Sparkle } from '@phosphor-icons/react'
import { useEffect, useRef, useState } from 'react'
import type { SkillAuthoringDraft, SkillDetailView, SkillDependency } from '@dsh-cyber/contracts'

import { analyzeSkill, importSkillPackage, installSkillPackage, publishSkill } from './api.js'

export interface SkillEditSeed { detail: SkillDetailView; draft: SkillAuthoringDraft }

export function SkillAuthoringPanel({ workspaceId, worldId, editSeed, onInstalled, onClearEdit }: {
  workspaceId: string
  worldId: string
  editSeed?: SkillEditSeed
  onInstalled(): Promise<void>
  onClearEdit(): void
}) {
  const [mode, setMode] = useState<'import' | 'write'>(editSeed === undefined ? 'import' : 'write')
  const [source, setSource] = useState('')
  const [draft, setDraft] = useState<SkillAuthoringDraft>(editSeed?.draft ?? emptyDraft())
  const [importFiles, setImportFiles] = useState<File[]>([])
  const [importLabel, setImportLabel] = useState('')
  const zipInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)
  const [loadIntoWorld, setLoadIntoWorld] = useState(true)
  const [busy, setBusy] = useState<'analyze' | 'publish' | 'import'>()
  const [message, setMessage] = useState<string>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    if (editSeed === undefined) return
    setMode('write'); setDraft(editSeed.draft); setSource(editSeed.draft.instructions); setMessage(undefined); setError(undefined)
  }, [editSeed])

  const analyze = async (): Promise<void> => {
    if (!source.trim()) return
    setBusy('analyze'); setError(undefined); setMessage(undefined)
    try {
      const result = await analyzeSkill(workspaceId, { kind: 'description', text: source.trim() }, editSeed?.draft)
      setDraft(result.draft); setMessage(editSeed === undefined ? 'AI 草稿已生成，请检查后发布。' : 'AI 优化已完成，请检查差异后发布新版本。')
    } catch (cause) { setError(errorMessage(cause, 'AI 技能撰写失败')) }
    finally { setBusy(undefined) }
  }

  const publish = async (): Promise<void> => {
    setBusy('publish'); setError(undefined); setMessage(undefined)
    try {
      const result = await publishSkill(workspaceId, {
        source: { kind: 'description', text: source.trim() || draft.instructions }, draft,
        ...(editSeed?.detail.editable !== true || editSeed.detail.packageId === undefined ? {} : { basePackageId: editSeed.detail.packageId }),
        ...(editSeed?.detail.editable !== true || editSeed.detail.packageVersion === undefined ? {} : { basePackageVersion: editSeed.detail.packageVersion }),
      })
      await installSkillPackage(workspaceId, result.item.manifest, result.item.sourceDirectory, worldId)
      await onInstalled(); setMessage(`技能 ${result.draft.displayName} 已发布并加载到当前世界。`)
      setDraft(emptyDraft()); setSource('')
      if (editSeed !== undefined) onClearEdit()
    } catch (cause) { setError(errorMessage(cause, '技能发布失败')) }
    finally { setBusy(undefined) }
  }

  const cancelEdit = (): void => { setDraft(emptyDraft()); setSource(''); onClearEdit() }

  const installImported = async (): Promise<void> => {
    setBusy('import'); setError(undefined); setMessage(undefined)
    try {
      await importSkillPackage(workspaceId, importFiles, loadIntoWorld ? worldId : undefined)
      await onInstalled(); setMessage(`技能包${importLabel ? `「${importLabel}」` : ''} 已导入。`)
      setImportFiles([]); setImportLabel('')
    } catch (cause) { setError(errorMessage(cause, '技能包导入失败')) }
    finally { setBusy(undefined) }
  }

  return <div className="skill-center__authoring">
    <aside className="skill-center__authoring-modes" aria-label="添加技能方式">
      <button type="button" className={mode === 'import' ? 'is-active' : ''} onClick={() => setMode('import')}><FileArrowUp size={17} /><span><strong>导入技能包</strong><small>导入本机技能包</small></span></button>
      <button type="button" className={mode === 'write' ? 'is-active' : ''} onClick={() => setMode('write')}><MagicWand size={17} /><span><strong>{editSeed === undefined ? '写入技能' : '编辑技能'}</strong><small>AI 撰写、优化并发布版本</small></span></button>
    </aside>
    <section className="skill-center__authoring-main">
      {error === undefined ? null : <div className="skill-center__error" role="alert">{error}</div>}
      {message === undefined ? null : <div className="skill-center__success" role="status">{message}</div>}
      {mode === 'import' ? <>
        <header><h3>导入技能包</h3><p>选择一个 ZIP 压缩包或技能包文件夹。包内需要包含 <code>dsh-cyber.package.json</code>，系统会执行完整性、依赖和能力检查。</p></header>
        <div className="skill-center__import-pickers">
          <input ref={zipInputRef} className="skill-center__visually-hidden" type="file" accept=".zip,application/zip" onChange={(event) => void selectImportFiles(event.currentTarget.files, setImportFiles, setImportLabel, event.currentTarget)} />
          <input ref={folderInputRef} className="skill-center__visually-hidden" type="file" multiple {...({ webkitdirectory: '' } as unknown as Record<string, string>)} onChange={(event) => void selectImportFiles(event.currentTarget.files, setImportFiles, setImportLabel, event.currentTarget)} />
          <button type="button" className="skill-center__file-picker" onClick={() => zipInputRef.current?.click()}><Package size={17} />选择 ZIP 技能包</button>
          <button type="button" className="skill-center__file-picker" onClick={() => folderInputRef.current?.click()}><FolderOpen size={17} />选择技能包文件夹</button>
        </div>
        <div className="skill-center__import-summary" role="status"><strong>{importFiles.length > 0 ? `已选择 ${importFiles.length} 个文件` : '等待选择技能包'}</strong><span>{importLabel || '目录由宿主固定管理，导入后保存到当前工作区的技能包目录。'}</span></div>
        <label className="skill-center__inline-check"><input type="checkbox" checked={loadIntoWorld} onChange={(event) => setLoadIntoWorld(event.target.checked)} />导入后加载到当前世界</label>
        <footer><button type="button" className="primary-button" disabled={busy !== undefined || importFiles.length === 0} onClick={() => void installImported()}><Package size={15} />{busy === 'import' ? '正在导入…' : '检查并导入技能包'}</button></footer>
      </> : <>
        <header><h3>{editSeed === undefined ? '写入新技能' : `编辑 ${editSeed.draft.displayName}`}</h3><p>用自然语言描述工作方法，AI 会整理为可复用 Skill；所有字段均可在发布前检查和修改。</p></header>
        <div className="skill-center__ai-source">
          <label className="skill-center__field"><span>{editSeed === undefined ? '技能目标与工作方法' : '优化要求'}</span><textarea rows={6} value={source} onChange={(event) => setSource(event.target.value)} placeholder="说明适用场景、输入、步骤、输出、边界与验收标准" /></label>
          <button type="button" disabled={busy !== undefined || !source.trim()} onClick={() => void analyze()}><Sparkle size={15} />{busy === 'analyze' ? 'AI 正在整理…' : editSeed === undefined ? 'AI 撰写技能' : 'AI 优化技能'}</button>
        </div>
        <div className="skill-center__draft-form">
          <label className="skill-center__field"><span>Skill ID</span><input value={draft.id} disabled={editSeed !== undefined} onChange={(event) => setDraft({ ...draft, id: event.target.value })} placeholder="custom.research-review" /></label>
          <label className="skill-center__field"><span>技能名称</span><input value={draft.displayName} onChange={(event) => setDraft({ ...draft, displayName: event.target.value })} /></label>
          <label className="skill-center__field skill-center__field--wide"><span>技能简介</span><textarea rows={2} value={draft.summary} onChange={(event) => setDraft({ ...draft, summary: event.target.value })} /></label>
          <label className="skill-center__field skill-center__field--wide"><span>触发提示词</span><input value={draft.routingHints.join('、')} onChange={(event) => setDraft({ ...draft, routingHints: splitList(event.target.value) })} placeholder="研究、核验、报告" /></label>
          <label className="skill-center__field skill-center__field--wide"><span>连接 / Skill 依赖</span><input value={dependencyText(draft.dependencies ?? [])} onChange={(event) => setDraft({ ...draft, dependencies: parseDependencies(event.target.value) })} placeholder="builtin.firecrawl、builtin.mcp、skill.other" /><small>依赖会写入 Skill 声明，连接设置由宿主根据 integration 依赖提供。</small></label>
          <label className="skill-center__field skill-center__field--wide"><span>SKILL 内容</span><textarea rows={14} value={draft.instructions} onChange={(event) => setDraft({ ...draft, instructions: event.target.value })} placeholder="写明步骤、边界和验收标准" /></label>
        </div>
        <footer><span>发布会创建不可变技能包版本，并加载到当前世界。</span>{editSeed === undefined ? null : <button type="button" onClick={cancelEdit}>取消编辑</button>}<button type="button" className="primary-button" disabled={busy !== undefined || !draft.id.trim() || !draft.displayName.trim() || !draft.summary.trim() || !draft.instructions.trim()} onClick={() => void publish()}>{busy === 'publish' ? '正在发布…' : editSeed === undefined ? '发布并加载技能' : '发布新版本'}</button></footer>
      </>}
    </section>
  </div>
}

export function draftFromDetail(detail: SkillDetailView): SkillAuthoringDraft | undefined {
  const manifestFile = detail.files.find((file) => file.path === 'skill.json')
  if (manifestFile === undefined) {
    const source = detail.files[0]?.content.trim()
    if (!source) return undefined
    return { schemaVersion: 1, id: `custom.${detail.entry.id.replace(/[^a-z0-9._-]+/gi, '-').toLowerCase()}`.slice(0, 160), displayName: `${detail.entry.displayName}优化版`, summary: detail.entry.summary, routingHints: [...(detail.entry.routingHints ?? [])], integrationId: 'builtin.recipe', dependencies: [...(detail.entry.dependencies ?? [])], dataEgress: [], instructions: source.slice(0, 4_000), sourceSummary: `基于 ${detail.entry.id} 创建。` }
  }
  try {
    const value = JSON.parse(manifestFile.content) as Partial<SkillAuthoringDraft>
    if (typeof value.id !== 'string' || typeof value.displayName !== 'string' || typeof value.summary !== 'string' || typeof value.instructions !== 'string') return undefined
    return { schemaVersion: 1, id: value.id, displayName: value.displayName, summary: value.summary, routingHints: Array.isArray(value.routingHints) ? value.routingHints.filter((item): item is string => typeof item === 'string') : [], integrationId: 'builtin.recipe', dependencies: Array.isArray(value.dependencies) ? value.dependencies.filter(isDependency) : [], dataEgress: [], instructions: value.instructions, sourceSummary: '来自技能中心现有版本。' }
  } catch { return undefined }
}

function emptyDraft(): SkillAuthoringDraft { return { schemaVersion: 1, id: '', displayName: '', summary: '', routingHints: [], integrationId: 'builtin.recipe', dependencies: [], dataEgress: [], instructions: '', sourceSummary: '由用户在技能中心撰写。' } }
function splitList(value: string): string[] { return [...new Set(value.split(/[,，、\n]/).map((item) => item.trim()).filter(Boolean))].slice(0, 32) }
function errorMessage(cause: unknown, fallback: string): string { return cause instanceof Error && cause.message ? cause.message : fallback }
function dependencyText(value: readonly SkillDependency[]): string { return value.map((item) => item.kind === 'skill' ? `skill.${item.id}` : item.id).join('、') }
function parseDependencies(value: string): SkillDependency[] {
  const result: SkillDependency[] = []
  for (const token of value.split(/[,，、\n]/).map((item) => item.trim()).filter(Boolean).slice(0, 64)) {
    const isSkill = token.startsWith('skill.')
    const id = isSkill ? token.slice('skill.'.length) : token
    if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(id)) continue
    const dependency = { kind: isSkill ? 'skill' as const : 'integration' as const, id, required: true }
    if (!result.some((item) => item.kind === dependency.kind && item.id === dependency.id)) result.push(dependency)
  }
  return result
}
function isDependency(value: unknown): value is SkillDependency { return typeof value === 'object' && value !== null && !Array.isArray(value) && ((value as { kind?: unknown }).kind === 'integration' || (value as { kind?: unknown }).kind === 'skill') && typeof (value as { id?: unknown }).id === 'string' }
async function selectImportFiles(files: FileList | null, setFiles: (value: File[]) => void, setLabel: (value: string) => void, input: HTMLInputElement): Promise<void> {
  const selected = Array.from(files ?? [])
  input.value = ''
  if (selected.length === 0) return
  setFiles(selected)
  const manifest = selected.find((file) => {
    const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath ?? file.name
    return relativePath.split('/').at(-1) === 'dsh-cyber.package.json'
  })
  if (manifest === undefined) { setLabel(selected.length === 1 ? selected[0]!.name : '技能包文件夹'); return }
  try {
    const value = JSON.parse(await manifest.text()) as { displayName?: unknown }
    setLabel(typeof value.displayName === 'string' && value.displayName.trim() ? value.displayName.trim() : '技能包')
  } catch { setLabel('待校验的技能包') }
}

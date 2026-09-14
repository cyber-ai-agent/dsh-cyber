import { FileArrowUp, MagicWand, Package, Sparkle } from '@phosphor-icons/react'
import { useEffect, useState } from 'react'
import type { CyberPackageManifest, SkillAuthoringDraft, SkillDetailView } from '@dsh-cyber/contracts'

import { analyzeSkill, installSkillPackage, publishSkill } from './api.js'

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
  const [manifestText, setManifestText] = useState('')
  const [sourceDirectory, setSourceDirectory] = useState('')
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
      const manifest = JSON.parse(manifestText) as CyberPackageManifest
      if (manifest.kind !== 'skill') throw new Error('请选择 kind=skill 的技能包清单。')
      await installSkillPackage(workspaceId, manifest, sourceDirectory.trim(), loadIntoWorld ? worldId : undefined)
      await onInstalled(); setMessage(`技能包 ${manifest.displayName} 已导入。`)
    } catch (cause) { setError(errorMessage(cause, '技能包导入失败')) }
    finally { setBusy(undefined) }
  }

  return <div className="skill-center__authoring">
    <aside className="skill-center__authoring-modes" aria-label="添加技能方式">
      <button type="button" className={mode === 'import' ? 'is-active' : ''} onClick={() => setMode('import')}><FileArrowUp size={17} /><span><strong>导入技能包</strong><small>安装本机 Skill Package</small></span></button>
      <button type="button" className={mode === 'write' ? 'is-active' : ''} onClick={() => setMode('write')}><MagicWand size={17} /><span><strong>{editSeed === undefined ? '写入技能' : '编辑技能'}</strong><small>AI 撰写、优化并发布版本</small></span></button>
    </aside>
    <section className="skill-center__authoring-main">
      {error === undefined ? null : <div className="skill-center__error" role="alert">{error}</div>}
      {message === undefined ? null : <div className="skill-center__success" role="status">{message}</div>}
      {mode === 'import' ? <>
        <header><h3>导入技能包</h3><p>选择 <code>dsh-cyber.package.json</code>，并填写该清单所在的软件包目录。系统会执行完整性与能力检查。</p></header>
        <label className="skill-center__file-picker"><input type="file" accept="application/json,.json" onChange={(event) => void readManifest(event.currentTarget.files?.[0], setManifestText)} /><FileArrowUp size={17} />选择技能包清单</label>
        <label className="skill-center__field"><span>软件包清单</span><textarea rows={10} value={manifestText} onChange={(event) => setManifestText(event.target.value)} placeholder="选择文件后将在这里显示清单内容" /></label>
        <label className="skill-center__field"><span>本机软件包目录</span><input value={sourceDirectory} onChange={(event) => setSourceDirectory(event.target.value)} placeholder="E:\\skills\\my-skill" /></label>
        <label className="skill-center__inline-check"><input type="checkbox" checked={loadIntoWorld} onChange={(event) => setLoadIntoWorld(event.target.checked)} />导入后加载到当前世界</label>
        <footer><button type="button" className="primary-button" disabled={busy !== undefined || !manifestText.trim() || !sourceDirectory.trim()} onClick={() => void installImported()}><Package size={15} />{busy === 'import' ? '正在导入…' : '检查并导入技能包'}</button></footer>
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
    return { schemaVersion: 1, id: `custom.${detail.entry.id.replace(/[^a-z0-9._-]+/gi, '-').toLowerCase()}`.slice(0, 160), displayName: `${detail.entry.displayName}优化版`, summary: detail.entry.summary, routingHints: [...(detail.entry.routingHints ?? [])], integrationId: 'builtin.recipe', dataEgress: [], instructions: source.slice(0, 4_000), sourceSummary: `基于 ${detail.entry.id} 创建。` }
  }
  try {
    const value = JSON.parse(manifestFile.content) as Partial<SkillAuthoringDraft>
    if (typeof value.id !== 'string' || typeof value.displayName !== 'string' || typeof value.summary !== 'string' || typeof value.instructions !== 'string') return undefined
    return { schemaVersion: 1, id: value.id, displayName: value.displayName, summary: value.summary, routingHints: Array.isArray(value.routingHints) ? value.routingHints.filter((item): item is string => typeof item === 'string') : [], integrationId: 'builtin.recipe', dataEgress: [], instructions: value.instructions, sourceSummary: '来自技能中心现有版本。' }
  } catch { return undefined }
}

function emptyDraft(): SkillAuthoringDraft { return { schemaVersion: 1, id: '', displayName: '', summary: '', routingHints: [], integrationId: 'builtin.recipe', dataEgress: [], instructions: '', sourceSummary: '由用户在技能中心撰写。' } }
function splitList(value: string): string[] { return [...new Set(value.split(/[,，、\n]/).map((item) => item.trim()).filter(Boolean))].slice(0, 32) }
function errorMessage(cause: unknown, fallback: string): string { return cause instanceof Error && cause.message ? cause.message : fallback }
async function readManifest(file: File | undefined, apply: (value: string) => void): Promise<void> { if (file !== undefined) apply(await file.text()) }

import { ArrowsClockwise, Plus, PuzzlePiece, WarningCircle, X } from '@phosphor-icons/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { SkillDetailView, SkillScopeView, SkillSettingsView, World } from '@dsh-cyber/contracts'

import type { SkillCatalogEntry } from '../../components/skill-catalog.js'
import { useDialogFocusTrap } from '../../components/useDialogFocusTrap.js'
import { loadSkillDetail, loadSkillSettings, listSkills, saveSkillSettings } from './api.js'
import { SkillAuthoringPanel, draftFromDetail, type SkillEditSeed } from './SkillAuthoringPanel.js'
import { SkillListPanel } from './SkillListPanel.js'
import { SkillSettingsPanel } from './SkillSettingsPanel.js'
import './skill-center.css'

type Tab = 'list' | 'settings' | 'add'

export function SkillCenterDialog({ world, worlds, onClose, onOpenMarket }: { world: World; worlds: World[]; onClose(): void; onOpenMarket?(): void }) {
  const [tab, setTab] = useState<Tab>('list')
  const [catalog, setCatalog] = useState<SkillCatalogEntry[]>([])
  const [settings, setSettings] = useState<SkillSettingsView>()
  const [selectedId, setSelectedId] = useState<string>()
  const [detail, setDetail] = useState<SkillDetailView>()
  const [editSeed, setEditSeed] = useState<SkillEditSeed>()
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()
  const dialogRef = useRef<HTMLElement>(null)
  useDialogFocusTrap(dialogRef, onClose)

  const reload = useCallback(async (): Promise<void> => {
    const [nextCatalog, nextSettings] = await Promise.all([listSkills(world.workspaceId), loadSkillSettings(world.workspaceId)])
    setCatalog(nextCatalog); setSettings(nextSettings)
    setSelectedId((current) => current ?? nextCatalog[0]?.id)
  }, [world.workspaceId])

  useEffect(() => { void reload().catch((cause: unknown) => setError(errorMessage(cause, '技能中心加载失败'))) }, [reload])

  const selectSkill = useCallback(async (skillId: string): Promise<void> => {
    setSelectedId(skillId); setBusy('detail'); setError(undefined)
    try { setDetail(await loadSkillDetail(world.workspaceId, skillId)) }
    catch (cause) { setError(errorMessage(cause, 'Skill 内容读取失败')); setDetail(undefined) }
    finally { setBusy(undefined) }
  }, [world.workspaceId])

  useEffect(() => { if (selectedId !== undefined && detail?.entry.id !== selectedId) void selectSkill(selectedId) }, [detail?.entry.id, selectSkill, selectedId])

  const saveScope = async (scope: SkillScopeView, skillIds: string[], inherit = false): Promise<void> => {
    setBusy('settings'); setError(undefined)
    try {
      setSettings(await saveSkillSettings(world.workspaceId, { scope: scope.scope, scopeId: scope.scopeId, ...(inherit ? { inherit: true } : { skillIds }) }))
      setCatalog(await listSkills(world.workspaceId))
    } catch (cause) { setError(errorMessage(cause, '技能设置保存失败')) }
    finally { setBusy(undefined) }
  }

  const editSkill = (nextDetail: SkillDetailView): void => {
    const draft = draftFromDetail(nextDetail)
    if (draft === undefined) { setError('当前技能内容无法转换为可编辑草稿。'); return }
    setEditSeed({ detail: nextDetail, draft }); setTab('add')
  }

  const installed = async (): Promise<void> => {
    await reload()
    if (selectedId !== undefined) await selectSkill(selectedId)
  }

  return createPortal(<div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section ref={dialogRef} className="skill-center" role="dialog" aria-modal="true" aria-labelledby="skill-center-title">
      <header className="skill-center__header">
        <div><h2 id="skill-center-title"><PuzzlePiece size={18} />技能中心</h2><p>{catalog.length} 个技能 · 当前世界：{world.name} · Skill 定义单份保存，范围与角色通过 ID 引用</p></div>
        <div className="skill-center__header-actions"><button type="button" className="icon-button" aria-label="刷新技能中心" disabled={busy === 'reload'} onClick={() => { setBusy('reload'); void reload().catch((cause) => setError(errorMessage(cause, '刷新失败'))).finally(() => setBusy(undefined)) }}><ArrowsClockwise size={16} className={busy === 'reload' ? 'spin' : undefined} /></button><button type="button" className="icon-button" data-dialog-initial-focus aria-label="关闭技能中心" onClick={onClose}><X size={18} /></button></div>
      </header>
      <nav className="skill-center__tabs" aria-label="技能中心分区">
        <button type="button" className={tab === 'list' ? 'is-active' : ''} aria-current={tab === 'list'} onClick={() => setTab('list')}>技能列表</button>
        <button type="button" className={tab === 'settings' ? 'is-active' : ''} aria-current={tab === 'settings'} onClick={() => setTab('settings')}>技能设置</button>
        <button type="button" className={`skill-center__add-tab${tab === 'add' ? ' is-active' : ''}`} aria-current={tab === 'add'} onClick={() => setTab('add')}><Plus size={14} />添加技能</button>
      </nav>
      {error === undefined ? null : <div className="skill-center__error" role="alert"><WarningCircle size={15} /><span>{error}</span><button type="button" className="icon-button" aria-label="收起提示" onClick={() => setError(undefined)}><X size={13} /></button></div>}
      {tab === 'list' ? <SkillListPanel catalog={catalog} {...(detail === undefined ? {} : { detail })} {...(selectedId === undefined ? {} : { selectedId })} loadingDetail={busy === 'detail'} onSelect={(skillId) => void selectSkill(skillId)} onEdit={editSkill} /> : null}
      {tab === 'settings' ? <SkillSettingsPanel catalog={catalog} {...(settings === undefined ? {} : { settings })} busy={busy === 'settings'} onSave={saveScope} /> : null}
      {tab === 'add' ? <SkillAuthoringPanel workspaceId={world.workspaceId} worldId={world.id} {...(editSeed === undefined ? {} : { editSeed })} onInstalled={installed} onClearEdit={() => setEditSeed(undefined)} /> : null}
      <footer className="skill-center__footer"><span>技能包安装入口仍可从市场访问。</span>{onOpenMarket === undefined ? null : <button type="button" onClick={() => { onClose(); onOpenMarket() }}>打开市场技能包</button>}<span>{worlds.filter((item) => item.status === 'active').length} 个活动世界可在“技能设置”中独立配置。</span></footer>
    </section>
  </div>, document.body)
}

function errorMessage(cause: unknown, fallback: string): string { return cause instanceof Error && cause.message ? cause.message : fallback }

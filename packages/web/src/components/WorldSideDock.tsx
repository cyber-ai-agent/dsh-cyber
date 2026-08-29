import {
  CalendarBlank,
  ClipboardText,
  CaretDown,
  CaretDoubleRight,
  CaretUp,
  Check,
  Cube,
  GlobeHemisphereWest,
  IdentificationBadge,
  Package,
  Path,
  X,
} from '@phosphor-icons/react'
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { EmployeeDossier as EmployeeDossierData, World } from '@dsh-cyber/contracts'

import type { CyberEmployee, DockTab } from '../types.js'
import { useI18n } from '../i18n/runtime.js'
import { EmployeeDossier } from './EmployeeDossier.js'
import { EmployeeDossierDirectory } from './EmployeeDossierDirectory.js'
import { WorldView } from './WorldView.js'

const KnowledgeDock = lazy(async () => ({ default: (await import('../features/knowledge/KnowledgeDock.js')).KnowledgeDock }))
const TaskWorkspace = lazy(async () => ({ default: (await import('../features/tasks/TaskWorkspace.js')).TaskWorkspace }))

interface WorldSideDockProps {
  demoMode: boolean
  activeTab: DockTab
  selectedEmployee?: CyberEmployee
  dossiers: Record<string, EmployeeDossierData>
  employees: CyberEmployee[]
  world: World
  sceneImage?: string
  worldContent?: ReactNode
  knowledgeContent?: ReactNode
  artifactContent?: ReactNode
  traceContent?: ReactNode
  scheduleContent?: ReactNode
  onTabChange(tab: DockTab): void
  onCollapse(): void
  onSelectEmployee(employeeId: string): void
  onDirectEmployee(employee: CyberEmployee): void
  onManageEmployee(employee: CyberEmployee): void
  onShowAllDossiers(): void
  onInvite(): void
}

const FIXED_TABS: Array<{ id: 'world' | 'trace'; label: string; icon: typeof GlobeHemisphereWest }> = [
  { id: 'world', label: '世界', icon: GlobeHemisphereWest },
  { id: 'trace', label: '轨迹', icon: Path },
]

const SECONDARY_TABS: Array<{ id: Exclude<DockTab, 'world' | 'trace'>; label: string; icon: typeof GlobeHemisphereWest }> = [
  { id: 'dossier', label: '角色', icon: IdentificationBadge },
  { id: 'tasks', label: '任务', icon: ClipboardText },
  { id: 'knowledge', label: '知识', icon: Cube },
  { id: 'artifacts', label: '产物', icon: Package },
  { id: 'schedule', label: '日程', icon: CalendarBlank },
]

const SECONDARY_TAB_IDS = new Set<Exclude<DockTab, 'world' | 'trace'>>(SECONDARY_TABS.map((tab) => tab.id))
const DOCK_TABS_STORAGE_PREFIX = 'dsh-cyber:world-dock-tabs:'

/** Shared right-side World context. Artifact domain content lives in a feature module. */
export function WorldSideDock({
  demoMode,
  activeTab,
  selectedEmployee,
  dossiers,
  employees,
  world,
  sceneImage,
  worldContent,
  knowledgeContent,
  artifactContent,
  traceContent,
  scheduleContent,
  onTabChange,
  onCollapse,
  onSelectEmployee,
  onDirectEmployee,
  onManageEmployee,
  onShowAllDossiers,
  onInvite,
}: WorldSideDockProps) {
  const { t } = useI18n()
  const [openTabs, setOpenTabs] = useState<Exclude<DockTab, 'world' | 'trace'>[]>(() => {
    const restored = readOpenTabs(world.id)
    return isSecondaryTab(activeTab) && !restored.includes(activeTab) ? [...restored, activeTab] : restored
  })
  const [history, setHistory] = useState<DockTab[]>(() => [activeTab, 'world'])
  const [moreOpen, setMoreOpen] = useState(false)
  const moreRef = useRef<HTMLDivElement>(null)
  const moreButtonRef = useRef<HTMLButtonElement>(null)
  const menuItemRefs = useRef<Array<HTMLButtonElement | null>>([])
  const tabButtonRefs = useRef(new Map<DockTab, HTMLButtonElement>())

  useEffect(() => {
    const restored = readOpenTabs(world.id)
    setOpenTabs(isSecondaryTab(activeTab) && !restored.includes(activeTab) ? [...restored, activeTab] : restored)
    setHistory([activeTab, 'world'])
    setMoreOpen(false)
  }, [world.id])

  useEffect(() => {
    setHistory((current) => [activeTab, ...current.filter((tab) => tab !== activeTab)])
    if (!isSecondaryTab(activeTab)) return
    setOpenTabs((current) => current.includes(activeTab) ? current : [...current, activeTab])
  }, [activeTab])

  useEffect(() => {
    try { window.localStorage.setItem(storageKey(world.id), JSON.stringify(openTabs)) } catch { /* storage is optional */ }
  }, [openTabs, world.id])

  useEffect(() => {
    if (!moreOpen) return
    const onPointerDown = (event: PointerEvent) => {
      if (moreRef.current?.contains(event.target as Node) !== true) setMoreOpen(false)
    }
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setMoreOpen(false); moreButtonRef.current?.focus() }
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [moreOpen])

  const localizedFixedTabs = FIXED_TABS.map((tab) => ({ ...tab, label: t(`dock.${tab.id}`, tab.label) }))
  const localizedSecondaryTabs = SECONDARY_TABS.map((tab) => ({ ...tab, label: t(`dock.${tab.id === 'dossier' ? 'roles' : tab.id}`, tab.label) }))
  // Keep the header calm: secondary surfaces remain remembered in More, but
  // only the one the user is actively viewing is promoted into the tab row.
  const visibleSecondaryTabs = localizedSecondaryTabs.filter((tab) => tab.id === activeTab)
  const visibleTabs = [...localizedFixedTabs, ...visibleSecondaryTabs]

  const selectTab = (tab: DockTab) => {
    setHistory((current) => [tab, ...current.filter((item) => item !== tab)])
    if (isSecondaryTab(tab)) {
      setOpenTabs((current) => current.includes(tab) ? current : [...current, tab])
    }
    if (tab === 'dossier') onShowAllDossiers()
    setMoreOpen(false)
    onTabChange(tab)
  }

  const closeTab = (tab: Exclude<DockTab, 'world' | 'trace'>) => {
    const nextOpenTabs = openTabs.filter((item) => item !== tab)
    setOpenTabs(nextOpenTabs)
    setHistory((current) => current.filter((item) => item !== tab))
    if (activeTab !== tab) {
      window.setTimeout(() => tabButtonRefs.current.get(activeTab)?.focus(), 0)
      return
    }
    const fallback = history.find((item) => item !== tab && (item === 'world' || item === 'trace' || isOpenSecondaryTab(item, nextOpenTabs)))
      ?? 'world'
    if (fallback === 'dossier') onShowAllDossiers()
    onTabChange(fallback)
    window.setTimeout(() => tabButtonRefs.current.get(fallback)?.focus(), 0)
  }

  const onMoreKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setMoreOpen(true)
      window.setTimeout(() => menuItemRefs.current[0]?.focus(), 0)
    }
  }

  const onMenuKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === 'Escape') { event.preventDefault(); setMoreOpen(false); moreButtonRef.current?.focus(); return }
    const last = SECONDARY_TABS.length - 1
    if (event.key === 'ArrowDown') { event.preventDefault(); menuItemRefs.current[(index + 1) % SECONDARY_TABS.length]?.focus() }
    if (event.key === 'ArrowUp') { event.preventDefault(); menuItemRefs.current[(index - 1 + SECONDARY_TABS.length) % SECONDARY_TABS.length]?.focus() }
    if (event.key === 'Home') { event.preventDefault(); menuItemRefs.current[0]?.focus() }
    if (event.key === 'End') { event.preventDefault(); menuItemRefs.current[last]?.focus() }
  }

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, tab: DockTab) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const currentIndex = visibleTabs.findIndex((item) => item.id === tab)
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? visibleTabs.length - 1
        : (currentIndex + (event.key === 'ArrowRight' ? 1 : -1) + visibleTabs.length) % visibleTabs.length
    const target = visibleTabs[nextIndex]
    if (target !== undefined) {
      selectTab(target.id)
      window.setTimeout(() => tabButtonRefs.current.get(target.id)?.focus(), 0)
    }
  }

  return <section className="artifact-dock world-side-dock" aria-label="世界与角色侧边栏">
    <header className="dock-tabs">
      <nav className="dock-tabs__primary" aria-label="世界侧栏" role="tablist">
        {localizedFixedTabs.map((tab) => <DockTabButton key={tab.id} tab={tab} active={activeTab === tab.id} buttonRef={(element) => setTabButtonRef(tabButtonRefs.current, tab.id, element)} onSelect={() => selectTab(tab.id)} onKeyDown={(event) => onTabKeyDown(event, tab.id)} />)}
        {visibleSecondaryTabs.map((tab) => <DockTabButton key={tab.id} tab={tab} active={activeTab === tab.id} closable buttonRef={(element) => setTabButtonRef(tabButtonRefs.current, tab.id, element)} onSelect={() => selectTab(tab.id)} onKeyDown={(event) => onTabKeyDown(event, tab.id)} onClose={() => closeTab(tab.id)} />)}
      </nav>
      <div ref={moreRef} className="dock-tabs__more">
        <button ref={moreButtonRef} className="dock-tabs__more-button" type="button" aria-label={t('dock.more', '更多')} aria-haspopup="menu" aria-expanded={moreOpen} aria-controls="world-side-dock-more" onClick={() => setMoreOpen((current) => !current)} onKeyDown={onMoreKeyDown}><span>{t('dock.more', '更多')}</span>{moreOpen ? <CaretUp size={14} aria-hidden="true" /> : <CaretDown size={14} aria-hidden="true" />}</button>
        {moreOpen ? <div id="world-side-dock-more" className="dock-tabs__more-menu" role="menu" aria-label={t('dock.more', '更多')}>
          {localizedSecondaryTabs.map((tab, index) => { const Icon = tab.icon; const opened = openTabs.includes(tab.id); return <button key={tab.id} ref={(element) => { menuItemRefs.current[index] = element }} type="button" role="menuitemcheckbox" aria-checked={opened} onClick={() => { selectTab(tab.id); window.setTimeout(() => tabButtonRefs.current.get(tab.id)?.focus(), 0) }} onKeyDown={(event) => onMenuKeyDown(event, index)}><Icon size={16} aria-hidden="true" /><span>{tab.label}</span>{opened ? <Check size={15} aria-hidden="true" /> : null}</button> })}
        </div> : null}
      </div>
      <button className="icon-button" type="button" aria-label={t('dock.collapse', '收起侧边栏')} title={t('dock.collapse', '收起侧边栏')} onClick={onCollapse}><CaretDoubleRight size={17} /></button>
    </header>
    <div id="world-side-dock-panel" className="dock-content" role="tabpanel" aria-labelledby={`world-side-dock-tab-${activeTab}`}>
      {activeTab === 'world' ? worldContent ?? <WorldView world={world} employees={employees} {...(sceneImage === undefined ? {} : { sceneImage })} onSelectEmployee={onSelectEmployee} /> : null}
      {activeTab === 'dossier' ? selectedEmployee !== undefined && dossiers[selectedEmployee.id] !== undefined ? <EmployeeDossier dossier={dossiers[selectedEmployee.id]!} employees={employees} world={world} avatarIndex={selectedEmployee.avatarIndex} onDirect={() => onDirectEmployee(selectedEmployee)} onManage={() => onManageEmployee(selectedEmployee)} onBack={onShowAllDossiers} /> : <EmployeeDossierDirectory employees={employees} dossiers={dossiers} world={world} onOpen={onSelectEmployee} onDirect={onDirectEmployee} onManage={onManageEmployee} onInvite={onInvite} /> : null}
      {activeTab === 'tasks' ? <Suspense fallback={<div className="dock-empty-state" role="status"><strong>{t('dock.loadingTasks', '正在加载任务工作台')}</strong></div>}><TaskWorkspace world={world} employees={employees} /></Suspense> : null}
      {activeTab === 'knowledge' ? knowledgeContent ?? <Suspense fallback={<div className="dock-empty-state" role="status"><strong>{t('dock.loadingKnowledge', '正在加载知识库')}</strong></div>}><KnowledgeDock world={world} demoMode={demoMode} /></Suspense> : null}
      {activeTab === 'artifacts' ? artifactContent ?? <ArtifactEmptyState /> : null}
      {activeTab === 'trace' ? traceContent : null}
      {activeTab === 'schedule' ? scheduleContent : null}
    </div>
  </section>
}

function DockTabButton({ tab, active, closable = false, buttonRef, onSelect, onKeyDown, onClose }: { tab: { id: DockTab; label: string; icon: typeof GlobeHemisphereWest }; active: boolean; closable?: boolean; buttonRef?(element: HTMLButtonElement | null): void; onSelect(): void; onKeyDown?(event: KeyboardEvent<HTMLButtonElement>): void; onClose?(): void }) {
  const Icon = tab.icon
  return <div className={`dock-tab${active ? ' is-active' : ''}`} role="presentation">
    <button id={`world-side-dock-tab-${tab.id}`} ref={buttonRef} type="button" role="tab" aria-selected={active} aria-controls="world-side-dock-panel" tabIndex={active ? 0 : -1} className="dock-tab__select" aria-label={tab.label} title={tab.label} onClick={onSelect} onKeyDown={onKeyDown}><Icon size={15} aria-hidden="true" /><span>{tab.label}</span></button>
    {closable && onClose !== undefined ? <button type="button" className="dock-tab__close" aria-label={`关闭${tab.label}页签`} title={`关闭${tab.label}`} onClick={onClose}><X size={13} aria-hidden="true" /></button> : null}
  </div>
}

function setTabButtonRef(refs: Map<DockTab, HTMLButtonElement>, tab: DockTab, element: HTMLButtonElement | null): void {
  if (element === null) refs.delete(tab)
  else refs.set(tab, element)
}

function isSecondaryTab(tab: DockTab): tab is Exclude<DockTab, 'world' | 'trace'> {
  return SECONDARY_TAB_IDS.has(tab as Exclude<DockTab, 'world' | 'trace'>)
}

function isOpenSecondaryTab(tab: DockTab, openTabs: Exclude<DockTab, 'world' | 'trace'>[]): boolean {
  return isSecondaryTab(tab) && openTabs.includes(tab)
}

function storageKey(worldId: string): string { return `${DOCK_TABS_STORAGE_PREFIX}${worldId}` }

function readOpenTabs(worldId: string): Exclude<DockTab, 'world' | 'trace'>[] {
  if (typeof window === 'undefined') return []
  try {
    const parsed = JSON.parse(window.localStorage.getItem(storageKey(worldId)) ?? '[]') as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((tab): tab is Exclude<DockTab, 'world' | 'trace'> => typeof tab === 'string' && SECONDARY_TAB_IDS.has(tab as Exclude<DockTab, 'world' | 'trace'>))
  } catch { return [] }
}

function ArtifactEmptyState() {
  return <div className="dock-empty-state" aria-label="产物空状态"><span className="dock-empty-state__mark" aria-hidden="true"><Cube size={22} /></span><h2>还没有已发布产物</h2><p>完成工作后从工作目录明确发布，稳定版本和来源会出现在这里。</p></div>
}

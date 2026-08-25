import {
  CalendarBlank,
  CaretDoubleRight,
  Cube,
  GlobeHemisphereWest,
  IdentificationBadge,
  Package,
  Path,
} from '@phosphor-icons/react'
import { lazy, Suspense, type ReactNode } from 'react'
import type { EmployeeDossier as EmployeeDossierData, World } from '@dsh-cyber/contracts'

import type { CyberEmployee, DockTab } from '../types.js'
import { EmployeeDossier } from './EmployeeDossier.js'
import { EmployeeDossierDirectory } from './EmployeeDossierDirectory.js'
import { WorldView } from './WorldView.js'

const KnowledgeDock = lazy(async () => ({ default: (await import('../features/knowledge/KnowledgeDock.js')).KnowledgeDock }))

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

const tabs: Array<{ id: DockTab; label: string; icon: typeof GlobeHemisphereWest }> = [
  { id: 'world', label: '世界', icon: GlobeHemisphereWest },
  { id: 'dossier', label: '角色', icon: IdentificationBadge },
  { id: 'knowledge', label: '知识', icon: Cube },
  { id: 'artifacts', label: '产物', icon: Package },
  { id: 'trace', label: '轨迹', icon: Path },
  { id: 'schedule', label: '日程', icon: CalendarBlank },
]

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
  const selectTab = (tab: DockTab) => {
    if (tab === 'dossier') onShowAllDossiers()
    onTabChange(tab)
  }
  return <section className="artifact-dock world-side-dock" aria-label="世界与角色侧边栏">
    <header className="dock-tabs">
      <nav aria-label="世界侧栏">
        {tabs.map((tab) => {
          const Icon = tab.icon
          return <button key={tab.id} type="button" className={activeTab === tab.id ? 'is-active' : ''} aria-label={tab.label} title={tab.label} onClick={() => selectTab(tab.id)}><Icon size={15} aria-hidden="true" /><span>{tab.label}</span></button>
        })}
      </nav>
      <button className="icon-button" type="button" aria-label="收起侧边栏" title="收起侧边栏" onClick={onCollapse}><CaretDoubleRight size={17} /></button>
    </header>
    <div className="dock-content">
      {activeTab === 'world' ? worldContent ?? <WorldView world={world} employees={employees} {...(sceneImage === undefined ? {} : { sceneImage })} onSelectEmployee={onSelectEmployee} /> : null}
      {activeTab === 'dossier' ? selectedEmployee !== undefined && dossiers[selectedEmployee.id] !== undefined ? <EmployeeDossier dossier={dossiers[selectedEmployee.id]!} employees={employees} world={world} avatarIndex={selectedEmployee.avatarIndex} onDirect={() => onDirectEmployee(selectedEmployee)} onManage={() => onManageEmployee(selectedEmployee)} onBack={onShowAllDossiers} /> : <EmployeeDossierDirectory employees={employees} dossiers={dossiers} world={world} onOpen={onSelectEmployee} onDirect={onDirectEmployee} onManage={onManageEmployee} onInvite={onInvite} /> : null}
      {activeTab === 'knowledge' ? knowledgeContent ?? <Suspense fallback={<div className="dock-empty-state" role="status"><strong>正在加载知识库</strong></div>}><KnowledgeDock world={world} demoMode={demoMode} /></Suspense> : null}
      {activeTab === 'artifacts' ? artifactContent ?? <ArtifactEmptyState /> : null}
      {activeTab === 'trace' ? traceContent : null}
      {activeTab === 'schedule' ? scheduleContent : null}
    </div>
  </section>
}

function ArtifactEmptyState() {
  return <div className="dock-empty-state" aria-label="产物空状态"><span className="dock-empty-state__mark" aria-hidden="true"><Cube size={22} /></span><h2>还没有已发布产物</h2><p>完成工作后从工作目录明确发布，稳定版本和来源会出现在这里。</p></div>
}

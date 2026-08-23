import {
  CaretDoubleRight,
  GlobeHemisphereWest,
  IdentificationBadge,
} from '@phosphor-icons/react'
import type { ReactNode } from 'react'
import type { EmployeeDossier as EmployeeDossierData, World } from '@dsh-cyber/contracts'

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
  world: World
  sceneImage?: string
  worldContent?: ReactNode
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
  { id: 'dossier', label: '档案', icon: IdentificationBadge },
]

/**
 * Right-side product dock intentionally exposes only World and Dossier.
 * Files and previews remain backend capabilities but are hidden until their
 * information architecture is ready; role management belongs to Dossier.
 */
export function ArtifactDock({
  demoMode,
  activeTab,
  selectedEmployee,
  dossiers,
  employees,
  world,
  sceneImage,
  worldContent,
  onTabChange,
  onCollapse,
  onSelectEmployee,
  onDirectEmployee,
  onManageEmployee,
  onShowAllDossiers,
  onInvite,
}: ArtifactDockProps) {
  const visibleTab: DockTab = activeTab === 'dossier' ? 'dossier' : 'world'

  return (
    <section className="artifact-dock" aria-label="世界与角色档案侧边栏">
      <header className="dock-tabs">
        <nav aria-label="侧边栏">
          {tabs.map((tab) => {
            const Icon = tab.icon
            return (
              <button
                key={tab.id}
                type="button"
                className={visibleTab === tab.id ? 'is-active' : ''}
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
        {visibleTab === 'world' ? (
          worldContent ?? <WorldView world={world} employees={employees} {...(sceneImage === undefined ? {} : { sceneImage })} onSelectEmployee={onSelectEmployee} onInvite={onInvite} />
        ) : null}
        {visibleTab === 'dossier' ? (
          selectedEmployee !== undefined && dossiers[selectedEmployee.id] !== undefined
            ? <EmployeeDossier
                dossier={dossiers[selectedEmployee.id]!}
                employees={employees}
                world={world}
                avatarIndex={selectedEmployee.avatarIndex}
                onDirect={() => onDirectEmployee(selectedEmployee)}
                onManage={() => onManageEmployee(selectedEmployee)}
                onBack={onShowAllDossiers}
              />
            : <EmployeeDossierDirectory
                employees={employees}
                dossiers={dossiers}
                world={world}
                onOpen={onSelectEmployee}
                onDirect={onDirectEmployee}
                onManage={onManageEmployee}
                onInvite={onInvite}
              />
        ) : null}
      </div>
    </section>
  )
}

import type {
  EmployeeDossier,
  EmployeeInstance,
  ModelProfile,
  WorkMessage,
  WorkSession,
  Workspace,
  WorkspacePreferences,
  World,
} from '@dsh-cyber/contracts'

export type DockTab = 'files' | 'preview' | 'browser' | 'world' | 'dossier'

export interface CyberEmployee extends EmployeeInstance {
  avatarIndex: number
  summary: string
  currentActivity: string
}

export interface WorkbenchData {
  workspace: Workspace
  worlds: World[]
  activeWorld: World
  employees: CyberEmployee[]
  sessions: WorkSession[]
  messages: WorkMessage[]
  preferences: WorkspacePreferences
  modelProfiles: ModelProfile[]
  dossiers: Record<string, EmployeeDossier>
}

export interface ToolStep {
  id: string
  label: string
  target: string
  status: 'complete' | 'running' | 'failed'
  duration?: string
}


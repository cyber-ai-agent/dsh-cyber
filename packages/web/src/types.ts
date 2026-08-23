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

export type DockTab = 'world' | 'trace' | 'schedule' | 'dossier'

export interface ConversationIntent {
  kind: 'direct' | 'group'
  employeeIds: string[]
  title: string
}

export type SessionParticipantMap = Record<string, string[]>

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

import type {
  CharacterAvatarProfile,
  EmployeeDossier,
  EmployeeInstance,
  ModelProfile,
  WorkMessage,
  WorkSession,
  Workspace,
  WorkspacePreferences,
  World,
  WorldCharacterPermission,
  WorldCharacterRole,
} from '@dsh-cyber/contracts'

export type DockTab = 'world' | 'dossier' | 'tasks' | 'knowledge' | 'artifacts' | 'trace' | 'schedule'

export interface ConversationIntent {
  kind: 'direct' | 'group'
  employeeIds: string[]
  title: string
  collaborationMode?: 'discussion' | 'task'
}

export type SessionParticipantMap = Record<string, string[]>

export interface CyberEmployee extends EmployeeInstance {
  avatarIndex: number
  avatarProfile?: CharacterAvatarProfile | undefined
  avatarAssetUrl?: string | undefined
  summary: string
  currentActivity: string
  /** Compact world-scoped authority projection used by every visual surface. */
  authorityRole?: WorldCharacterRole
  worldPermissions?: WorldCharacterPermission[]
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

export const CYBER_SCHEMA_VERSION = 5 as const

export type IsoTimestamp = string
export type JsonPrimitive = boolean | number | string | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

export type WorkspaceStatus = 'active' | 'archived'

export interface Workspace {
  id: string
  name: string
  status: WorkspaceStatus
  createdAt: IsoTimestamp
  updatedAt: IsoTimestamp
}

export type WorldStatus = 'active' | 'archived'

export interface World {
  id: string
  workspaceId: string
  name: string
  templateId: string
  status: WorldStatus
  createdAt: IsoTimestamp
  updatedAt: IsoTimestamp
}

export interface WorldTemplateManifest {
  schemaVersion: 1
  id: string
  version: number
  displayName: string
  summary: string
  terminology: JsonObject
}

export type CyberPackageKind =
  | 'plugin'
  | 'skill'
  | 'employee-blueprint'
  | 'world-theme'
  | 'asset'
  | 'model-provider'

export interface CyberPackageFile {
  path: string
  sha256: string
}

export interface CyberPackageManifest {
  schemaVersion: 1
  id: string
  version: string
  kind: CyberPackageKind
  displayName: string
  summary: string
  license: string
  publisher: string
  capabilities: string[]
  dataEgress: string[]
  files: CyberPackageFile[]
}

export type InstalledPackageStatus = 'active' | 'superseded' | 'disabled'

export interface InstalledPackage {
  workspaceId: string
  packageId: string
  version: string
  kind: CyberPackageKind
  status: InstalledPackageStatus
  installedPath: string
  capabilities: string[]
  manifest: CyberPackageManifest
  installedAt: IsoTimestamp
  updatedAt: IsoTimestamp
}

export type PackageInstallTransactionStatus =
  | 'approved'
  | 'staged'
  | 'activated'
  | 'rolled-back'
  | 'failed'

export interface PackageInstallTransaction {
  id: string
  workspaceId: string
  packageId: string
  version: string
  status: PackageInstallTransactionStatus
  previousVersion?: string
  approvedCapabilities: string[]
  errorCode?: string
  createdAt: IsoTimestamp
  updatedAt: IsoTimestamp
}

export interface PackagePermissionPreview {
  workspaceId: string
  packageId: string
  version: string
  capabilities: string[]
  addedCapabilities: string[]
  removedCapabilities: string[]
  dataEgress: string[]
  previousVersion?: string
  approvalToken: string
}

export interface EmployeeBlueprint {
  id: string
  version: number
  worldTemplateId: string
  displayName: string
  role: string
  summary: string
  persona: string
  requestedSkills: string[]
  requestedCapabilities: string[]
  createdAt: IsoTimestamp
}

export type EmployeeStatus = 'available' | 'working' | 'waiting' | 'blocked' | 'archived'

export interface EmployeeInstance {
  id: string
  workspaceId: string
  worldId: string
  blueprintId: string
  blueprintVersion: number
  displayName: string
  role: string
  status: EmployeeStatus
  currentRevision: number
  agentSessionId?: string
  createdAt: IsoTimestamp
  updatedAt: IsoTimestamp
  archivedAt?: IsoTimestamp
}

export interface EmployeeRevision {
  employeeId: string
  revision: number
  persona: string
  skillGrants: string[]
  capabilityGrants: string[]
  modelPolicy: JsonObject
  reason: string
  createdAt: IsoTimestamp
}

export interface EmployeeProfile {
  employeeId: string
  revision: number
  birthday?: string
  background: string
  personalityTraits: string[]
  appearance: JsonObject
  reason: string
  createdAt: IsoTimestamp
}

export type SkillEvidenceKind = 'task' | 'test' | 'review' | 'artifact' | 'training'
export type SkillEvidenceOutcome = 'observed' | 'passed' | 'failed'

export interface SkillEvidence {
  id: string
  workspaceId: string
  worldId: string
  employeeId: string
  skillId: string
  kind: SkillEvidenceKind
  outcome: SkillEvidenceOutcome
  summary: string
  sourceEventIds: string[]
  sourceMessageIds: string[]
  artifactRefs: string[]
  createdAt: IsoTimestamp
}

export type EmployeeSkillStatus = 'learning' | 'verified' | 'suspended'

export interface EmployeeSkill {
  employeeId: string
  skillId: string
  revision: number
  status: EmployeeSkillStatus
  evidenceIds: string[]
  reason: string
  createdAt: IsoTimestamp
}

export type EmployeeMilestoneCategory =
  | 'joined'
  | 'task'
  | 'delivery'
  | 'skill'
  | 'review'
  | 'promotion'
  | 'failure'
  | 'recovery'
  | 'celebration'
  | 'birthday'
  | 'reflection'

export interface EmployeeMilestone {
  id: string
  workspaceId: string
  worldId: string
  employeeId: string
  category: EmployeeMilestoneCategory
  title: string
  summary: string
  sourceEventIds: string[]
  sourceMessageIds: string[]
  artifactRefs: string[]
  occurredAt: IsoTimestamp
  createdAt: IsoTimestamp
}

export interface EmployeeDailyJournal {
  employeeId: string
  localDate: string
  revision: number
  summary: string
  highlights: string[]
  sourceEventIds: string[]
  sourceMessageIds: string[]
  createdAt: IsoTimestamp
}

export interface EmployeeRelationship {
  employeeId: string
  colleagueId: string
  collaborationCount: number
  reviewCount: number
  handoffCount: number
  lastInteractionAt: IsoTimestamp
  updatedAt: IsoTimestamp
}

export interface EmployeeDossier {
  employee: EmployeeInstance
  profile?: EmployeeProfile
  skills: EmployeeSkill[]
  evidence: SkillEvidence[]
  milestones: EmployeeMilestone[]
  journals: EmployeeDailyJournal[]
  relationships: EmployeeRelationship[]
}

export type ColorSchemePreference = 'system' | 'light' | 'dark'
export type InterfaceDensity = 'comfortable' | 'compact'
export type MotionPreference = 'system' | 'reduced' | 'full'
export type BackgroundFit = 'cover' | 'contain' | 'tile'

export interface WorkspacePreferences {
  workspaceId: string
  colorScheme: ColorSchemePreference
  skinId: string
  backgroundAssetRef?: string
  backgroundFit: BackgroundFit
  backgroundOpacity: number
  interfaceDensity: InterfaceDensity
  motion: MotionPreference
  leftPaneWidth: number
  rightPaneWidth: number
  updatedAt: IsoTimestamp
}

export type ModelProviderKind = 'deepseek' | 'openai-compatible-local' | 'openai-compatible-remote'
export type ModelApiKind = 'openai-completions' | 'openai-responses' | 'anthropic-messages'

export interface ModelProfile {
  id: string
  workspaceId: string
  displayName: string
  providerKind: ModelProviderKind
  baseUrl: string
  modelId: string
  api: ModelApiKind
  credentialEnvName?: string
  isDefault: boolean
  settings: JsonObject
  createdAt: IsoTimestamp
  updatedAt: IsoTimestamp
}

export type LocalAssetKind = 'background'

export interface LocalAsset {
  id: string
  workspaceId: string
  kind: LocalAssetKind
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp'
  sha256: string
  relativePath: string
  byteLength: number
  createdAt: IsoTimestamp
}

export type WorkSessionKind = 'direct' | 'group' | 'meeting' | 'task'
export type WorkSessionStatus = 'open' | 'completed' | 'archived'

export interface WorkSession {
  id: string
  workspaceId: string
  worldId: string
  kind: WorkSessionKind
  title: string
  status: WorkSessionStatus
  createdAt: IsoTimestamp
  updatedAt: IsoTimestamp
}

export type ParticipantKind = 'owner' | 'employee' | 'system'

export interface WorkSessionParticipant {
  sessionId: string
  participantId: string
  kind: ParticipantKind
  joinedAt: IsoTimestamp
}

export type MessageKind =
  | 'user'
  | 'assistant'
  | 'reasoning'
  | 'tool-call'
  | 'tool-result'
  | 'system'

export interface WorkMessage {
  id: string
  sessionId: string
  sequence: number
  senderId: string
  senderKind: ParticipantKind
  kind: MessageKind
  content: string
  metadata: JsonObject
  createdAt: IsoTimestamp
}

export const DOMAIN_EVENT_TYPES = [
  'workspace.created',
  'world.created',
  'world.entered',
  'employee.recruited',
  'employee.revised',
  'employee.archived',
  'employee.profile.revised',
  'skill.evidence.recorded',
  'employee.skill.revised',
  'employee.milestone.recorded',
  'employee.journal.written',
  'employee.relationship.updated',
  'celebration.started',
  'celebration.finished',
  'workspace.preferences.updated',
  'model.profile.updated',
  'local.asset.saved',
  'session.created',
  'session.participant.joined',
  'message.appended',
  'meeting.started',
  'meeting.finished',
  'turn.started',
  'turn.completed',
  'turn.failed',
  'tool.started',
  'tool.completed',
  'task.started',
  'task.waiting',
  'task.blocked',
  'task.completed',
  'package.install.approved',
  'package.install.staged',
  'package.install.activated',
  'package.install.rolled-back',
] as const

export type DomainEventType = (typeof DOMAIN_EVENT_TYPES)[number]

export interface DomainEvent<TPayload extends JsonObject = JsonObject> {
  id: string
  workspaceId: string
  sequence: number
  type: DomainEventType
  actorId: string
  actorKind: ParticipantKind
  worldId?: string
  sessionId?: string
  causationId?: string
  correlationId?: string
  payload: TPayload
  createdAt: IsoTimestamp
}

export interface WorkspaceSnapshot {
  workspace: Workspace
  worlds: World[]
  lastEventSequence: number
}

export interface WorldSnapshot {
  workspace: Workspace
  world: World
  employees: EmployeeInstance[]
  openSessions: WorkSession[]
  lastEventSequence: number
}

export type AgentRuntimeEventKind =
  | 'turn.started'
  | 'reasoning.delta'
  | 'text.delta'
  | 'assistant.reasoning'
  | 'assistant.message'
  | 'tool.started'
  | 'tool.completed'
  | 'turn.completed'
  | 'turn.failed'

export interface AgentRuntimeEvent {
  kind: AgentRuntimeEventKind
  source: string
  sourceSessionId: string
  sourceSequence?: number
  sourceTime?: number
  content?: string
  toolName?: string
  callId?: string
  failed?: boolean
  metadata: JsonObject
}

export interface AgentTurnRequest {
  agent: EmployeeInstance
  revision: EmployeeRevision
  prompt: string
  workspacePath: string
  onEvent?: (event: AgentRuntimeEvent) => void
}

export interface AgentTurnResult {
  agentSessionId: string
  finalResponse: string
  eventCount: number
}

export interface AgentRuntimePort {
  runTurn(request: AgentTurnRequest): Promise<AgentTurnResult>
  closeAgent?(agentId: string): Promise<void>
  close(): Promise<void>
}

export interface DatabaseDoctorReport {
  path: string
  ok: boolean
  readOnly: boolean
  schemaVersion: number
  integrity: string[]
  journalMode?: string
  foreignKeysEnabled?: boolean
  counts: {
    workspaces: number
    worlds: number
    employees: number
    employeeProfiles: number
    skillEvidence: number
    employeeSkills: number
    employeeMilestones: number
    employeeJournals: number
    employeeRelationships: number
    workspacePreferences: number
    modelProfiles: number
    localAssets: number
    sessions: number
    messages: number
    installedPackages: number
    packageTransactions: number
    events: number
    outbox: number
  }
  errors: string[]
}

export function isDomainEventType(value: string): value is DomainEventType {
  return (DOMAIN_EVENT_TYPES as readonly string[]).includes(value)
}

export const CYBER_SCHEMA_VERSION = 14 as const

export type IsoTimestamp = string
export type JsonPrimitive = boolean | number | string | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

export type {
  EmbodimentPresetDescriptor,
  EmbodimentProfile,
  EmbodimentSocialPolicy,
} from './embodiment.js'

export type ReasoningEffort = 'auto' | 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type AgentPermissionMode = 'read-only' | 'workspace-write' | 'danger-full-access'

export type TaskScheduleKind = 'once' | 'interval'
export type TaskScheduleStatus = 'active' | 'paused' | 'completed'
export type TaskScheduleRunStatus = 'running' | 'completed' | 'failed' | 'skipped'

export interface TaskSchedule {
  id: string
  workspaceId: string
  worldId: string
  employeeId: string
  title: string
  prompt: string
  kind: TaskScheduleKind
  scheduledAt: IsoTimestamp
  everySeconds?: number
  timeZone: string
  permissionMode: Exclude<AgentPermissionMode, 'danger-full-access'>
  status: TaskScheduleStatus
  nextRunAt?: IsoTimestamp
  lastRunAt?: IsoTimestamp
  createdAt: IsoTimestamp
  updatedAt: IsoTimestamp
}

export interface TaskScheduleRun {
  id: string
  scheduleId: string
  workspaceId: string
  worldId: string
  employeeId: string
  status: TaskScheduleRunStatus
  scheduledFor: IsoTimestamp
  startedAt: IsoTimestamp
  completedAt?: IsoTimestamp
  sessionId?: string
  summary?: string
  errorCode?: string
}

export interface WorldSettings {
  schemaVersion: 1
  worldId: string
  lore: string
  scenario: string
  userIdentity: {
    displayName: string
    worldRole: string
    addressAs: string
  }
  terminology: {
    characterSingular: string
    characterPlural: string
    addCharacterVerb: string
    groupConversation: string
    assignment: string
  }
  appearance: {
    accentColor: string
    pageBackground: string
    panelBackground: string
    ownerBubbleColor: string
    characterBubbleColor: string
    textColor: string
    mutedTextColor: string
    panelRadius: number
    bubbleRadius: number
    buttonRadius: number
    fontScale: number
  }
  model: {
    defaultModelProfileId?: string
    reasoningEffort: ReasoningEffort
  }
  runtime: {
    permissionMode: AgentPermissionMode
  }
  updatedAt: IsoTimestamp
}

export interface WorldAccessSummary {
  worldId: string
  passwordEnabled: boolean
  unlocked: boolean
}

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

export type CyberPackageEntrypointKind = 'prompt-transform' | 'employee-blueprint' | 'world-theme' | 'skill'

export interface CyberPackageEntrypoint {
  id: string
  kind: CyberPackageEntrypointKind
  path: string
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
  entrypoints?: CyberPackageEntrypoint[]
  certification?: {
    authority: string
    level: 'official' | 'community'
    contentSha256: string
  }
}

export type CyberMarketKind = 'theme' | 'plugin' | 'talent'

export interface CyberMarketCommand {
  trigger: string
  description: string
}

/** A safe, user-facing command exposed by an installed global plugin. */
export interface InstalledPluginCommand {
  packageId: string
  packageVersion: string
  displayName: string
  summary: string
  trigger: string
  displayTrigger: string
  description: string
  automatic: boolean
}

export type CyberMarketActivation =
  | {
      kind: 'world-theme'
      themeId: string
      themeVersion: string
      templateId: string
    }
  | {
      kind: 'prompt-transform'
      automatic: boolean
      commands: CyberMarketCommand[]
    }
  | {
      kind: 'employee-blueprint'
      blueprintId: string
      blueprintVersion: number
      worldTemplateId: string
    }

export interface CyberMarketPackage {
  market: CyberMarketKind
  manifest: CyberPackageManifest
  sourceDirectory: string
  verified: boolean
  installedVersion?: string
  activation?: CyberMarketActivation
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
  approvalExpiresAt: IsoTimestamp
}

export type RuntimeUpdateStatus =
  | 'verified'
  | 'contract-tested'
  | 'canary-passed'
  | 'activated'
  | 'rejected'
  | 'rolled-back'

export interface RuntimeUpdateTransaction {
  id: string
  candidateRoot: string
  version: string
  contractId: string
  status: RuntimeUpdateStatus
  previousRuntimeRoot?: string
  report: JsonObject
  errorCode?: string
  createdAt: IsoTimestamp
  updatedAt: IsoTimestamp
}

export interface EmployeeBlueprint {
  schemaVersion: 1
  id: string
  version: number
  worldTemplateId: string
  displayName: string
  role: string
  summary: string
  persona: string
  requestedSkills: string[]
  requestedCapabilities: string[]
  embodiment?: import('./embodiment.js').EmbodimentProfile
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

export type CharacterBlueprint = EmployeeBlueprint
export type CharacterInstance = EmployeeInstance

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

export type CharacterRevision = EmployeeRevision

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

export type CharacterProfile = EmployeeProfile

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
  revisions: EmployeeRevision[]
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

export type ModelInteractionLogStatus = 'success' | 'failed'
export type ModelInteractionLogSource = 'turn' | 'discovery'

/**
 * 一条模型交互日志。隐私红线：绝不保存 API 密钥、prompt 明文或响应明文，
 * 只保存请求摘要统计（消息数 / 字符数）与可读的错误信息（不含密钥）。
 */
export interface ModelInteractionLog {
  id: string
  workspaceId: string
  worldId?: string
  sessionId?: string
  employeeId?: string
  /** 采集来源：turn=对话回合（服务端发起的整轮交互），discovery=/models 模型发现 */
  source: ModelInteractionLogSource
  modelId: string
  /** provider 展示名（模型配置显示名，或默认 DSH 模型） */
  provider: string
  status: ModelInteractionLogStatus
  errorCode?: string
  errorMessage?: string
  /** 模型接口返回的 HTTP 状态码（如 200/401/429/502）；worker 未透出时为空 */
  httpStatus?: number
  /** 请求摘要：发送给模型的消息条数（turn 级为 1 条用户消息 + 工具回填条数，近似） */
  promptMessageCount: number
  /** 请求摘要：prompt 字符数 */
  promptCharCount: number
  responseCharCount?: number
  toolCallCount?: number
  durationMs: number
  /** 仅当接口真实返回 token 用量时填写 */
  tokensPrompt?: number
  tokensCompletion?: number
  tokensTotal?: number
  createdAt: IsoTimestamp
}

export interface RecordModelInteractionInput {
  workspaceId: string
  worldId?: string
  sessionId?: string
  employeeId?: string
  source: ModelInteractionLogSource
  modelId: string
  provider: string
  status: ModelInteractionLogStatus
  errorCode?: string
  errorMessage?: string
  httpStatus?: number
  promptMessageCount: number
  promptCharCount: number
  responseCharCount?: number
  toolCallCount?: number
  durationMs: number
  tokensPrompt?: number
  tokensCompletion?: number
  tokensTotal?: number
}

export interface ModelInteractionLogFilter {
  status?: ModelInteractionLogStatus
  modelId?: string
  page: number
  pageSize: number
}

export interface ModelInteractionLogPage {
  items: ModelInteractionLog[]
  total: number
  page: number
  pageSize: number
  /** 该工作区出现过（去重）的模型 ID，用于前端筛选下拉 */
  modelIds: string[]
}


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

export type ModelAssignmentScope = 'workspace' | 'world' | 'employee'

export interface ModelAssignment {
  workspaceId: string
  scope: ModelAssignmentScope
  scopeId: string
  modelProfileId: string
  updatedAt: IsoTimestamp
}

export type LocalAssetKind = 'background' | 'attachment'
export type LocalAssetMimeType =
  | 'image/png'
  | 'image/jpeg'
  | 'image/webp'
  | 'text/plain'
  | 'text/markdown'
  | 'application/json'
  | 'application/pdf'

export interface LocalAsset {
  id: string
  workspaceId: string
  kind: LocalAssetKind
  mimeType: LocalAssetMimeType
  sha256: string
  relativePath: string
  byteLength: number
  createdAt: IsoTimestamp
}

export interface ChatAttachment {
  assetId: string
  name: string
  mimeType: LocalAssetMimeType
  byteLength: number
  url: string
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
  'world.creation.rolled-back',
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
  'model.assignment.updated',
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
  'schedule.created',
  'schedule.updated',
  'schedule.run.started',
  'schedule.run.completed',
  'schedule.run.failed',
  'world.interaction.requested',
  'world.interaction.completed',
  'world.object.activated',
  'world.lights.changed',
  'world.runtime.snapshot.saved',
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
  reasoningEffort?: Exclude<ReasoningEffort, 'auto'>
  permissionMode?: AgentPermissionMode
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
    modelAssignments: number
    localAssets: number
    sessions: number
    messages: number
    installedPackages: number
    packageTransactions: number
    runtimeUpdates: number
    worldRuntimeSnapshots: number
    worldEntityStates: number
    worldObjectStates: number
    worldThemeBindings: number
    modelInteractionLogs: number
    taskSchedules: number
    taskScheduleRuns: number
    events: number
    outbox: number
  }
  errors: string[]
}

export function isDomainEventType(value: string): value is DomainEventType {
  return (DOMAIN_EVENT_TYPES as readonly string[]).includes(value)
}

export * from './world-runtime.js'
export * from './world-trace.js'

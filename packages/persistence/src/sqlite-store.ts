import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, open, rename, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { DatabaseSync, backup } from 'node:sqlite'

import {
  CYBER_SCHEMA_VERSION,
  RECOMMENDED_ADMIN_PERMISSIONS,
  WORKSPACE_PREFERENCES_LIMITS,
  parseWorkspacePaneWidth,
  type AgentPermissionMode,
  type ConversationQueueEntry,
  type ConversationQueueEntryStatus,
  type CompletionJob,
  type CompletionJobDraft,
  type CharacterAvatarAsset,
  type CharacterAvatarAssetRendererKind,
  isWorldCharacterPermission,
  isDomainEventType,
  type DatabaseDoctorReport,
  type DomainEvent,
  type DomainEventType,
  type EmployeeBlueprint,
  type EmployeeDailyJournal,
  type EmployeeDossier,
  type EmployeeHealth,
  type EmployeeInstance,
  type EmployeeMilestone,
  type EmployeeMilestoneCategory,
  type EmployeeMemoryIndexEntry,
  type EmployeeMemoryIndexHit,
  type EmployeeMemoryScope,
  type EmployeeProfile,
  type EmployeeVoiceProfile,
  type CharacterGender,
  type EmployeeRelationship,
  type EmployeeRevision,
  type EmployeeSkill,
  type EmployeeSkillStatus,
  type EmployeeStatus,
  type JsonObject,
  type JsonValue,
  type LocalAsset,
  type LocalAssetKind,
  type ModelAssignment,
  type ModelAssignmentScope,
  type ModelApiKind,
  type ModelInteractionLog,
  type ModelInteractionLogFilter,
  type ModelInteractionLogPage,
  type ModelInteractionLogSource,
  type ModelInteractionLogStatus,
  type ModelProfile,
  type ModelProviderKind,
  type OwnerRuntimeAccessGrant,
  type CyberPackageManifest,
  type InstalledPackage,
  type PackageInstallTransaction,
  type ParticipantKind,
  type RecordModelInteractionInput,
  type RuntimeUpdateStatus,
  type RuntimeUpdateTransaction,
  type ReasoningEffort,
  type TaskCollaborationExecutionMode,
  type TaskCollaborationPlan,
  type TaskCollaborationPlanStatus,
  type TaskCollaborationStep,
  type TaskCollaborationStepStatus,
  type SkillEvidence,
  type SkillEvidenceKind,
  type SkillEvidenceOutcome,
  type AgentRun,
  type ApprovalPolicy,
  type ApprovalRequest,
  type ApprovalRisk,
  type ApprovalScope,
  type ApprovalStatus,
  type ApprovalSubjectType,
  type WorkTurn,
  type WorkTurnInteractionKind,
  type WorkMessage,
  type WorkSession,
  type WorkSessionCollaborationMode,
  type WorkSessionKind,
  type WorkSessionParticipant,
  type World,
  type WorldRuntimeEntityState,
  type WorldRuntimeObjectState,
  type WorldRuntimeSnapshot,
  type WorldThemeBinding,
  type WorldThemeManifestV1,
  type WorldPackageInstance,
  type WorldSnapshot,
  type Workspace,
  type WorkspacePreferences,
  type UiLocale,
  type WorkspaceSnapshot,
} from '@dsh-cyber/contracts'
import type { CharacterSkillAction } from '@dsh-cyber/contracts/skill-runtime'

import { DatabaseCorruptError, EntityNotFoundError, PersistenceError } from './errors.js'
import { CompletionJobRepository } from './completion-job-repository.js'
import {
  EmployeeMemoryIndexRepository,
  type MemoryIndexSearchCapability,
  type SearchEmployeeMemoryIndexInput,
  type UpsertEmployeeMemoryIndexEntryInput,
} from './employee-memory-index-repository.js'
import { migrate, readUserVersion } from './migrations.js'
import { assertSecretFree } from './secrets.js'
import {
  WorldCharacterAuthorityRepository,
  type AppendWorldAuthorityChangeInput,
  type CommitWorldAuthorityChangeInput,
  type SaveWorldCharacterAuthorityInput,
} from './world-character-authority-repository.js'

type Clock = () => string

export interface StoreOptions {
  readOnly?: boolean
  clock?: Clock
  idFactory?: () => string
}

export interface CreateWorkspaceInput {
  name: string
  actorId?: string
}

export interface RenameWorldInput {
  worldId: string
  name: string
  actorId?: string
  actorKind?: ParticipantKind
}

export interface CreateWorldInput {
  workspaceId: string
  name: string
  templateId: string
  actorId?: string
}

export interface RecruitEmployeeInput {
  workspaceId: string
  worldId: string
  blueprintId: string
  blueprintVersion: number
  displayName?: string
  role?: string
  gender?: CharacterGender
  persona?: string
  skillGrants?: string[]
  capabilityGrants?: string[]
  modelPolicy?: JsonObject
  runtimePermissionMode?: AgentPermissionMode
  reason?: string
  actorId?: string
}

export interface ReviseEmployeeInput {
  employeeId: string
  persona?: string
  skillGrants?: string[]
  capabilityGrants?: string[]
  modelPolicy?: JsonObject
  runtimePermissionMode?: AgentPermissionMode
  reason: string
  actorId?: string
}

export interface ReviseEmployeeProfileInput {
  employeeId: string
  displayName?: string
  role?: string
  gender?: CharacterGender
  voiceProfile?: EmployeeVoiceProfile
  birthday?: string | null
  background?: string
  personalityTraits?: string[]
  appearance?: JsonObject
  reason: string
  actorId?: string
}

export interface RecordSkillEvidenceInput {
  employeeId: string
  skillId: string
  kind: SkillEvidenceKind
  outcome: SkillEvidenceOutcome
  summary: string
  sourceEventIds?: string[]
  sourceMessageIds?: string[]
  artifactRefs?: string[]
  actorId?: string
}

export interface ReviseEmployeeSkillInput {
  employeeId: string
  skillId: string
  status: EmployeeSkillStatus
  evidenceIds?: string[]
  reason: string
  actorId?: string
}

export interface AppendEmployeeMilestoneInput {
  employeeId: string
  category: EmployeeMilestoneCategory
  title: string
  summary: string
  sourceEventIds?: string[]
  sourceMessageIds?: string[]
  artifactRefs?: string[]
  occurredAt?: string
  actorId?: string
}

export interface WriteEmployeeJournalInput {
  employeeId: string
  localDate: string
  summary: string
  highlights?: string[]
  sourceEventIds?: string[]
  sourceMessageIds?: string[]
  actorId?: string
}

export interface RecordEmployeeInteractionInput {
  employeeId: string
  colleagueId: string
  sessionId: string
  kind: 'collaboration' | 'review' | 'handoff'
  actorId?: string
}

export interface UpdateWorkspacePreferencesInput {
  workspaceId: string
  locale?: UiLocale
  colorScheme?: WorkspacePreferences['colorScheme']
  skinId?: string
  backgroundAssetRef?: string | null
  backgroundFit?: WorkspacePreferences['backgroundFit']
  backgroundOpacity?: number
  interfaceDensity?: WorkspacePreferences['interfaceDensity']
  motion?: WorkspacePreferences['motion']
  leftPaneWidth?: number
  rightPaneWidth?: number
  actorId?: string
}

export interface SaveModelProfileInput {
  id?: string
  workspaceId: string
  displayName: string
  providerKind: ModelProviderKind
  baseUrl: string
  modelId: string
  api: ModelApiKind
  credentialEnvName?: string | null
  isDefault?: boolean
  settings?: JsonObject
  actorId?: string
}

export interface SaveModelAssignmentInput {
  workspaceId: string
  scope: ModelAssignmentScope
  scopeId: string
  modelProfileId: string
  actorId?: string
}

export type {
  ModelInteractionLog,
  ModelInteractionLogFilter,
  ModelInteractionLogPage,
  RecordModelInteractionInput,
} from '@dsh-cyber/contracts'

export interface SaveLocalAssetInput {
  id?: string
  workspaceId: string
  kind: LocalAssetKind
  mimeType: LocalAsset['mimeType']
  sha256: string
  relativePath: string
  byteLength: number
  actorId?: string
}

export interface SaveCharacterAvatarAssetInput {
  assetId: string
  workspaceId: string
  worldId: string
  employeeId: string
  rendererKind: CharacterAvatarAssetRendererKind
  originalName: string
  validation: JsonObject
}

export interface CreateSessionInput {
  workspaceId: string
  worldId: string
  kind: WorkSessionKind
  title: string
  collaborationMode?: WorkSessionCollaborationMode
  participants?: Array<{ participantId: string; kind: ParticipantKind }>
  actorId?: string
}

export interface UpdateSessionCollaborationModeInput {
  sessionId: string
  collaborationMode: WorkSessionCollaborationMode
  actorId?: string
}

export interface TaskCollaborationStepInput {
  id?: string
  requiredSkills: string[]
  assignedEmployeeIds: string[]
  dependsOn: string[]
  executionMode: TaskCollaborationExecutionMode
  status?: TaskCollaborationStepStatus
  errorCode?: string | null
}

export interface CreateTaskCollaborationPlanInput {
  id?: string
  taskId: string
  workspaceId: string
  worldId: string
  sessionId: string
  workTurnId: string
  status?: TaskCollaborationPlanStatus
  steps: TaskCollaborationStepInput[]
  actorId?: string
}

export interface UpdateTaskCollaborationPlanInput {
  planId: string
  /** Optimistic concurrency token. `revision` is accepted as a compatibility alias. */
  expectedRevision?: number
  revision?: number
  status?: TaskCollaborationPlanStatus
  steps?: TaskCollaborationStepInput[]
  errorCode?: string | null
  actorId?: string
}

export interface UpdateTaskCollaborationStepInput {
  planId: string
  stepId: string
  expectedRevision?: number
  revision?: number
  requiredSkills?: string[]
  assignedEmployeeIds?: string[]
  dependsOn?: string[]
  executionMode?: TaskCollaborationExecutionMode
  status?: TaskCollaborationStepStatus
  errorCode?: string | null
  actorId?: string
}

export interface TaskCollaborationRecoveryReport {
  plansInterrupted: number
  stepsInterrupted: number
}

export interface CreateWorkTurnInput {
  workspaceId: string
  worldId: string
  sessionId: string
  clientTurnId?: string
  interactionKind: WorkTurnInteractionKind
}

export interface EnqueueConversationTurnInput {
  id?: string
  workspaceId: string
  worldId: string
  sessionId: string
  workTurnId: string
  employeeIds: string[]
  conversationKind: WorkSessionKind
  collaborationMode?: WorkSessionCollaborationMode | undefined
  reasoningEffort?: Exclude<ReasoningEffort, 'auto'> | undefined
  permissionMode?: AgentPermissionMode | undefined
  priority?: number
  actorId?: string
}

export interface ClaimConversationQueueEntryInput {
  queueEntryId: string
  leaseOwner: string
  leaseDurationMs: number
  expectedRevision?: number
}

export interface CompleteConversationQueueEntryInput {
  queueEntryId: string
  expectedRevision?: number
}

export interface FailConversationQueueEntryInput {
  queueEntryId: string
  errorCode: string
  expectedRevision?: number
}

export interface RemoveConversationQueueEntryInput {
  queueEntryId: string
  expectedRevision?: number
  errorCode?: string
}

export interface ClearConversationQueueInput {
  workspaceId?: string
  worldId: string
  sessionId?: string
}

export interface ConversationQueueTransitionInput {
  queueEntryId: string
  expectedRevision?: number
}

export interface InterruptConversationQueueEntryInput extends ConversationQueueTransitionInput {
  errorCode?: string
}

export interface CreateAgentRunInput {
  workspaceId: string
  worldId: string
  turnId: string
  sessionId: string
  employeeId: string
  ordinal: number
}

export interface ConversationRuntimeRecoveryReport {
  turnsFailed: number
  runsFailed: number
}

export interface CreateApprovalRequestInput {
  workspaceId: string
  worldId: string
  sessionId?: string
  workTurnId?: string
  agentRunId?: string
  characterId?: string
  subjectType: ApprovalSubjectType
  subjectId: string
  risk: ApprovalRisk
  summary: string
  createdAt?: string
  expiresAt: string
}

export interface CreateApprovalPolicyInput {
  workspaceId: string
  worldId: string
  characterId?: string
  subjectType: ApprovalSubjectType
  skillId?: string
  action: string
  target: string
  risk: ApprovalRisk
  scope: Exclude<ApprovalScope, 'once'>
  sourceApprovalId: string
}

export interface AppendMessageInput {
  sessionId: string
  senderId: string
  senderKind: ParticipantKind
  kind: WorkMessage['kind']
  content: string
  metadata?: JsonObject
  causationId?: string
  correlationId?: string
}

export interface CommitAgentRunCompletionInput {
  runId: string
  runtimeSessionId?: string
  messages: AppendMessageInput[]
  completionJob?: CompletionJobDraft
}

export interface ListMessagesPageInput {
  /** Number of messages to return. The store clamps this to a safe range. */
  limit?: number
  /** Return messages before this sequence, newest first internally then restored to chat order. */
  beforeSequence?: number
  /** Compatibility cursor for consumers that append messages after a known sequence. */
  afterSequence?: number
  /** Search text matched against message content. */
  search?: string
  /** ISO calendar date (YYYY-MM-DD) matched against createdAt. */
  date?: string
  /** 1-based page number used by the history view. */
  page?: number
  /** Keep only user/assistant/system messages intended for the chat surface. */
  chatOnly?: boolean
}

export interface MessagePage {
  items: WorkMessage[]
  total: number
  page: number
  pageSize: number
  hasMore: boolean
  nextBefore?: number
  nextAfter?: number
}

export interface AppendDomainEventInput {
  workspaceId: string
  worldId?: string
  type: DomainEventType
  actorId: string
  actorKind: ParticipantKind
  payload?: JsonObject
  sessionId?: string
  causationId?: string
  correlationId?: string
}

export interface BeginPackageInstallInput {
  workspaceId: string
  manifest: CyberPackageManifest
  approvedCapabilities: string[]
  actorId?: string
}

export interface CompletePackageInstallInput {
  transactionId: string
  manifest: CyberPackageManifest
  installedPath: string
  actorId?: string
}

export interface PruneHistoryInput {
  /** ISO timestamp; rows created strictly before this are eligible. */
  before: string
  workspaceId?: string
}

export interface PruneHistoryResult {
  before: string
  workTurns: number
  agentRuns: number
  domainEvents: number
  modelInteractions: number
}

export interface RollbackPackageInstallInput {
  transactionId: string
  errorCode: string
  actorId?: string
}

export interface CreateWorldPackageInstanceInput {
  id?: string
  workspaceId: string
  worldId: string
  packageId: string
  packageVersion: string
  packageKind: InstalledPackage['kind']
  contentDigest: string
  originPath: string
  overridesPath: string
  actorId?: string
}

export interface BeginRuntimeUpdateInput {
  candidateRoot: string
  version: string
  contractId: string
  previousRuntimeRoot?: string
  report: JsonObject
}

export interface TransitionRuntimeUpdateInput {
  transactionId: string
  status: Exclude<RuntimeUpdateStatus, 'verified'>
  report: JsonObject
  errorCode?: string
}

export interface RecoveryExportReport {
  sourcePath: string
  destinationPath: string
  opened: boolean
  integrity: string[]
  tables: Record<string, { rows: number; error?: string }>
  errors: string[]
}

/** Hard cap on one batched message relocation, so hydration stays bounded. */
const MAX_MESSAGE_ID_LOOKUP = 64

const KNOWN_TABLES = [
  'schema_migrations',
  'workspaces',
  'worlds',
  'employee_blueprints',
  'employee_instances',
  'employee_revisions',
  'employee_profile_revisions',
  'skill_evidence',
  'employee_skill_revisions',
  'employee_milestones',
  'employee_memory_index',
  'employee_daily_journals',
  'employee_relationships',
  'workspace_preferences',
  'model_profiles',
  'model_assignments',
  'local_assets',
  'character_avatar_assets',
  'work_sessions',
  'owner_runtime_access_grants',
  'conversation_queue_entries',
  'task_collaboration_plans',
  'task_collaboration_steps',
  'work_turns',
  'agent_runs',
  'skill_actions',
  'approval_requests',
  'approval_policies',
  'work_session_participants',
  'messages',
  'installed_packages',
  'world_package_instances',
  'package_install_transactions',
  'runtime_update_transactions',
  'world_runtime_snapshots',
  'world_entity_states',
  'world_object_states',
  'world_theme_bindings',
  'model_interaction_logs',
  'task_schedules',
  'task_schedule_runs',
  'domain_events',
  'sync_outbox',
  'world_character_authorities',
  'world_authority_changes',
  'world_permission_requests',
  'world_artifacts',
  'world_artifact_versions',
  'knowledge_collections',
  'knowledge_documents',
  'knowledge_chunks',
  'knowledge_entities',
  'knowledge_evidence',
  'knowledge_claims',
  'knowledge_relations',
  'knowledge_conversation_cursors',
  'knowledge_consolidation_jobs',
  'world_knowledge_settings',
  'knowledge_suppressions',
] as const

export class SqliteStore {
  readonly databasePath: string
  readonly readOnly: boolean
  readonly database: DatabaseSync
  readonly #clock: Clock
  readonly #idFactory: () => string
  readonly #worldAuthorities: WorldCharacterAuthorityRepository
  readonly #completionJobs: CompletionJobRepository
  #memoryIndexRepository: EmployeeMemoryIndexRepository | undefined
  #closed = false

  private constructor(databasePath: string, database: DatabaseSync, options: StoreOptions) {
    this.databasePath = databasePath
    this.database = database
    this.readOnly = options.readOnly ?? false
    this.#clock = options.clock ?? (() => new Date().toISOString())
    this.#idFactory = options.idFactory ?? randomUUID
    this.#worldAuthorities = new WorldCharacterAuthorityRepository(this.database, {
      clock: this.#clock,
      idFactory: this.#idFactory,
    })
    this.#completionJobs = new CompletionJobRepository(this.database, {
      clock: this.#clock,
      idFactory: this.#idFactory,
    })
  }

  static async open(databasePath: string, options: StoreOptions = {}): Promise<SqliteStore> {
    const absolutePath = resolve(databasePath)
    const readOnly = options.readOnly ?? false
    const exists = await fileExists(absolutePath)

    if (readOnly && !exists) {
      throw new PersistenceError(`Cannot open missing database in read-only mode: ${absolutePath}`)
    }

    if (!readOnly) {
      await mkdir(dirname(absolutePath), { recursive: true })
      if (exists) await assertExistingDatabaseHealthy(absolutePath)
    }

    let database: DatabaseSync
    try {
      database = new DatabaseSync(absolutePath, { readOnly })
    } catch (error) {
      const preserved = readOnly ? undefined : await preserveCorruptCopy(absolutePath)
      throw new DatabaseCorruptError(
        `Unable to open SQLite database: ${errorMessage(error)}`,
        absolutePath,
        preserved,
      )
    }

    const store = new SqliteStore(absolutePath, database, { ...options, readOnly })
    try {
      store.#configure()
      if (!readOnly) {
        const previousVersion = readUserVersion(database)
        if (exists && previousVersion > 0 && previousVersion < CYBER_SCHEMA_VERSION) {
          const safeTime = store.#clock().replaceAll(/[^0-9A-Za-z.-]/g, '-')
          await backup(database, `${absolutePath}.pre-migration-v${previousVersion}-${safeTime}.sqlite`)
        }
        migrate(database, store.#clock)
      }
      return store
    } catch (error) {
      store.close()
      throw error
    }
  }

  close(): void {
    if (this.#closed) return
    this.database.close()
    this.#closed = true
  }

  createWorkspace(input: CreateWorkspaceInput): Workspace {
    this.#assertWritable()
    const now = this.#clock()
    const workspace: Workspace = {
      id: this.#idFactory(),
      name: input.name.trim(),
      status: 'active',
      createdAt: now,
      updatedAt: now,
    }
    if (!workspace.name) throw new PersistenceError('Workspace name cannot be empty')

    return this.#transaction(() => {
      this.database
        .prepare(
          `INSERT INTO workspaces (id, name, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          workspace.id,
          workspace.name,
          workspace.status,
          workspace.createdAt,
          workspace.updatedAt,
        )
      this.#appendEvent({
        workspaceId: workspace.id,
        type: 'workspace.created',
        actorId: input.actorId ?? 'owner',
        actorKind: 'owner',
        payload: { workspaceId: workspace.id, name: workspace.name },
      })
      return workspace
    })
  }

  getWorkspace(workspaceId: string): Workspace | undefined {
    const row = this.database.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId)
    return row ? mapWorkspace(row) : undefined
  }

  listWorkspaces(): Workspace[] {
    return this.database
      .prepare('SELECT * FROM workspaces ORDER BY created_at, id')
      .all()
      .map(mapWorkspace)
  }

  getWorkspacePreferences(workspaceId: string): WorkspacePreferences {
    const workspace = this.#requireWorkspace(workspaceId)
    const row = this.database
      .prepare('SELECT * FROM workspace_preferences WHERE workspace_id = ?')
      .get(workspaceId)
    if (row !== undefined) return mapWorkspacePreferences(row)
    return {
      workspaceId: workspace.id,
      locale: 'zh-CN',
      colorScheme: 'dark',
      skinId: 'cyber-graphite',
      backgroundFit: 'cover',
      backgroundOpacity: 0.18,
      interfaceDensity: 'compact',
      motion: 'system',
      leftPaneWidth: 288,
      rightPaneWidth: 660,
      updatedAt: workspace.updatedAt,
    }
  }

  updateWorkspacePreferences(input: UpdateWorkspacePreferencesInput): WorkspacePreferences {
    this.#assertWritable()
    const previous = this.getWorkspacePreferences(input.workspaceId)
    const backgroundAssetRef = input.backgroundAssetRef === undefined
      ? previous.backgroundAssetRef
      : input.backgroundAssetRef ?? undefined
    if (backgroundAssetRef !== undefined) assertLocalAssetRef(backgroundAssetRef)
    const preferences: WorkspacePreferences = {
      workspaceId: previous.workspaceId,
      locale: input.locale ?? previous.locale,
      colorScheme: input.colorScheme ?? previous.colorScheme,
      skinId: (input.skinId ?? previous.skinId).trim(),
      backgroundFit: input.backgroundFit ?? previous.backgroundFit,
      backgroundOpacity: input.backgroundOpacity ?? previous.backgroundOpacity,
      interfaceDensity: input.interfaceDensity ?? previous.interfaceDensity,
      motion: input.motion ?? previous.motion,
      leftPaneWidth: input.leftPaneWidth ?? previous.leftPaneWidth,
      rightPaneWidth: input.rightPaneWidth ?? previous.rightPaneWidth,
      updatedAt: this.#clock(),
    }
    if (backgroundAssetRef !== undefined) preferences.backgroundAssetRef = backgroundAssetRef
    if (!preferences.skinId) throw new PersistenceError('Skin id cannot be empty')
    if (
      preferences.backgroundOpacity < WORKSPACE_PREFERENCES_LIMITS.backgroundOpacity.minimum
      || preferences.backgroundOpacity > WORKSPACE_PREFERENCES_LIMITS.backgroundOpacity.maximum
    ) {
      throw new PersistenceError('Background opacity must be between 0 and 1')
    }
    try {
      parseWorkspacePaneWidth('leftPaneWidth', preferences.leftPaneWidth)
      parseWorkspacePaneWidth('rightPaneWidth', preferences.rightPaneWidth)
    } catch (error) {
      throw new PersistenceError(error instanceof Error ? error.message : 'Workspace pane width is invalid')
    }

    return this.#transaction(() => {
      this.database
        .prepare(
          `INSERT INTO workspace_preferences
           (workspace_id, locale, color_scheme, skin_id, background_asset_ref, background_fit,
            background_opacity, interface_density, motion, left_pane_width, right_pane_width,
            updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (workspace_id) DO UPDATE SET
             locale = excluded.locale,
             color_scheme = excluded.color_scheme,
             skin_id = excluded.skin_id,
             background_asset_ref = excluded.background_asset_ref,
             background_fit = excluded.background_fit,
             background_opacity = excluded.background_opacity,
             interface_density = excluded.interface_density,
             motion = excluded.motion,
             left_pane_width = excluded.left_pane_width,
             right_pane_width = excluded.right_pane_width,
             updated_at = excluded.updated_at`,
        )
        .run(
          preferences.workspaceId,
          preferences.locale,
          preferences.colorScheme,
          preferences.skinId,
          preferences.backgroundAssetRef ?? null,
          preferences.backgroundFit,
          preferences.backgroundOpacity,
          preferences.interfaceDensity,
          preferences.motion,
          preferences.leftPaneWidth,
          preferences.rightPaneWidth,
          preferences.updatedAt,
        )
      this.#appendEvent({
        workspaceId: preferences.workspaceId,
        type: 'workspace.preferences.updated',
        actorId: input.actorId ?? 'owner',
        actorKind: 'owner',
        payload: {
          colorScheme: preferences.colorScheme,
          skinId: preferences.skinId,
          backgroundFit: preferences.backgroundFit,
          backgroundOpacity: preferences.backgroundOpacity,
          interfaceDensity: preferences.interfaceDensity,
          motion: preferences.motion,
          leftPaneWidth: preferences.leftPaneWidth,
          rightPaneWidth: preferences.rightPaneWidth,
          hasBackgroundAsset: preferences.backgroundAssetRef !== undefined,
        },
      })
      return preferences
    })
  }

  saveModelProfile(input: SaveModelProfileInput): ModelProfile {
    this.#assertWritable()
    this.#requireWorkspace(input.workspaceId)
    const id = input.id?.trim() || this.#idFactory()
    const existing = this.getModelProfile(id)
    if (existing !== undefined && existing.workspaceId !== input.workspaceId) {
      throw new PersistenceError('Model profile cannot move between workspaces')
    }
    const displayName = input.displayName.trim()
    const modelId = input.modelId.trim()
    const baseUrl = normalizeModelBaseUrl(input.baseUrl, input.providerKind)
    const credentialEnvName = input.credentialEnvName?.trim() || undefined
    if (!displayName) throw new PersistenceError('Model profile name cannot be empty')
    if (!modelId) throw new PersistenceError('Model id cannot be empty')
    if (credentialEnvName !== undefined && !/^[A-Z_][A-Z0-9_]*$/.test(credentialEnvName)) {
      throw new PersistenceError('Credential environment variable name is invalid')
    }
    const now = this.#clock()
    const profile: ModelProfile = {
      id,
      workspaceId: input.workspaceId,
      displayName,
      providerKind: input.providerKind,
      baseUrl,
      modelId,
      api: input.api,
      isDefault: input.isDefault ?? existing?.isDefault ?? false,
      settings: input.settings ?? existing?.settings ?? {},
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    if (credentialEnvName !== undefined) profile.credentialEnvName = credentialEnvName
    assertSecretFree(profile.settings)

    return this.#transaction(() => {
      if (profile.isDefault) {
        this.database
          .prepare('UPDATE model_profiles SET is_default = 0, updated_at = ? WHERE workspace_id = ?')
          .run(now, profile.workspaceId)
      }
      this.database
        .prepare(
          `INSERT INTO model_profiles
           (id, workspace_id, display_name, provider_kind, base_url, model_id, api,
            credential_env_name, is_default, settings_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET
             display_name = excluded.display_name,
             provider_kind = excluded.provider_kind,
             base_url = excluded.base_url,
             model_id = excluded.model_id,
             api = excluded.api,
             credential_env_name = excluded.credential_env_name,
             is_default = excluded.is_default,
             settings_json = excluded.settings_json,
             updated_at = excluded.updated_at`,
        )
        .run(
          profile.id,
          profile.workspaceId,
          profile.displayName,
          profile.providerKind,
          profile.baseUrl,
          profile.modelId,
          profile.api,
          profile.credentialEnvName ?? null,
          profile.isDefault ? 1 : 0,
          stringifyJson(profile.settings),
          profile.createdAt,
          profile.updatedAt,
        )
      this.#appendEvent({
        workspaceId: profile.workspaceId,
        type: 'model.profile.updated',
        actorId: input.actorId ?? 'owner',
        actorKind: 'owner',
        payload: {
          modelProfileId: profile.id,
          providerKind: profile.providerKind,
          modelId: profile.modelId,
          api: profile.api,
          isDefault: profile.isDefault,
          hasCredentialReference: profile.credentialEnvName !== undefined,
        },
      })
      return profile
    })
  }

  getModelProfile(profileId: string): ModelProfile | undefined {
    const row = this.database.prepare('SELECT * FROM model_profiles WHERE id = ?').get(profileId)
    return row ? mapModelProfile(row) : undefined
  }

  listModelProfiles(workspaceId: string): ModelProfile[] {
    return this.database
      .prepare(
        `SELECT * FROM model_profiles WHERE workspace_id = ?
         ORDER BY is_default DESC, display_name, id`,
      )
      .all(workspaceId)
      .map(mapModelProfile)
  }

  deleteModelProfile(workspaceId: string, profileId: string, actorId = 'owner'): boolean {
    this.#assertWritable()
    this.#requireWorkspace(workspaceId)
    return this.#transaction(() => {
      const profile = this.getModelProfile(profileId)
      if (profile === undefined || profile.workspaceId !== workspaceId) return false
      const now = this.#clock()
      const removed = this.database
        .prepare('DELETE FROM model_profiles WHERE id = ? AND workspace_id = ?')
        .run(profileId, workspaceId).changes > 0
      if (!removed) return false

      let fallbackProfileId: string | undefined
      if (profile.isDefault) {
        const fallback = this.database
          .prepare('SELECT id FROM model_profiles WHERE workspace_id = ? ORDER BY display_name, id LIMIT 1')
          .get(workspaceId) as { id?: unknown } | undefined
        if (typeof fallback?.id === 'string') {
          fallbackProfileId = fallback.id
          this.database
            .prepare('UPDATE model_profiles SET is_default = 1, updated_at = ? WHERE id = ? AND workspace_id = ?')
            .run(now, fallbackProfileId, workspaceId)
        }
      }
      this.#appendEvent({
        workspaceId,
        type: 'model.profile.updated',
        actorId,
        actorKind: 'owner',
        payload: {
          modelProfileId: profileId,
          deleted: true,
          ...(fallbackProfileId ? { fallbackProfileId } : {}),
        },
      })
      return true
    })
  }

  saveModelAssignment(input: SaveModelAssignmentInput): ModelAssignment {
    this.#assertWritable()
    this.#requireWorkspace(input.workspaceId)
    const profile = this.getModelProfile(input.modelProfileId)
    if (profile === undefined || profile.workspaceId !== input.workspaceId) {
      throw new PersistenceError('Model profile must belong to the assignment workspace')
    }
    let worldId: string | undefined
    if (input.scope === 'workspace') {
      if (input.scopeId !== input.workspaceId) throw new PersistenceError('Workspace assignment scope id must match workspace id')
    } else if (input.scope === 'world') {
      const world = this.getWorld(input.scopeId)
      if (world === undefined || world.workspaceId !== input.workspaceId) throw new PersistenceError('World assignment target is invalid')
      worldId = world.id
    } else {
      const employee = this.getEmployee(input.scopeId)
      if (employee === undefined || employee.workspaceId !== input.workspaceId) throw new PersistenceError('Employee assignment target is invalid')
      worldId = employee.worldId
    }
    const assignment: ModelAssignment = {
      workspaceId: input.workspaceId,
      scope: input.scope,
      scopeId: input.scopeId,
      modelProfileId: input.modelProfileId,
      updatedAt: this.#clock(),
    }
    return this.#transaction(() => {
      this.database
        .prepare(
          `INSERT INTO model_assignments
           (workspace_id, scope, scope_id, model_profile_id, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (workspace_id, scope, scope_id) DO UPDATE SET
             model_profile_id = excluded.model_profile_id,
             updated_at = excluded.updated_at`,
        )
        .run(assignment.workspaceId, assignment.scope, assignment.scopeId, assignment.modelProfileId, assignment.updatedAt)
      this.#appendEvent({
        workspaceId: assignment.workspaceId,
        ...(worldId === undefined ? {} : { worldId }),
        type: 'model.assignment.updated',
        actorId: input.actorId ?? 'owner',
        actorKind: 'owner',
        payload: {
          scope: assignment.scope,
          scopeId: assignment.scopeId,
          modelProfileId: assignment.modelProfileId,
        },
      })
      return assignment
    })
  }

  getModelAssignment(workspaceId: string, scope: ModelAssignmentScope, scopeId: string): ModelAssignment | undefined {
    const row = this.database
      .prepare('SELECT * FROM model_assignments WHERE workspace_id = ? AND scope = ? AND scope_id = ?')
      .get(workspaceId, scope, scopeId)
    return row ? mapModelAssignment(row) : undefined
  }

  listModelAssignments(workspaceId: string): ModelAssignment[] {
    return this.database
      .prepare(
        `SELECT * FROM model_assignments WHERE workspace_id = ?
         ORDER BY CASE scope WHEN 'workspace' THEN 0 WHEN 'world' THEN 1 ELSE 2 END, scope_id`,
      )
      .all(workspaceId)
      .map(mapModelAssignment)
  }

  clearModelAssignment(workspaceId: string, scope: ModelAssignmentScope, scopeId: string, actorId = 'owner'): boolean {
    this.#assertWritable()
    this.#requireWorkspace(workspaceId)
    return this.#transaction(() => {
      const removed = this.database
        .prepare('DELETE FROM model_assignments WHERE workspace_id = ? AND scope = ? AND scope_id = ?')
        .run(workspaceId, scope, scopeId).changes > 0
      if (removed) {
        this.#appendEvent({
          workspaceId,
          type: 'model.assignment.updated',
          actorId,
          actorKind: 'owner',
          payload: { scope, scopeId, cleared: true },
        })
      }
      return removed
    })
  }

  resolveModelProfile(workspaceId: string, worldId: string, employeeId: string): ModelProfile | undefined {
    const employee = this.getModelAssignment(workspaceId, 'employee', employeeId)
    const world = this.getModelAssignment(workspaceId, 'world', worldId)
    const workspace = this.getModelAssignment(workspaceId, 'workspace', workspaceId)
    const profileId = employee?.modelProfileId ?? world?.modelProfileId ?? workspace?.modelProfileId
    // Assignments are normally removed by the model-profile foreign-key
    // cascade. Keep resolution defensive for legacy databases or an offline
    // repair that left a stale assignment behind: a missing higher-scope
    // profile must not disable all lower-scope/default routing.
    if (profileId !== undefined) {
      const assigned = this.getModelProfile(profileId)
      if (assigned !== undefined && assigned.workspaceId === workspaceId) return assigned
    }
    const profiles = this.listModelProfiles(workspaceId)
    return profiles.find((profile) => profile.isDefault) ?? profiles[0]
  }

  recordModelInteraction(input: RecordModelInteractionInput): ModelInteractionLog {
    this.#assertWritable()
    const workspace = this.#requireWorkspace(input.workspaceId)
    if (input.worldId !== undefined) {
      const world = this.#requireWorld(input.worldId)
      if (world.workspaceId !== workspace.id) {
        throw new PersistenceError('Model interaction world does not belong to workspace')
      }
    }
    if (input.sessionId !== undefined) {
      const session = this.#requireSession(input.sessionId)
      if (session.workspaceId !== workspace.id) {
        throw new PersistenceError('Model interaction session does not belong to workspace')
      }
    }
    if (input.employeeId !== undefined) {
      const employee = this.#requireEmployee(input.employeeId)
      if (employee.workspaceId !== workspace.id) {
        throw new PersistenceError('Model interaction employee does not belong to workspace')
      }
    }
    if (input.workTurnId !== undefined) {
      const turn = this.getWorkTurn(input.workTurnId)
      if (turn === undefined || turn.workspaceId !== workspace.id ||
        (input.worldId !== undefined && turn.worldId !== input.worldId) ||
        (input.sessionId !== undefined && turn.sessionId !== input.sessionId)) {
        throw new PersistenceError('Model interaction turn scope does not match workspace, world or session')
      }
    }
    if (input.agentRunId !== undefined) {
      const run = this.getAgentRun(input.agentRunId)
      if (run === undefined || run.workspaceId !== workspace.id ||
        (input.worldId !== undefined && run.worldId !== input.worldId) ||
        (input.sessionId !== undefined && run.sessionId !== input.sessionId) ||
        (input.employeeId !== undefined && run.employeeId !== input.employeeId) ||
        (input.workTurnId !== undefined && run.turnId !== input.workTurnId)) {
        throw new PersistenceError('Model interaction agent run scope does not match its trace context')
      }
    }
    if (input.source !== 'turn' && input.source !== 'discovery' && input.source !== 'knowledge') {
      throw new PersistenceError('Model interaction source is invalid')
    }
    if (input.status !== 'success' && input.status !== 'failed') {
      throw new PersistenceError('Model interaction status is invalid')
    }
    if (!input.modelId.trim()) throw new PersistenceError('Model interaction model id cannot be empty')
    if (!input.provider.trim()) throw new PersistenceError('Model interaction provider cannot be empty')
    if (!Number.isInteger(input.promptMessageCount) || input.promptMessageCount < 0) {
      throw new PersistenceError('Model interaction prompt message count must be a non-negative integer')
    }
    if (!Number.isInteger(input.promptCharCount) || input.promptCharCount < 0) {
      throw new PersistenceError('Model interaction prompt char count must be a non-negative integer')
    }
    if (!Number.isInteger(input.durationMs) || input.durationMs < 0) {
      throw new PersistenceError('Model interaction duration must be a non-negative integer')
    }
    assertOptionalCount('response char count', input.responseCharCount)
    assertOptionalCount('tool call count', input.toolCallCount)
    assertOptionalCount('tokens prompt', input.tokensPrompt)
    assertOptionalCount('tokens completion', input.tokensCompletion)
    assertOptionalCount('tokens total', input.tokensTotal)

    const log: ModelInteractionLog = {
      id: this.#idFactory(),
      workspaceId: workspace.id,
      source: input.source,
      modelId: input.modelId.trim().slice(0, 200),
      provider: input.provider.trim().slice(0, 120),
      status: input.status,
      promptMessageCount: input.promptMessageCount,
      promptCharCount: input.promptCharCount,
      durationMs: input.durationMs,
      createdAt: this.#clock(),
    }
    if (input.worldId !== undefined) log.worldId = input.worldId
    if (input.sessionId !== undefined) log.sessionId = input.sessionId
    if (input.employeeId !== undefined) log.employeeId = input.employeeId
    if (input.workTurnId !== undefined) log.workTurnId = input.workTurnId
    if (input.agentRunId !== undefined) log.agentRunId = input.agentRunId
    if (input.errorCode?.trim()) log.errorCode = input.errorCode.trim().slice(0, 120)
    if (input.errorMessage?.trim()) log.errorMessage = input.errorMessage.trim().slice(0, 1_000)
    if (input.httpStatus !== undefined) {
      if (!Number.isInteger(input.httpStatus) || input.httpStatus < 100 || input.httpStatus > 599) {
        throw new PersistenceError('Model interaction HTTP status must be between 100 and 599')
      }
      log.httpStatus = input.httpStatus
    }
    if (input.responseCharCount !== undefined) log.responseCharCount = input.responseCharCount
    if (input.toolCallCount !== undefined) log.toolCallCount = input.toolCallCount
    if (input.tokensPrompt !== undefined) log.tokensPrompt = input.tokensPrompt
    if (input.tokensCompletion !== undefined) log.tokensCompletion = input.tokensCompletion
    if (input.tokensTotal !== undefined) log.tokensTotal = input.tokensTotal

    this.database
      .prepare(
        `INSERT INTO model_interaction_logs (
           id, workspace_id, world_id, session_id, employee_id, work_turn_id, agent_run_id,
           source, model_id, provider,
           status, error_code, error_message, http_status, prompt_message_count, prompt_char_count,
           response_char_count, tool_call_count, duration_ms, tokens_prompt,
           tokens_completion, tokens_total, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        log.id,
        log.workspaceId,
        log.worldId ?? null,
        log.sessionId ?? null,
        log.employeeId ?? null,
        log.workTurnId ?? null,
        log.agentRunId ?? null,
        log.source,
        log.modelId,
        log.provider,
        log.status,
        log.errorCode ?? null,
        log.errorMessage ?? null,
        log.httpStatus ?? null,
        log.promptMessageCount,
        log.promptCharCount,
        log.responseCharCount ?? null,
        log.toolCallCount ?? null,
        log.durationMs,
        log.tokensPrompt ?? null,
        log.tokensCompletion ?? null,
        log.tokensTotal ?? null,
        log.createdAt,
      )
    return log
  }

  listModelInteractions(workspaceId: string, filter: ModelInteractionLogFilter): ModelInteractionLogPage {
    this.#requireWorkspace(workspaceId)
    const page = Math.max(1, Math.trunc(filter.page))
    const pageSize = Math.min(100, Math.max(1, Math.trunc(filter.pageSize)))
    const conditions = ['workspace_id = ?']
    const parameters: Array<string | number> = [workspaceId]
    if (filter.status !== undefined) {
      if (filter.status !== 'success' && filter.status !== 'failed') {
        throw new PersistenceError('Model interaction status filter is invalid')
      }
      conditions.push('status = ?')
      parameters.push(filter.status)
    }
    if (filter.modelId !== undefined && filter.modelId.trim()) {
      conditions.push('model_id = ?')
      parameters.push(filter.modelId.trim().slice(0, 200))
    }
    const where = conditions.join(' AND ')
    const totalRow = this.database
      .prepare(`SELECT COUNT(*) AS count FROM model_interaction_logs WHERE ${where}`)
      .get(...parameters) as { count?: number } | undefined
    const total = Number(totalRow?.count ?? 0)
    const rows = this.database
      .prepare(
        `SELECT * FROM model_interaction_logs WHERE ${where}
         ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      )
      .all(...parameters, pageSize, (page - 1) * pageSize)
    const modelRows = this.database
      .prepare(
        `SELECT DISTINCT model_id FROM model_interaction_logs
         WHERE workspace_id = ? ORDER BY model_id`,
      )
      .all(workspaceId) as Array<{ model_id?: unknown }>
    return {
      items: rows.map(mapModelInteractionLog),
      total,
      page,
      pageSize,
      modelIds: modelRows.map((row) => String(row.model_id)),
    }
  }

  getModelInteraction(interactionId: string): ModelInteractionLog | undefined {
    const row = this.database
      .prepare('SELECT * FROM model_interaction_logs WHERE id = ?')
      .get(interactionId)
    return row ? mapModelInteractionLog(row) : undefined
  }

  getAgentRunModelInteraction(agentRunId: string): ModelInteractionLog | undefined {
    const row = this.database
      .prepare(`SELECT * FROM model_interaction_logs
                WHERE agent_run_id = ? AND source = 'turn'
                ORDER BY created_at DESC, id DESC LIMIT 1`)
      .get(agentRunId)
    return row ? mapModelInteractionLog(row) : undefined
  }

  listWorldModelInteractions(worldId: string): ModelInteractionLog[] {
    this.#requireWorld(worldId)
    return this.database
      .prepare(`SELECT * FROM model_interaction_logs
                WHERE world_id = ? AND source = 'turn'
                ORDER BY created_at DESC, id DESC`)
      .all(worldId)
      .map(mapModelInteractionLog)
  }

  /**
   * Deletes telemetry older than `before`, bounding the tables the world trace
   * reads. Nothing here is user content.
   *
   * Conversations, Skill actions and approval history are deliberately kept:
   * they are the audit trail for real-world effects, and a retention sweep is
   * not the place to lose them. Pruning a work turn cascades to its agent runs
   * and leaves the ledger rows intact with their links set to null.
   *
   * Only settled rows are eligible — a queued or running turn is live state.
   */
  pruneHistory(input: PruneHistoryInput): PruneHistoryResult {
    this.#assertWritable()
    if (!Number.isFinite(Date.parse(input.before))) {
      throw new PersistenceError(`Invalid prune cutoff: ${input.before}`)
    }
    if (input.workspaceId !== undefined) this.#requireWorkspace(input.workspaceId)
    const before = input.before
    const scope = input.workspaceId
    const settled = "('completed', 'failed', 'interrupted')"

    return this.#transaction(() => {
      const workTurns = Number(this.database
        .prepare(`DELETE FROM work_turns WHERE status IN ${settled} AND created_at < ?${scope === undefined ? '' : ' AND workspace_id = ?'}`)
        .run(...(scope === undefined ? [before] : [before, scope])).changes)
      // Runs whose turn is still live but which settled long ago.
      const agentRuns = Number(this.database
        .prepare(`DELETE FROM agent_runs WHERE status IN ${settled} AND created_at < ?${scope === undefined ? '' : ' AND workspace_id = ?'}`)
        .run(...(scope === undefined ? [before] : [before, scope])).changes)
      const domainEvents = Number(this.database
        .prepare(`DELETE FROM domain_events WHERE created_at < ?${scope === undefined ? '' : ' AND workspace_id = ?'}`)
        .run(...(scope === undefined ? [before] : [before, scope])).changes)
      const modelInteractions = Number(this.database
        .prepare(`DELETE FROM model_interaction_logs WHERE created_at < ?${scope === undefined ? '' : ' AND workspace_id = ?'}`)
        .run(...(scope === undefined ? [before] : [before, scope])).changes)
      return { before, workTurns, agentRuns, domainEvents, modelInteractions }
    })
  }

  clearModelInteractions(workspaceId: string): number {
    this.#assertWritable()
    this.#requireWorkspace(workspaceId)
    return Number(this.database
      .prepare('DELETE FROM model_interaction_logs WHERE workspace_id = ?')
      .run(workspaceId).changes)
  }

  saveLocalAsset(input: SaveLocalAssetInput): LocalAsset {
    this.#assertWritable()
    this.#requireWorkspace(input.workspaceId)
    assertLocalAssetRef(input.relativePath)
    if (!/^[a-f0-9]{64}$/.test(input.sha256)) {
      throw new PersistenceError('Local asset SHA-256 is invalid')
    }
    if (!Number.isInteger(input.byteLength) || input.byteLength < 1) {
      throw new PersistenceError('Local asset byte length must be positive')
    }
    const asset: LocalAsset = {
      id: input.id?.trim() || this.#idFactory(),
      workspaceId: input.workspaceId,
      kind: input.kind,
      mimeType: input.mimeType,
      sha256: input.sha256,
      relativePath: input.relativePath,
      byteLength: input.byteLength,
      createdAt: this.#clock(),
    }
    return this.#transaction(() => {
      this.database
        .prepare(
          `INSERT INTO local_assets
           (id, workspace_id, kind, mime_type, sha256, relative_path, byte_length, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          asset.id,
          asset.workspaceId,
          asset.kind,
          asset.mimeType,
          asset.sha256,
          asset.relativePath,
          asset.byteLength,
          asset.createdAt,
        )
      this.#appendEvent({
        workspaceId: asset.workspaceId,
        type: 'local.asset.saved',
        actorId: input.actorId ?? 'owner',
        actorKind: 'owner',
        payload: {
          assetId: asset.id,
          kind: asset.kind,
          mimeType: asset.mimeType,
          byteLength: asset.byteLength,
          sha256: asset.sha256,
        },
      })
      return asset
    })
  }

  getLocalAsset(assetId: string): LocalAsset | undefined {
    const row = this.database.prepare('SELECT * FROM local_assets WHERE id = ?').get(assetId)
    return row ? mapLocalAsset(row) : undefined
  }

  listLocalAssets(workspaceId: string, kind?: LocalAssetKind): LocalAsset[] {
    const rows = kind === undefined
      ? this.database
          .prepare('SELECT * FROM local_assets WHERE workspace_id = ? ORDER BY created_at DESC, id')
          .all(workspaceId)
      : this.database
          .prepare(
            `SELECT * FROM local_assets
             WHERE workspace_id = ? AND kind = ? ORDER BY created_at DESC, id`,
          )
          .all(workspaceId, kind)
    return rows.map(mapLocalAsset)
  }

  deleteLocalAsset(assetId: string): boolean {
    this.#assertWritable()
    return Number(this.database.prepare('DELETE FROM local_assets WHERE id = ?').run(assetId).changes) === 1
  }

  saveCharacterAvatarAsset(input: SaveCharacterAvatarAssetInput): CharacterAvatarAsset {
    this.#assertWritable()
    const employee = this.#requireEmployee(input.employeeId)
    const world = this.#requireWorld(input.worldId)
    const asset = this.getLocalAsset(input.assetId)
    if (asset === undefined || asset.kind !== 'avatar') throw new PersistenceError('Character avatar asset is missing')
    if (employee.workspaceId !== input.workspaceId || employee.worldId !== world.id || world.workspaceId !== input.workspaceId || asset.workspaceId !== input.workspaceId) {
      throw new PersistenceError('Character avatar asset scope does not match its character')
    }
    if ((input.rendererKind === 'image-2d') === (asset.mimeType === 'model/gltf-binary')) {
      throw new PersistenceError('Character avatar renderer does not match its asset MIME type')
    }
    const originalName = normalizeRequiredToken(input.originalName, 'Character avatar source name', 180)
    assertSecretFree(input.validation)
    const record: CharacterAvatarAsset = {
      assetId: asset.id,
      workspaceId: input.workspaceId,
      worldId: world.id,
      employeeId: employee.id,
      rendererKind: input.rendererKind,
      originalName,
      validation: structuredClone(input.validation),
      createdAt: asset.createdAt,
    }
    this.database.prepare(
      `INSERT INTO character_avatar_assets
       (asset_id, workspace_id, world_id, employee_id, renderer_kind, original_name, validation_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(record.assetId, record.workspaceId, record.worldId, record.employeeId, record.rendererKind, record.originalName, stringifyJson(record.validation), record.createdAt)
    return record
  }

  getCharacterAvatarAsset(assetId: string): CharacterAvatarAsset | undefined {
    const row = this.database.prepare('SELECT * FROM character_avatar_assets WHERE asset_id = ?').get(assetId)
    return row === undefined ? undefined : mapCharacterAvatarAsset(row)
  }

  listCharacterAvatarAssets(employeeId: string): CharacterAvatarAsset[] {
    this.#requireEmployee(employeeId)
    return this.database.prepare(
      `SELECT * FROM character_avatar_assets
       WHERE employee_id = ? ORDER BY created_at DESC, asset_id DESC`,
    ).all(employeeId).map(mapCharacterAvatarAsset)
  }

  /**
   * Renames a world as an audited domain fact.
   *
   * World management actions reach this through the host seam; skill adapters
   * never write SQL, so the rename keeps the same validation, transaction and
   * event trail as creation.
   */
  renameWorld(input: RenameWorldInput): World {
    this.#assertWritable()
    const world = this.#requireWorld(input.worldId)
    const name = input.name.trim()
    if (!name) throw new PersistenceError('World name cannot be empty')
    if (name.length > 120) throw new PersistenceError('World name is too long')
    const now = this.#clock()
    return this.#transaction(() => {
      this.database
        .prepare('UPDATE worlds SET name = ?, updated_at = ? WHERE id = ?')
        .run(name, now, world.id)
      this.#appendEvent({
        workspaceId: world.workspaceId,
        worldId: world.id,
        type: 'world.renamed',
        actorId: input.actorId ?? 'owner',
        actorKind: input.actorKind ?? 'owner',
        payload: { worldId: world.id, previousName: world.name, name },
      })
      return { ...world, name, updatedAt: now }
    })
  }

  createWorld(input: CreateWorldInput): World {
    this.#assertWritable()
    const workspace = this.#requireWorkspace(input.workspaceId)
    const now = this.#clock()
    const world: World = {
      id: this.#idFactory(),
      workspaceId: workspace.id,
      name: input.name.trim(),
      templateId: input.templateId.trim(),
      status: 'active',
      createdAt: now,
      updatedAt: now,
    }
    if (!world.name) throw new PersistenceError('World name cannot be empty')
    if (!world.templateId) throw new PersistenceError('World template cannot be empty')

    return this.#transaction(() => {
      this.database
        .prepare(
          `INSERT INTO worlds (id, workspace_id, name, template_id, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          world.id,
          world.workspaceId,
          world.name,
          world.templateId,
          world.status,
          world.createdAt,
          world.updatedAt,
        )
      this.#appendEvent({
        workspaceId: workspace.id,
        worldId: world.id,
        type: 'world.created',
        actorId: input.actorId ?? 'owner',
        actorKind: 'owner',
        payload: { worldId: world.id, name: world.name, templateId: world.templateId },
      })
      return world
    })
  }

  getWorld(worldId: string): World | undefined {
    const row = this.database.prepare('SELECT * FROM worlds WHERE id = ?').get(worldId)
    return row ? mapWorld(row) : undefined
  }

  getWorldCharacterAuthority(worldId: string, employeeId: string) {
    return this.#worldAuthorities.get(worldId, employeeId)
  }

  listWorldCharacterAuthorities(worldId: string) {
    return this.#worldAuthorities.list(worldId)
  }

  listActiveWorldCharacterAuthorities(worldId: string) {
    return this.#worldAuthorities.listActive(worldId)
  }

  saveWorldCharacterAuthority(input: SaveWorldCharacterAuthorityInput) {
    this.#assertWritable()
    return this.#worldAuthorities.save(input)
  }

  appendWorldAuthorityChange(input: AppendWorldAuthorityChangeInput) {
    this.#assertWritable()
    return this.#worldAuthorities.appendChange(input)
  }

  /**
   * Commit one authority transition, its immutable ledger row, the real-time
   * DomainEvent and compatibility primary pointer under one write lock.
   * `expectedAuthority` is re-read inside BEGIN IMMEDIATE so concurrent
   * demotions cannot both pass a last-admin preflight.
   */
  commitWorldAuthorityChange(input: CommitWorldAuthorityChangeInput) {
    this.#assertWritable()
    return this.#transaction(() => {
      const current = this.#worldAuthorities.get(input.authority.worldId, input.authority.employeeId)
      if (!sameAuthority(current, input.expectedAuthority)) {
        throw new PersistenceError('World authority changed concurrently; reload before retrying')
      }
      const adminsBefore = this.#worldAuthorities.listActive(input.authority.worldId)
        .filter((authority) => authority.role === 'administrator').length
      const updated = this.#worldAuthorities.save(input.authority)
      const activeEmployees = this.listEmployees(input.authority.worldId)
        .filter((employee) => employee.status !== 'archived')
      const activeAdmins = this.#worldAuthorities.listActive(input.authority.worldId)
        .filter((authority) => authority.role === 'administrator')
      // Only a write that *removes* the last administrator breaks the
      // invariant. Refusing every edit in a world that already had none
      // punished the wrong write: a world with no administrator could not have
      // a single permission changed, and the refusal surfaced as a generic
      // server error rather than something the owner could act on.
      if (adminsBefore > 0 && activeEmployees.length > 0 && activeAdmins.length === 0) {
        throw new PersistenceError('last_world_administrator')
      }
      this.#worldAuthorities.appendChange(input.audit)
      this.#appendEvent({
        workspaceId: input.event.workspaceId,
        worldId: input.event.worldId,
        type: 'world.character.authority.changed',
        actorId: input.event.actorId,
        actorKind: input.event.actorKind,
        payload: input.event.payload,
      })
      this.#syncCompatibilityPrimaryAdministrator(input.authority.worldId, this.#clock())
      return updated
    })
  }

  syncWorldCompatibilityPrimaryAdministrator(worldId: string, updatedAt = this.#clock()): void {
    this.#assertWritable()
    this.#syncCompatibilityPrimaryAdministrator(worldId, updatedAt)
  }

  getWorldAuthorityChange(id: string) {
    return this.#worldAuthorities.getChange(id)
  }

  listWorldAuthorityChanges(worldId: string, employeeId?: string) {
    return this.#worldAuthorities.listChanges(worldId, employeeId)
  }

  hasWorldCharacterPermission(
    worldId: string,
    employeeId: string,
    permission: import('@dsh-cyber/contracts').WorldCharacterPermission,
  ): boolean {
    return this.#worldAuthorities.hasPermission(worldId, employeeId, permission)
  }

  /** Whether the owner ever revoked this permission from this character. */
  wasWorldCharacterPermissionRevoked(
    worldId: string,
    employeeId: string,
    permission: import('@dsh-cyber/contracts').WorldCharacterPermission,
  ): boolean {
    return this.#worldAuthorities.wasPermissionRevoked(worldId, employeeId, permission)
  }

  createWorldPermissionRequest(
    input: import('@dsh-cyber/contracts').CreateWorldPermissionRequestInput,
  ) {
    this.#assertWritable()
    return this.#worldAuthorities.createPermissionRequest(input)
  }

  getWorldPermissionRequest(id: string) {
    return this.#worldAuthorities.getPermissionRequest(id)
  }

  getWorldPermissionRequestBySkillActionId(worldId: string, skillActionId: string) {
    return this.#worldAuthorities.getPermissionRequestBySkillActionId(worldId, skillActionId)
  }

  getWorldPermissionRequestForAction(skillActionId: string, permission?: import('@dsh-cyber/contracts').WorldCharacterPermission) {
    return this.#worldAuthorities.getPermissionRequestForAction(skillActionId, permission)
  }

  listWorldPermissionRequestsBySkillActionId(worldId: string, skillActionId: string) {
    return this.#worldAuthorities.listPermissionRequestsBySkillActionId(worldId, skillActionId)
  }

  listWorldPermissionRequestsByWorkTurnId(worldId: string, workTurnId: string) {
    return this.#worldAuthorities.listPermissionRequestsByWorkTurnId(worldId, workTurnId)
  }

  listWorldPermissionRequestsForTurn(workTurnId: string) {
    return this.#worldAuthorities.listPermissionRequestsForTurn(workTurnId)
  }

  listWorldPermissionRequests(
    worldId: string,
    status?: import('@dsh-cyber/contracts').WorldPermissionRequestStatus,
  ) {
    return this.#worldAuthorities.listPermissionRequests(worldId, status)
  }

  listPendingWorldPermissionRequests(worldId: string) {
    return this.#worldAuthorities.listPendingPermissionRequests(worldId)
  }

  decideWorldPermissionRequest(
    id: string,
    input: import('@dsh-cyber/contracts').DecideWorldPermissionRequestInput,
    now?: string,
  ) {
    this.#assertWritable()
    return this.#worldAuthorities.decidePermissionRequest(id, input, now)
  }

  consumeWorldPermissionRequest(id: string, consumedAt?: string) {
    this.#assertWritable()
    return this.#worldAuthorities.consumePermissionRequest(id, consumedAt)
  }

  expireWorldPermissionRequest(id: string, now?: string) {
    this.#assertWritable()
    return this.#worldAuthorities.expirePermissionRequestResult(id, now)
  }

  expireWorldPermissionRequests(now?: string): number {
    this.#assertWritable()
    return this.#worldAuthorities.expireAllPermissionRequests(now)
  }

  setWorldAdministrator(worldId: string, employeeId: string, actorId = 'owner'): World {
    this.#assertWritable()
    const world = this.#requireWorld(worldId)
    const employee = this.#requireEmployee(employeeId)
    if (employee.worldId !== world.id || employee.workspaceId !== world.workspaceId || employee.status === 'archived') {
      throw new PersistenceError('World administrator must be an active character in the same world')
    }
    const now = this.#clock()
    return this.#transaction(() => {
      const previousAdministratorId = world.administratorEmployeeId
      const targetAuthority = this.#worldAuthorities.get(world.id, employee.id)
      if (previousAdministratorId !== employee.id) {
        this.#worldAuthorities.save({
          worldId: world.id,
          employeeId: employee.id,
          role: 'administrator',
          permissionGrants: targetAuthority?.role === 'administrator'
            ? targetAuthority.permissionGrants
            : recommendedAdminPermissions(),
          createdAt: targetAuthority?.createdAt ?? now,
          updatedAt: now,
        })
      }
      this.database.prepare(
        'UPDATE worlds SET administrator_employee_id = ?, updated_at = ? WHERE id = ?',
      ).run(employee.id, now, world.id)
      this.#appendEvent({
        workspaceId: world.workspaceId,
        worldId: world.id,
        type: 'world.administrator.changed',
        actorId,
        actorKind: actorId === 'owner' ? 'owner' : 'employee',
        payload: { worldId: world.id, administratorEmployeeId: employee.id },
      })
      return this.#requireWorld(world.id)
    })
  }

  isWorldAdministrator(worldId: string, employeeId: string): boolean {
    return this.getWorld(worldId)?.administratorEmployeeId === employeeId
  }

  canManageEmployee(actorEmployeeId: string, targetEmployeeId: string): boolean {
    const actor = this.getEmployee(actorEmployeeId)
    const target = this.getEmployee(targetEmployeeId)
    if (actor === undefined || target === undefined || actor.status === 'archived' || target.status === 'archived') return false
    return actor.worldId === target.worldId
      && actor.workspaceId === target.workspaceId
      && this.isWorldAdministrator(actor.worldId, actor.id)
  }

  listWorlds(workspaceId: string, includeArchived = false): World[] {
    const sql = includeArchived
      ? 'SELECT * FROM worlds WHERE workspace_id = ? ORDER BY created_at, id'
      : `SELECT * FROM worlds
         WHERE workspace_id = ? AND status <> 'archived' ORDER BY created_at, id`
    return this.database.prepare(sql).all(workspaceId).map(mapWorld)
  }

  rollbackWorldCreation(worldId: string, reason: string, actorId = 'system'): void {
    this.#assertWritable()
    const world = this.#requireWorld(worldId)
    const workspaceId = world.workspaceId
    const normalizedReason = reason.trim() || 'construction-failed'
    this.#transaction(() => {
      this.database.prepare('DELETE FROM worlds WHERE id = ?').run(world.id)
      this.#appendEvent({
        workspaceId,
        type: 'world.creation.rolled-back',
        actorId,
        actorKind: actorId === 'system' ? 'system' : 'owner',
        payload: { discardedWorldId: world.id, name: world.name, reason: normalizedReason },
      })
    })
  }

  saveBlueprint(blueprint: EmployeeBlueprint): EmployeeBlueprint {
    this.#assertWritable()
    if (blueprint.schemaVersion !== 1) throw new PersistenceError('Unsupported employee blueprint schema')
    if (blueprint.version < 1) throw new PersistenceError('Blueprint version must be positive')
    if (new Set(blueprint.requestedSkills).size !== blueprint.requestedSkills.length) {
      throw new PersistenceError('Employee blueprint requested skills must be unique')
    }
    if (new Set(blueprint.requestedCapabilities).size !== blueprint.requestedCapabilities.length) {
      throw new PersistenceError('Employee blueprint requested capabilities must be unique')
    }
    const existing = this.getBlueprint(blueprint.id, blueprint.version)
    if (existing !== undefined) {
      if (!employeeBlueprintEquals(existing, blueprint)) {
        throw new PersistenceError(`Employee blueprint identity is immutable: ${blueprint.id}@${blueprint.version}`)
      }
      return existing
    }
    this.database
      .prepare(
        `INSERT INTO employee_blueprints (
           id, version, world_template_id, display_name, role, summary, persona,
           requested_skills_json, requested_capabilities_json, embodiment_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        blueprint.id,
        blueprint.version,
        blueprint.worldTemplateId,
        blueprint.displayName,
        blueprint.role,
        blueprint.summary,
        blueprint.persona,
        stringifyJson(blueprint.requestedSkills),
        stringifyJson(blueprint.requestedCapabilities),
        blueprint.embodiment === undefined ? null : stringifyJson(blueprint.embodiment as unknown as JsonValue),
        blueprint.createdAt,
      )
    return blueprint
  }

  getBlueprint(id: string, version: number): EmployeeBlueprint | undefined {
    const row = this.database
      .prepare('SELECT * FROM employee_blueprints WHERE id = ? AND version = ?')
      .get(id, version)
    return row ? mapBlueprint(row) : undefined
  }

  listBlueprints(): EmployeeBlueprint[] {
    return this.database
      .prepare('SELECT * FROM employee_blueprints ORDER BY display_name, version DESC')
      .all()
      .map(mapBlueprint)
  }

  discardBlueprintIfUnused(id: string, version: number): boolean {
    this.#assertWritable()
    const used = this.database
      .prepare('SELECT 1 AS used FROM employee_instances WHERE blueprint_id = ? AND blueprint_version = ? LIMIT 1')
      .get(id, version)
    if (used !== undefined) return false
    return this.database
      .prepare('DELETE FROM employee_blueprints WHERE id = ? AND version = ?')
      .run(id, version).changes > 0
  }

  recruitEmployee(input: RecruitEmployeeInput): EmployeeInstance {
    this.#assertWritable()
    const workspace = this.#requireWorkspace(input.workspaceId)
    const world = this.#requireWorld(input.worldId)
    if (world.workspaceId !== workspace.id || world.status === 'archived') {
      throw new PersistenceError('Employee cannot be recruited into this world')
    }
    const blueprint = this.getBlueprint(input.blueprintId, input.blueprintVersion)
    if (!blueprint) {
      throw new EntityNotFoundError(
        `Employee blueprint not found: ${input.blueprintId}@${input.blueprintVersion}`,
      )
    }
    // A Blueprint with explicit semantic Embodiment is portable. Legacy
    // Blueprints without Embodiment keep their original template restriction.
    if (
      blueprint.embodiment === undefined
      && blueprint.worldTemplateId !== world.templateId
      && world.templateId !== 'personal-world'
    ) {
      throw new PersistenceError(
        `Blueprint ${blueprint.id}@${blueprint.version} belongs to ${blueprint.worldTemplateId}, not ${world.templateId}`,
      )
    }
    const initialSkillGrants = input.skillGrants ?? []
    const initialCapabilityGrants = input.capabilityGrants ?? []
    // Blueprint.requestedSkills are initial recommendations, not a lifetime
    // allow-list.  World-aware availability is validated by the Server seam;
    // persistence only owns the durable shape and uniqueness boundary.
    assertUnique(initialSkillGrants, 'skill grant')
    assertSubset(initialCapabilityGrants, blueprint.requestedCapabilities, 'capability grant')
    const now = this.#clock()
    const employee: EmployeeInstance = {
      id: this.#idFactory(),
      workspaceId: workspace.id,
      worldId: world.id,
      blueprintId: blueprint.id,
      blueprintVersion: blueprint.version,
      displayName: input.displayName ?? blueprint.displayName,
      role: input.role ?? blueprint.role,
      presence: 'available',
      health: 'healthy',
      status: 'available',
      currentRevision: 1,
      createdAt: now,
      updatedAt: now,
    }
    const revision: EmployeeRevision = {
      employeeId: employee.id,
      revision: 1,
      persona: input.persona ?? blueprint.persona,
      skillGrants: initialSkillGrants,
      capabilityGrants: initialCapabilityGrants,
      modelPolicy: input.modelPolicy ?? {},
      runtimePermissionMode: input.runtimePermissionMode ?? 'read-only',
      reason: input.reason ?? 'recruited',
      createdAt: now,
    }

    return this.#transaction(() => {
      this.#insertEmployee(employee)
      this.#insertRevision(revision)
      this.#worldAuthorities.save({
        worldId: world.id,
        employeeId: employee.id,
        role: 'member',
        // Derived from the runtime mode the character was recruited with, the
        // same rule the legacy backfill uses. Recruiting used to leave the row
        // empty, which is what made these permissions unenforceable: turning
        // them into a real gate would have locked every new character out of
        // its own world's files on day one.
        permissionGrants: revision.runtimePermissionMode === 'read-only'
          ? ['world.files.read']
          : ['world.files.read', 'world.files.write'],
        createdAt: now,
        updatedAt: now,
      })
      this.database
        .prepare(
          `INSERT INTO employee_profile_revisions
           (employee_id, revision, gender, voice_profile_json, birthday, background, personality_traits_json,
            appearance_json, reason, created_at)
           VALUES (?, 1, ?, ?, NULL, ?, '[]', '{}', 'recruited', ?)`,
        )
        .run(employee.id, normalizeCharacterGender(input.gender), stringifyJson(defaultEmployeeVoiceProfile() as unknown as JsonObject), blueprint.summary, now)
      const recruitedEvent = this.#appendEvent({
        workspaceId: workspace.id,
        worldId: world.id,
        type: 'employee.recruited',
        actorId: input.actorId ?? 'owner',
        actorKind: 'owner',
        payload: {
          employeeId: employee.id,
          worldId: world.id,
          blueprintId: blueprint.id,
          blueprintVersion: blueprint.version,
          displayName: employee.displayName,
          role: employee.role,
        },
      })
      const joinedMilestoneId = this.#idFactory()
      this.database
        .prepare(
          `INSERT INTO employee_milestones
           (id, workspace_id, world_id, employee_id, category, title, summary,
            source_event_ids_json, source_message_ids_json, artifact_refs_json,
            occurred_at, created_at)
           VALUES (?, ?, ?, ?, 'joined', ?, ?, ?, '[]', '[]', ?, ?)`,
        )
        .run(
          joinedMilestoneId,
          employee.workspaceId,
          employee.worldId,
          employee.id,
          `加入${world.name}`,
          `${employee.displayName}以${employee.role}身份加入当前世界。`,
          stringifyJson([recruitedEvent.id]),
          now,
          now,
        )
      this.#appendEvent({
        workspaceId: workspace.id,
        worldId: world.id,
        type: 'employee.milestone.recorded',
        actorId: input.actorId ?? 'owner',
        actorKind: 'owner',
        payload: {
          employeeId: employee.id,
          milestoneId: joinedMilestoneId,
          category: 'joined',
        },
        causationId: recruitedEvent.id,
      })
      return employee
    })
  }

  reviseEmployee(input: ReviseEmployeeInput): EmployeeRevision {
    this.#assertWritable()
    const employee = this.#requireEmployee(input.employeeId)
    const previous = this.getEmployeeRevision(employee.id, employee.currentRevision)
    if (!previous) throw new EntityNotFoundError(`Current employee revision not found: ${employee.id}`)
    const blueprint = this.getBlueprint(employee.blueprintId, employee.blueprintVersion)
    if (blueprint === undefined) throw new EntityNotFoundError(`Employee blueprint not found: ${employee.blueprintId}@${employee.blueprintVersion}`)
    if (input.skillGrants !== undefined) {
      // A revision can explicitly grant a skill discovered after recruitment;
      // World Skill Availability is a host/runtime concern, not a Blueprint
      // subset constraint.  Keep the persistence-level uniqueness check.
      assertUnique(input.skillGrants, 'skill grant')
    }
    if (input.capabilityGrants !== undefined) {
      assertSubset(input.capabilityGrants, blueprint.requestedCapabilities, 'capability grant')
    }
    const now = this.#clock()
    const revision: EmployeeRevision = {
      employeeId: employee.id,
      revision: employee.currentRevision + 1,
      persona: input.persona ?? previous.persona,
      skillGrants: input.skillGrants ?? previous.skillGrants,
      capabilityGrants: input.capabilityGrants ?? previous.capabilityGrants,
      modelPolicy: input.modelPolicy ?? previous.modelPolicy,
      runtimePermissionMode: input.runtimePermissionMode ?? previous.runtimePermissionMode ?? 'read-only',
      reason: input.reason,
      createdAt: now,
    }

    return this.#transaction(() => {
      this.#insertRevision(revision)
      this.database
        .prepare(
          'UPDATE employee_instances SET current_revision = ?, updated_at = ? WHERE id = ?',
        )
        .run(revision.revision, now, employee.id)
      this.#appendEvent({
        workspaceId: employee.workspaceId,
        worldId: employee.worldId,
        type: 'employee.revised',
        actorId: input.actorId ?? 'owner',
        actorKind: 'owner',
        payload: { employeeId: employee.id, revision: revision.revision, reason: revision.reason },
      })
      return revision
    })
  }

  archiveEmployee(employeeId: string, actorId = 'owner'): EmployeeInstance {
    this.#assertWritable()
    const employee = this.#requireEmployee(employeeId)
    const now = this.#clock()
    return this.#transaction(() => {
      this.database
        .prepare(
          `UPDATE employee_instances
           SET status = 'archived', archived_at = ?, updated_at = ? WHERE id = ?`,
        )
        .run(now, now, employee.id)
      const world = this.#requireWorld(employee.worldId)
      if (world.administratorEmployeeId === employee.id) {
        const successorRow = this.database
        .prepare(
            `SELECT id FROM employee_instances
             WHERE world_id = ? AND status <> 'archived' AND id <> ?
               AND id IN (
                 SELECT employee_id FROM world_character_authorities
                 WHERE world_id = ? AND role = 'administrator'
               )
             ORDER BY created_at, id
             LIMIT 1`,
          )
          .get(employee.worldId, employee.id, employee.worldId) as { id: string } | undefined
        const successorId = successorRow?.id ?? null
        this.database
          .prepare('UPDATE worlds SET administrator_employee_id = ?, updated_at = ? WHERE id = ?')
          .run(successorId, now, employee.worldId)
        this.#appendEvent({
          workspaceId: employee.workspaceId,
          worldId: employee.worldId,
          type: 'world.administrator.changed',
          actorId,
          actorKind: actorId === 'owner' ? 'owner' : 'employee',
          payload: { worldId: employee.worldId, administratorEmployeeId: successorId },
        })
      }
      this.#appendEvent({
        workspaceId: employee.workspaceId,
        worldId: employee.worldId,
        type: 'employee.archived',
        actorId,
        actorKind: 'owner',
        payload: { employeeId: employee.id },
      })
      return this.#requireEmployee(employee.id)
    })
  }

  setEmployeeStatus(employeeId: string, status: EmployeeStatus, actorId: string): EmployeeInstance {
    this.#assertWritable()
    if (status === 'archived') return this.archiveEmployee(employeeId, actorId)
    if (status === 'blocked') {
      return this.setEmployeeHealth(employeeId, 'blocked', {
        errorCode: 'legacy_employee_status_update',
        detail: '角色运行配置需要用户处理',
      })
    }
    throw new PersistenceError('Employee presence is derived from durable work and cannot be set directly')
  }

  setEmployeeHealth(
    employeeId: string,
    health: EmployeeHealth,
    issue?: { errorCode: string; detail: string },
  ): EmployeeInstance {
    this.#assertWritable()
    const employee = this.#requireEmployee(employeeId)
    if (employee.status === 'archived') throw new PersistenceError('Archived employee health cannot be changed')
    if (health === 'healthy' && issue !== undefined) throw new PersistenceError('Healthy employee cannot retain a health issue')
    if (health !== 'healthy' && (issue?.errorCode.trim() === '' || issue?.detail.trim() === '')) {
      throw new PersistenceError('Unhealthy employee requires an actionable error code and detail')
    }
    const now = this.#clock()
    this.database.prepare(
      `UPDATE employee_instances
       SET health = ?, health_error_code = ?, health_detail = ?, updated_at = ?
       WHERE id = ?`,
    ).run(health, issue?.errorCode.trim() ?? null, issue?.detail.trim() ?? null, now, employee.id)
    return this.#requireEmployee(employee.id)
  }

  bindEmployeeAgentSession(employeeId: string, agentSessionId: string): EmployeeInstance {
    this.#assertWritable()
    const employee = this.#requireEmployee(employeeId)
    this.database
      .prepare('UPDATE employee_instances SET agent_session_id = ?, updated_at = ? WHERE id = ?')
      .run(agentSessionId, this.#clock(), employee.id)
    return this.#requireEmployee(employee.id)
  }

  getEmployee(employeeId: string): EmployeeInstance | undefined {
    const row = this.database.prepare('SELECT * FROM employee_instances WHERE id = ?').get(employeeId)
    return row ? this.#mapEmployeeRuntimeState(row) : undefined
  }

  listEmployees(worldId: string, includeArchived = false): EmployeeInstance[] {
    const sql = includeArchived
      ? 'SELECT * FROM employee_instances WHERE world_id = ? ORDER BY created_at, id'
      : `SELECT * FROM employee_instances
         WHERE world_id = ? AND status <> 'archived' ORDER BY created_at, id`
    return this.database.prepare(sql).all(worldId).map((row) => this.#mapEmployeeRuntimeState(row))
  }

  getEmployeeRevision(employeeId: string, revision: number): EmployeeRevision | undefined {
    const row = this.database
      .prepare('SELECT * FROM employee_revisions WHERE employee_id = ? AND revision = ?')
      .get(employeeId, revision)
    return row ? mapRevision(row) : undefined
  }

  listEmployeeRevisions(employeeId: string): EmployeeRevision[] {
    return this.database
      .prepare('SELECT * FROM employee_revisions WHERE employee_id = ? ORDER BY revision')
      .all(employeeId)
      .map(mapRevision)
  }

  getEmployeeProfile(employeeId: string): EmployeeProfile | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM employee_profile_revisions
         WHERE employee_id = ? ORDER BY revision DESC LIMIT 1`,
      )
      .get(employeeId)
    return row ? mapEmployeeProfile(row) : undefined
  }

  listEmployeeProfiles(employeeId: string): EmployeeProfile[] {
    return this.database
      .prepare(
        `SELECT * FROM employee_profile_revisions
         WHERE employee_id = ? ORDER BY revision`,
      )
      .all(employeeId)
      .map(mapEmployeeProfile)
  }

  reviseEmployeeProfile(input: ReviseEmployeeProfileInput): EmployeeProfile {
    this.#assertWritable()
    const employee = this.#requireEmployee(input.employeeId)
    const previous = this.getEmployeeProfile(employee.id)
    const birthday = input.birthday === undefined ? previous?.birthday : input.birthday ?? undefined
    const displayName = (input.displayName ?? employee.displayName).trim()
    const role = (input.role ?? employee.role).trim()
    const gender = normalizeCharacterGender(input.gender ?? previous?.gender)
    const voiceProfile = normalizeEmployeeVoiceProfile(input.voiceProfile ?? previous?.voiceProfile)
    if (birthday !== undefined) assertBirthday(birthday)
    if (!displayName) throw new PersistenceError('Employee display name cannot be empty')
    if (displayName.length > 48) throw new PersistenceError('Employee display name is too long')
    if (!role) throw new PersistenceError('Character identity label cannot be empty')
    if (role.length > 100) throw new PersistenceError('Character identity label is too long')
    const profile: EmployeeProfile = {
      employeeId: employee.id,
      revision: (previous?.revision ?? 0) + 1,
      gender,
      voiceProfile,
      background: (input.background ?? previous?.background ?? '').trim(),
      personalityTraits: uniqueStrings(input.personalityTraits ?? previous?.personalityTraits ?? []),
      appearance: input.appearance ?? previous?.appearance ?? {},
      reason: input.reason.trim(),
      createdAt: this.#clock(),
    }
    if (birthday !== undefined) profile.birthday = birthday
    if (!profile.background) throw new PersistenceError('Employee background cannot be empty')
    if (!profile.reason) throw new PersistenceError('Profile revision reason cannot be empty')
    assertSecretFree(profile.appearance)

    return this.#transaction(() => {
      if (displayName !== employee.displayName || role !== employee.role) {
        this.database
          .prepare('UPDATE employee_instances SET display_name = ?, role = ?, updated_at = ? WHERE id = ?')
          .run(displayName, role, profile.createdAt, employee.id)
      }
      this.database
        .prepare(
          `INSERT INTO employee_profile_revisions
           (employee_id, revision, gender, voice_profile_json, birthday, background, personality_traits_json,
            appearance_json, reason, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          profile.employeeId,
          profile.revision,
          profile.gender,
          stringifyJson(profile.voiceProfile as unknown as JsonObject),
          profile.birthday ?? null,
          profile.background,
          stringifyJson(profile.personalityTraits),
          stringifyJson(profile.appearance),
          profile.reason,
          profile.createdAt,
        )
      this.#appendEvent({
        workspaceId: employee.workspaceId,
        worldId: employee.worldId,
        type: 'employee.profile.revised',
        actorId: input.actorId ?? 'owner',
        actorKind: 'owner',
        payload: {
          employeeId: employee.id,
          revision: profile.revision,
          reason: profile.reason,
          displayName,
          role,
          identityChanged: displayName !== employee.displayName || role !== employee.role,
        },
      })
      return profile
    })
  }

  recordSkillEvidence(input: RecordSkillEvidenceInput): SkillEvidence {
    this.#assertWritable()
    const employee = this.#requireEmployee(input.employeeId)
    const sourceEventIds = uniqueStrings(input.sourceEventIds ?? [])
    const sourceMessageIds = uniqueStrings(input.sourceMessageIds ?? [])
    this.#assertEvidenceSources(employee, sourceEventIds, sourceMessageIds)
    const evidence: SkillEvidence = {
      id: this.#idFactory(),
      workspaceId: employee.workspaceId,
      worldId: employee.worldId,
      employeeId: employee.id,
      skillId: input.skillId.trim(),
      kind: input.kind,
      outcome: input.outcome,
      summary: input.summary.trim(),
      sourceEventIds,
      sourceMessageIds,
      artifactRefs: uniqueStrings(input.artifactRefs ?? []),
      createdAt: this.#clock(),
    }
    if (!evidence.skillId) throw new PersistenceError('Skill id cannot be empty')
    if (!evidence.summary) throw new PersistenceError('Skill evidence summary cannot be empty')

    return this.#transaction(() => {
      this.database
        .prepare(
          `INSERT INTO skill_evidence
           (id, workspace_id, world_id, employee_id, skill_id, kind, outcome, summary,
            source_event_ids_json, source_message_ids_json, artifact_refs_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          evidence.id,
          evidence.workspaceId,
          evidence.worldId,
          evidence.employeeId,
          evidence.skillId,
          evidence.kind,
          evidence.outcome,
          evidence.summary,
          stringifyJson(evidence.sourceEventIds),
          stringifyJson(evidence.sourceMessageIds),
          stringifyJson(evidence.artifactRefs),
          evidence.createdAt,
        )
      this.#appendEvent({
        workspaceId: employee.workspaceId,
        worldId: employee.worldId,
        type: 'skill.evidence.recorded',
        actorId: input.actorId ?? employee.id,
        actorKind: input.actorId === undefined ? 'employee' : 'owner',
        payload: {
          employeeId: employee.id,
          evidenceId: evidence.id,
          skillId: evidence.skillId,
          kind: evidence.kind,
          outcome: evidence.outcome,
        },
      })
      return evidence
    })
  }

  getSkillEvidence(evidenceId: string): SkillEvidence | undefined {
    const row = this.database.prepare('SELECT * FROM skill_evidence WHERE id = ?').get(evidenceId)
    return row ? mapSkillEvidence(row) : undefined
  }

  listSkillEvidence(employeeId: string, skillId?: string): SkillEvidence[] {
    const rows = skillId === undefined
      ? this.database
          .prepare('SELECT * FROM skill_evidence WHERE employee_id = ? ORDER BY created_at DESC, id')
          .all(employeeId)
      : this.database
          .prepare(
            `SELECT * FROM skill_evidence
             WHERE employee_id = ? AND skill_id = ? ORDER BY created_at DESC, id`,
          )
          .all(employeeId, skillId)
    return rows.map(mapSkillEvidence)
  }

  reviseEmployeeSkill(input: ReviseEmployeeSkillInput): EmployeeSkill {
    this.#assertWritable()
    const employee = this.#requireEmployee(input.employeeId)
    const skillId = input.skillId.trim()
    const evidenceIds = uniqueStrings(input.evidenceIds ?? [])
    if (!skillId) throw new PersistenceError('Skill id cannot be empty')
    const evidence = evidenceIds.map((id) => {
      const item = this.getSkillEvidence(id)
      if (item === undefined || item.employeeId !== employee.id || item.skillId !== skillId) {
        throw new PersistenceError(`Skill evidence does not belong to ${employee.id}/${skillId}: ${id}`)
      }
      return item
    })
    if (input.status === 'verified' && !evidence.some((item) => item.outcome === 'passed')) {
      throw new PersistenceError('Verified skill requires at least one passed evidence record')
    }
    const previous = this.database
      .prepare(
        `SELECT COALESCE(MAX(revision), 0) AS revision FROM employee_skill_revisions
         WHERE employee_id = ? AND skill_id = ?`,
      )
      .get(employee.id, skillId) as { revision: number }
    const skill: EmployeeSkill = {
      employeeId: employee.id,
      skillId,
      revision: Number(previous.revision) + 1,
      status: input.status,
      evidenceIds,
      reason: input.reason.trim(),
      createdAt: this.#clock(),
    }
    if (!skill.reason) throw new PersistenceError('Skill revision reason cannot be empty')

    return this.#transaction(() => {
      this.database
        .prepare(
          `INSERT INTO employee_skill_revisions
           (employee_id, skill_id, revision, status, evidence_ids_json, reason, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          skill.employeeId,
          skill.skillId,
          skill.revision,
          skill.status,
          stringifyJson(skill.evidenceIds),
          skill.reason,
          skill.createdAt,
        )
      const skillEvent = this.#appendEvent({
        workspaceId: employee.workspaceId,
        worldId: employee.worldId,
        type: 'employee.skill.revised',
        actorId: input.actorId ?? employee.id,
        actorKind: input.actorId === undefined ? 'employee' : 'owner',
        payload: {
          employeeId: employee.id,
          skillId: skill.skillId,
          revision: skill.revision,
          status: skill.status,
          evidenceIds: skill.evidenceIds,
        },
      })
      if (skill.status === 'verified') {
        this.#insertMilestone(employee, {
          category: 'skill',
          title: `掌握技能：${skill.skillId}`,
          summary: skill.reason,
          sourceEventIds: [skillEvent.id],
          sourceMessageIds: [],
          artifactRefs: evidence.flatMap((item) => item.artifactRefs),
          occurredAt: skill.createdAt,
          actorId: input.actorId ?? employee.id,
        })
      }
      return skill
    })
  }

  listEmployeeSkills(employeeId: string): EmployeeSkill[] {
    return this.database
      .prepare(
        `SELECT revisions.* FROM employee_skill_revisions AS revisions
         JOIN (
           SELECT employee_id, skill_id, MAX(revision) AS revision
           FROM employee_skill_revisions WHERE employee_id = ? GROUP BY employee_id, skill_id
         ) AS current
         ON current.employee_id = revisions.employee_id
           AND current.skill_id = revisions.skill_id
           AND current.revision = revisions.revision
         ORDER BY revisions.skill_id`,
      )
      .all(employeeId)
      .map(mapEmployeeSkill)
  }

  appendEmployeeMilestone(input: AppendEmployeeMilestoneInput): EmployeeMilestone {
    this.#assertWritable()
    const employee = this.#requireEmployee(input.employeeId)
    const sourceEventIds = uniqueStrings(input.sourceEventIds ?? [])
    const sourceMessageIds = uniqueStrings(input.sourceMessageIds ?? [])
    this.#assertEvidenceSources(employee, sourceEventIds, sourceMessageIds)
    return this.#transaction(() =>
      this.#insertMilestone(employee, {
        category: input.category,
        title: input.title,
        summary: input.summary,
        sourceEventIds,
        sourceMessageIds,
        artifactRefs: uniqueStrings(input.artifactRefs ?? []),
        occurredAt: input.occurredAt ?? this.#clock(),
        actorId: input.actorId ?? 'owner',
      }),
    )
  }

  listEmployeeMilestones(employeeId: string, limit = 100): EmployeeMilestone[] {
    return this.database
      .prepare(
        `SELECT * FROM employee_milestones WHERE employee_id = ?
         ORDER BY occurred_at DESC, id LIMIT ?`,
      )
      .all(employeeId, Math.max(1, Math.min(limit, 500)))
      .map(mapEmployeeMilestone)
  }

  getEmployeeMilestoneRevision(employeeId: string): string {
    const row = this.database.prepare(
      `SELECT COUNT(*) AS count, COALESCE(MAX(created_at), '') AS latest
       FROM employee_milestones WHERE employee_id = ?`,
    ).get(employeeId) as { count: number; latest: string }
    return `${Number(row.count)}:${row.latest}`
  }

  /**
   * The employee memory retrieval index.
   *
   * It is created lazily because the repository touches its own tables, and
   * migrations only run after the store instance exists.
   */
  get memoryIndex(): EmployeeMemoryIndexRepository {
    this.#memoryIndexRepository ??= new EmployeeMemoryIndexRepository(this.database, {
      clock: this.#clock,
      readOnly: this.readOnly,
    })
    return this.#memoryIndexRepository
  }

  get memoryIndexSearchCapability(): MemoryIndexSearchCapability {
    return this.memoryIndex.searchCapability
  }

  /** Indexes a durable milestone. The milestone stays the source of truth. */
  indexEmployeeMemory(input: UpsertEmployeeMemoryIndexEntryInput): EmployeeMemoryIndexEntry {
    this.#assertWritable()
    return this.#transaction(() => this.memoryIndex.upsert(input))
  }

  getEmployeeMemoryIndexEntry(memoryId: string): EmployeeMemoryIndexEntry | undefined {
    return this.memoryIndex.get(memoryId)
  }

  listEmployeeMemoryIndex(
    employeeId: string,
    scopes: readonly EmployeeMemoryScope[],
    limit?: number,
  ): EmployeeMemoryIndexEntry[] {
    return this.memoryIndex.list(employeeId, scopes, limit)
  }

  searchEmployeeMemoryIndex(input: SearchEmployeeMemoryIndexInput): EmployeeMemoryIndexHit[] {
    return this.memoryIndex.search(input)
  }

  removeLegacyConversationMilestones(employeeId: string): number {
    this.#assertWritable()
    this.#requireEmployee(employeeId)
    return Number(this.database.prepare(
      `DELETE FROM employee_milestones
       WHERE employee_id = ?
         AND title IN ('完成一次真实对话', '完成一次有工具证据的任务')`,
    ).run(employeeId).changes)
  }

  writeEmployeeJournal(input: WriteEmployeeJournalInput): EmployeeDailyJournal {
    this.#assertWritable()
    const employee = this.#requireEmployee(input.employeeId)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.localDate)) {
      throw new PersistenceError('Journal local date must use YYYY-MM-DD')
    }
    const sourceEventIds = uniqueStrings(input.sourceEventIds ?? [])
    const sourceMessageIds = uniqueStrings(input.sourceMessageIds ?? [])
    this.#assertEvidenceSources(employee, sourceEventIds, sourceMessageIds)
    const previous = this.database
      .prepare(
        `SELECT COALESCE(MAX(revision), 0) AS revision FROM employee_daily_journals
         WHERE employee_id = ? AND local_date = ?`,
      )
      .get(employee.id, input.localDate) as { revision: number }
    const journal: EmployeeDailyJournal = {
      employeeId: employee.id,
      localDate: input.localDate,
      revision: Number(previous.revision) + 1,
      summary: input.summary.trim(),
      highlights: uniqueStrings(input.highlights ?? []),
      sourceEventIds,
      sourceMessageIds,
      createdAt: this.#clock(),
    }
    if (!journal.summary) throw new PersistenceError('Journal summary cannot be empty')

    return this.#transaction(() => {
      this.database
        .prepare(
          `INSERT INTO employee_daily_journals
           (employee_id, local_date, revision, summary, highlights_json,
            source_event_ids_json, source_message_ids_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          journal.employeeId,
          journal.localDate,
          journal.revision,
          journal.summary,
          stringifyJson(journal.highlights),
          stringifyJson(journal.sourceEventIds),
          stringifyJson(journal.sourceMessageIds),
          journal.createdAt,
        )
      this.#appendEvent({
        workspaceId: employee.workspaceId,
        worldId: employee.worldId,
        type: 'employee.journal.written',
        actorId: input.actorId ?? employee.id,
        actorKind: input.actorId === undefined ? 'employee' : 'owner',
        payload: {
          employeeId: employee.id,
          localDate: journal.localDate,
          revision: journal.revision,
        },
      })
      return journal
    })
  }

  listEmployeeJournals(employeeId: string, limit = 31): EmployeeDailyJournal[] {
    return this.database
      .prepare(
        `SELECT journals.* FROM employee_daily_journals AS journals
         JOIN (
           SELECT employee_id, local_date, MAX(revision) AS revision
           FROM employee_daily_journals WHERE employee_id = ? GROUP BY employee_id, local_date
         ) AS current
         ON current.employee_id = journals.employee_id
           AND current.local_date = journals.local_date
           AND current.revision = journals.revision
         ORDER BY journals.local_date DESC LIMIT ?`,
      )
      .all(employeeId, Math.max(1, Math.min(limit, 366)))
      .map(mapEmployeeJournal)
  }

  recordEmployeeInteraction(input: RecordEmployeeInteractionInput): EmployeeRelationship[] {
    this.#assertWritable()
    const employee = this.#requireEmployee(input.employeeId)
    const colleague = this.#requireEmployee(input.colleagueId)
    if (employee.worldId !== colleague.worldId || employee.workspaceId !== colleague.workspaceId) {
      throw new PersistenceError('Employee relationships cannot cross worlds')
    }
    const session = this.#requireSession(input.sessionId)
    if (session.worldId !== employee.worldId) {
      throw new PersistenceError('Interaction session belongs to another world')
    }
    const participants = new Set(
      this.listParticipants(session.id)
        .filter((participant) => participant.kind === 'employee')
        .map((participant) => participant.participantId),
    )
    if (!participants.has(employee.id) || !participants.has(colleague.id)) {
      throw new PersistenceError('Both employees must participate in the interaction session')
    }
    const now = this.#clock()
    const column = input.kind === 'review'
      ? 'review_count'
      : input.kind === 'handoff'
        ? 'handoff_count'
        : 'collaboration_count'
    const pairs: Array<[string, string]> = [
      [employee.id, colleague.id],
      [colleague.id, employee.id],
    ]

    return this.#transaction(() => {
      for (const [left, right] of pairs) {
        this.database
          .prepare(
            `INSERT INTO employee_relationships
             (employee_id, colleague_id, collaboration_count, review_count, handoff_count,
              last_interaction_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (employee_id, colleague_id) DO UPDATE SET
               ${column} = ${column} + 1,
               last_interaction_at = excluded.last_interaction_at,
               updated_at = excluded.updated_at`,
          )
          .run(
            left,
            right,
            input.kind === 'collaboration' ? 1 : 0,
            input.kind === 'review' ? 1 : 0,
            input.kind === 'handoff' ? 1 : 0,
            now,
            now,
          )
      }
      this.#appendEvent({
        workspaceId: employee.workspaceId,
        worldId: employee.worldId,
        sessionId: session.id,
        type: 'employee.relationship.updated',
        actorId: input.actorId ?? employee.id,
        actorKind: input.actorId === undefined ? 'employee' : 'owner',
        payload: {
          employeeId: employee.id,
          colleagueId: colleague.id,
          interactionKind: input.kind,
        },
      })
      return [
        this.#requireRelationship(employee.id, colleague.id),
        this.#requireRelationship(colleague.id, employee.id),
      ]
    })
  }

  listEmployeeRelationships(employeeId: string): EmployeeRelationship[] {
    return this.database
      .prepare(
        `SELECT * FROM employee_relationships
         WHERE employee_id = ? ORDER BY last_interaction_at DESC, colleague_id`,
      )
      .all(employeeId)
      .map(mapEmployeeRelationship)
  }

  getEmployeeDossier(employeeId: string): EmployeeDossier {
    const employee = this.#requireEmployee(employeeId)
    const dossier: EmployeeDossier = {
      employee,
      revisions: this.listEmployeeRevisions(employee.id),
      skills: this.listEmployeeSkills(employee.id),
      evidence: this.listSkillEvidence(employee.id),
      milestones: this.listEmployeeMilestones(employee.id),
      journals: this.listEmployeeJournals(employee.id),
      relationships: this.listEmployeeRelationships(employee.id),
    }
    const profile = this.getEmployeeProfile(employee.id)
    if (profile !== undefined) dossier.profile = profile
    dossier.profileHistory = this.listEmployeeProfiles(employee.id).sort((left, right) => right.revision - left.revision)
    return dossier
  }

  createSession(input: CreateSessionInput): WorkSession {
    this.#assertWritable()
    const workspace = this.#requireWorkspace(input.workspaceId)
    const world = this.#requireWorld(input.worldId)
    if (world.workspaceId !== workspace.id || world.status === 'archived') {
      throw new PersistenceError('Session cannot be created in this world')
    }
    const now = this.#clock()
    const session: WorkSession = {
      id: this.#idFactory(),
      workspaceId: input.workspaceId,
      worldId: input.worldId,
      kind: input.kind,
      collaborationMode: validateSessionCollaborationMode(input.collaborationMode ?? 'discussion'),
      title: input.title.trim(),
      status: 'open',
      createdAt: now,
      updatedAt: now,
    }
    if (!session.title) throw new PersistenceError('Session title cannot be empty')

    return this.#transaction(() => {
      this.database
        .prepare(
          `INSERT INTO work_sessions
           (id, workspace_id, world_id, kind, collaboration_mode, title, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          session.id,
          session.workspaceId,
          session.worldId,
          session.kind,
          session.collaborationMode ?? 'discussion',
          session.title,
          session.status,
          session.createdAt,
          session.updatedAt,
        )
      this.#appendEvent({
        workspaceId: session.workspaceId,
        worldId: session.worldId,
        type: 'session.created',
        actorId: input.actorId ?? 'owner',
        actorKind: 'owner',
        sessionId: session.id,
        payload: {
          sessionId: session.id,
          worldId: session.worldId,
          kind: session.kind,
          title: session.title,
        },
      })
      for (const participant of input.participants ?? []) {
        this.#addParticipant(session, participant.participantId, participant.kind)
      }
      return session
    })
  }

  addParticipant(
    sessionId: string,
    participantId: string,
    kind: ParticipantKind,
  ): WorkSessionParticipant {
    this.#assertWritable()
    const session = this.#requireSession(sessionId)
    return this.#transaction(() => this.#addParticipant(session, participantId, kind))
  }

  getSession(sessionId: string): WorkSession | undefined {
    const row = this.database.prepare('SELECT * FROM work_sessions WHERE id = ?').get(sessionId)
    return row ? mapSession(row) : undefined
  }

  listSessions(worldId: string, status?: WorkSession['status']): WorkSession[] {
    const rows = status
      ? this.database
          .prepare(
            'SELECT * FROM work_sessions WHERE world_id = ? AND status = ? ORDER BY updated_at DESC, id',
          )
          .all(worldId, status)
      : this.database
          .prepare('SELECT * FROM work_sessions WHERE world_id = ? ORDER BY updated_at DESC, id')
          .all(worldId)
    return rows.map(mapSession)
  }

  setSessionCollaborationMode(sessionId: string, collaborationMode: WorkSessionCollaborationMode): WorkSession {
    this.#assertWritable()
    const session = this.#requireSession(sessionId)
    if (session.kind !== 'group') throw new PersistenceError('Only group sessions can change collaboration mode')
    const mode = validateSessionCollaborationMode(collaborationMode)
    if (session.collaborationMode === mode) return session
    const now = this.#clock()
    return this.#transaction(() => {
      const result = this.database.prepare(
        `UPDATE work_sessions SET collaboration_mode = ?, updated_at = ?
         WHERE id = ? AND collaboration_mode = ?`,
      ).run(mode, now, session.id, session.collaborationMode ?? 'discussion')
      if (Number(result.changes) !== 1) throw new PersistenceError('Session collaboration mode changed concurrently')
      return this.getSession(session.id)!
    })
  }

  updateSessionCollaborationMode(input: UpdateSessionCollaborationModeInput): WorkSession {
    return this.setSessionCollaborationMode(input.sessionId, input.collaborationMode)
  }

  createTaskCollaborationPlan(input: CreateTaskCollaborationPlanInput): TaskCollaborationPlan {
    this.#assertWritable()
    const world = this.#requireWorld(input.worldId)
    const workspace = this.#requireWorkspace(input.workspaceId)
    if (world.workspaceId !== workspace.id || world.status === 'archived') {
      throw new PersistenceError('Task collaboration plan cannot be created in this world')
    }
    const session = this.#requireSession(input.sessionId)
    if (session.workspaceId !== workspace.id || session.worldId !== world.id) {
      throw new PersistenceError('Task collaboration plan session does not match its world')
    }
    if (session.kind !== 'group') throw new PersistenceError('Task collaboration plan requires a group session')
    const turn = this.getWorkTurn(input.workTurnId)
    if (turn === undefined || turn.workspaceId !== workspace.id || turn.worldId !== world.id || turn.sessionId !== session.id) {
      throw new PersistenceError('Task collaboration plan work turn does not match its session')
    }
    if (turn.interactionKind !== 'task') throw new PersistenceError('Task collaboration plan requires a task work turn')
    const taskId = normalizeRequiredToken(input.taskId, 'Task collaboration task id', 160)
    const status = validateTaskPlanStatus(input.status ?? 'planned')
    const steps = normalizeTaskSteps(input.steps, this.#idFactory)
    assertTerminalTaskPlanSteps(status, steps)
    this.#assertTaskStepEmployees(world, steps)
    assertTaskStepGraph(steps)

    const existing = this.getTaskCollaborationPlanByTask(world.id, taskId)
    if (existing !== undefined) {
      if (existing.sessionId !== session.id || existing.workTurnId !== turn.id) {
        throw new PersistenceError('Task collaboration task id is already bound to another scope')
      }
      return existing
    }

    const now = this.#clock()
    const planId = normalizeOptionalId(input.id, this.#idFactory)
    const plan: TaskCollaborationPlan = {
      id: planId,
      taskId,
      workspaceId: workspace.id,
      worldId: world.id,
      sessionId: session.id,
      workTurnId: turn.id,
      revision: 1,
      status,
      steps: steps.map((step) => taskStepFromNormalized(step, planId, now)),
      createdAt: now,
      updatedAt: now,
    }
    return this.#transaction(() => {
      this.database.prepare(
        `INSERT INTO task_collaboration_plans
         (id, task_id, workspace_id, world_id, session_id, work_turn_id, revision,
          status, error_code, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        plan.id, plan.taskId, plan.workspaceId, plan.worldId, plan.sessionId,
        plan.workTurnId, plan.revision, plan.status, null, plan.createdAt, plan.updatedAt,
      )
      for (const step of plan.steps) this.#insertTaskCollaborationStep(step)
      return this.getTaskCollaborationPlan(plan.id)!
    })
  }

  getTaskCollaborationPlan(planId: string): TaskCollaborationPlan | undefined {
    const row = this.database.prepare('SELECT * FROM task_collaboration_plans WHERE id = ?').get(planId)
    return row === undefined ? undefined : this.#mapTaskCollaborationPlan(row)
  }

  getTaskCollaborationPlanByTask(worldId: string, taskId: string): TaskCollaborationPlan | undefined {
    this.#requireWorld(worldId)
    const row = this.database.prepare(
      'SELECT * FROM task_collaboration_plans WHERE world_id = ? AND task_id = ?',
    ).get(worldId, taskId.trim())
    return row === undefined ? undefined : this.#mapTaskCollaborationPlan(row)
  }

  getLatestTaskCollaborationPlanForSession(sessionId: string): TaskCollaborationPlan | undefined
  getLatestTaskCollaborationPlanForSession(worldId: string, sessionId: string): TaskCollaborationPlan | undefined
  getLatestTaskCollaborationPlanForSession(firstId: string, secondId?: string): TaskCollaborationPlan | undefined {
    const sessionId = secondId ?? firstId
    const session = this.#requireSession(sessionId)
    if (secondId !== undefined && session.worldId !== firstId) {
      throw new PersistenceError('Task collaboration plan session does not match its world')
    }
    const row = this.database.prepare(
      `SELECT * FROM task_collaboration_plans
       WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
    ).get(sessionId)
    return row === undefined ? undefined : this.#mapTaskCollaborationPlan(row)
  }

  getTaskCollaborationPlanByTurn(worldId: string, workTurnId: string): TaskCollaborationPlan | undefined {
    this.#requireWorld(worldId)
    const row = this.database.prepare(
      `SELECT * FROM task_collaboration_plans
       WHERE world_id = ? AND work_turn_id = ?
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    ).get(worldId, workTurnId)
    return row === undefined ? undefined : this.#mapTaskCollaborationPlan(row)
  }

  listTaskCollaborationPlans(worldId: string, status?: TaskCollaborationPlanStatus): TaskCollaborationPlan[] {
    this.#requireWorld(worldId)
    const rows = status === undefined
      ? this.database.prepare(
          'SELECT * FROM task_collaboration_plans WHERE world_id = ? ORDER BY created_at, id',
        ).all(worldId)
      : this.database.prepare(
          'SELECT * FROM task_collaboration_plans WHERE world_id = ? AND status = ? ORDER BY created_at, id',
        ).all(worldId, status)
    return rows.map((row) => this.#mapTaskCollaborationPlan(row))
  }

  updateTaskCollaborationPlan(input: UpdateTaskCollaborationPlanInput): TaskCollaborationPlan {
    this.#assertWritable()
    const current = this.getTaskCollaborationPlan(input.planId)
    if (current === undefined) throw new EntityNotFoundError(`Task collaboration plan not found: ${input.planId}`)
    const expectedRevision = input.expectedRevision ?? input.revision
    if (expectedRevision === undefined || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new PersistenceError('Task collaboration plan revision is required')
    }
    if (current.revision !== expectedRevision) {
      throw new PersistenceError('Task collaboration plan changed concurrently')
    }
    if (input.steps !== undefined && isTerminalTaskPlanStatus(current.status)) {
      throw new PersistenceError('Terminal task collaboration plan cannot change steps')
    }
    const steps = normalizeTaskSteps(
      input.steps === undefined ? current.steps.map(taskStepToInput) : input.steps,
      this.#idFactory,
    )
    const world = this.#requireWorld(current.worldId)
    this.#assertTaskStepEmployees(world, steps)
    assertTaskStepGraph(steps)
    const status = validateTaskPlanStatus(input.status ?? current.status)
    assertTaskPlanTransition(current.status, status)
    assertTerminalTaskPlanSteps(status, steps)
    const currentSteps = new Map(current.steps.map((step) => [step.id, step]))
    for (const step of steps) {
      const previous = currentSteps.get(step.id)
      if (previous !== undefined) assertTaskStepTransition(previous.status, step.status)
    }
    const errorCode = input.errorCode === undefined ? current.errorCode : normalizeOptionalError(input.errorCode)
    const now = this.#clock()
    return this.#transaction(() => {
      const result = this.database.prepare(
        `UPDATE task_collaboration_plans
         SET revision = revision + 1, status = ?, error_code = ?, updated_at = ?
         WHERE id = ? AND revision = ?`,
      ).run(status, errorCode ?? null, now, current.id, expectedRevision)
      if (Number(result.changes) !== 1) throw new PersistenceError('Task collaboration plan changed concurrently')
      this.database.prepare('DELETE FROM task_collaboration_steps WHERE plan_id = ?').run(current.id)
      const createdAtByStepId = new Map(current.steps.map((step) => [step.id, step.createdAt]))
      for (const step of steps) {
        this.#insertTaskCollaborationStep(taskStepFromNormalized(
          step,
          current.id,
          now,
          createdAtByStepId.get(step.id),
        ))
      }
      return this.getTaskCollaborationPlan(current.id)!
    })
  }

  updateTaskCollaborationStep(input: UpdateTaskCollaborationStepInput): TaskCollaborationPlan {
    const current = this.getTaskCollaborationPlan(input.planId)
    if (current === undefined) throw new EntityNotFoundError(`Task collaboration plan not found: ${input.planId}`)
    const step = current.steps.find((item) => item.id === input.stepId)
    if (step === undefined) throw new EntityNotFoundError(`Task collaboration step not found: ${input.stepId}`)
    const next: TaskCollaborationStepInput = {
      id: step.id,
      requiredSkills: input.requiredSkills ?? step.requiredSkills,
      assignedEmployeeIds: input.assignedEmployeeIds ?? step.assignedEmployeeIds,
      dependsOn: input.dependsOn ?? step.dependsOn,
      executionMode: input.executionMode ?? step.executionMode,
      status: input.status ?? step.status,
      ...(input.errorCode === undefined
        ? (step.errorCode === undefined ? {} : { errorCode: step.errorCode })
        : { errorCode: input.errorCode }),
    }
    return this.updateTaskCollaborationPlan({
      planId: input.planId,
      ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }),
      ...(input.revision === undefined ? {} : { revision: input.revision }),
      steps: current.steps.map((item) => item.id === step.id ? next : taskStepToInput(item)),
      ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
    })
  }

  recoverTaskCollaborationPlansAfterRestart(now = this.#clock()): TaskCollaborationRecoveryReport {
    this.#assertWritable()
    return this.#transaction(() => this.#recoverTaskCollaborationPlansAfterRestart(now))
  }

  createWorkTurn(input: CreateWorkTurnInput): WorkTurn {
    this.#assertWritable()
    const session = this.#requireSession(input.sessionId)
    if (session.workspaceId !== input.workspaceId || session.worldId !== input.worldId) {
      throw new PersistenceError('Work turn scope does not match session')
    }
    const clientTurnId = input.clientTurnId?.trim()
    if (clientTurnId !== undefined && (clientTurnId.length === 0 || clientTurnId.length > 128)) {
      throw new PersistenceError('Work turn client id is invalid')
    }
    const turn: WorkTurn = {
      id: this.#idFactory(), workspaceId: input.workspaceId, worldId: input.worldId,
      sessionId: input.sessionId, interactionKind: input.interactionKind,
      status: 'queued', createdAt: this.#clock(),
      ...(clientTurnId === undefined ? {} : { clientTurnId }),
    }
    this.database.prepare(
      `INSERT INTO work_turns
       (id, workspace_id, world_id, session_id, client_turn_id, interaction_kind, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(turn.id, turn.workspaceId, turn.worldId, turn.sessionId, turn.clientTurnId ?? null,
      turn.interactionKind, turn.status, turn.createdAt)
    return turn
  }

  getWorkTurn(turnId: string): WorkTurn | undefined {
    const row = this.database.prepare('SELECT * FROM work_turns WHERE id = ?').get(turnId)
    return row === undefined ? undefined : mapWorkTurn(row)
  }

  getWorkTurnByClientTurnId(workspaceId: string, worldId: string, clientTurnId: string): WorkTurn | undefined {
    const row = this.database.prepare(
      `SELECT * FROM work_turns
       WHERE workspace_id = ? AND world_id = ? AND client_turn_id = ?
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    ).get(workspaceId, worldId, clientTurnId.trim())
    return row === undefined ? undefined : mapWorkTurn(row)
  }

  listSessionTurns(sessionId: string): WorkTurn[] {
    this.#requireSession(sessionId)
    return this.database.prepare(
      'SELECT * FROM work_turns WHERE session_id = ? ORDER BY created_at DESC, id DESC',
    ).all(sessionId).map(mapWorkTurn)
  }

  listWorkTurnsByStatus(status: WorkTurn['status']): WorkTurn[] {
    return this.database.prepare(
      'SELECT * FROM work_turns WHERE status = ? ORDER BY created_at, id',
    ).all(status).map(mapWorkTurn)
  }

  enqueueConversationTurn(input: EnqueueConversationTurnInput): ConversationQueueEntry {
    return this.#enqueueConversationTurn(input, input.priority ?? 0)
  }

  enqueue(input: EnqueueConversationTurnInput): ConversationQueueEntry {
    return this.enqueueConversationTurn(input)
  }

  enqueueNextConversationTurn(input: EnqueueConversationTurnInput): ConversationQueueEntry {
    this.#assertWritable()
    const world = this.#requireWorld(input.worldId)
    const next = this.database.prepare(
      `SELECT COALESCE(MAX(priority), -1) + 1 AS priority
       FROM conversation_queue_entries
       WHERE world_id = ? AND status IN ('queued', 'running', 'waiting-approval')`,
    ).get(world.id) as { priority: number }
    return this.#enqueueConversationTurn(input, Number(next.priority))
  }

  enqueueNext(input: EnqueueConversationTurnInput): ConversationQueueEntry {
    return this.enqueueNextConversationTurn(input)
  }

  promoteConversationQueueEntry(queueEntryId: string, expectedRevision?: number): ConversationQueueEntry {
    this.#assertWritable()
    const entry = this.#requireQueueEntryForTransition(queueEntryId, 'queued', expectedRevision)
    const next = this.database.prepare(
      `SELECT COALESCE(MAX(priority), -1) + 1 AS priority
       FROM conversation_queue_entries
       WHERE world_id = ? AND status IN ('queued', 'running', 'waiting-approval')`,
    ).get(entry.worldId) as { priority: number }
    const now = this.#clock()
    const result = this.database.prepare(
      `UPDATE conversation_queue_entries
       SET priority = ?, revision = revision + 1, updated_at = ?
       WHERE id = ? AND status = 'queued' AND revision = ?`,
    ).run(Number(next.priority), now, entry.id, entry.revision)
    if (Number(result.changes) !== 1) throw new PersistenceError('Conversation queue entry changed concurrently')
    return this.getConversationQueueEntry(entry.id)!
  }

  getConversationQueueEntry(queueEntryId: string): ConversationQueueEntry | undefined {
    const row = this.database.prepare('SELECT * FROM conversation_queue_entries WHERE id = ?').get(queueEntryId)
    return row === undefined ? undefined : mapConversationQueueEntry(row)
  }

  getConversationQueueEntryByTurn(worldId: string, workTurnId: string): ConversationQueueEntry | undefined {
    this.#requireWorld(worldId)
    const row = this.database.prepare(
      `SELECT * FROM conversation_queue_entries
       WHERE world_id = ? AND work_turn_id = ?
       ORDER BY enqueued_at DESC, id DESC LIMIT 1`,
    ).get(worldId, workTurnId)
    return row === undefined ? undefined : mapConversationQueueEntry(row)
  }

  getConversationQueueEntryByWorkTurn(worldId: string, workTurnId: string): ConversationQueueEntry | undefined {
    return this.getConversationQueueEntryByTurn(worldId, workTurnId)
  }

  getConversationQueueEntryForTurn(worldId: string, workTurnId: string): ConversationQueueEntry | undefined {
    return this.getConversationQueueEntryByTurn(worldId, workTurnId)
  }

  listConversationQueue(
    worldId: string,
    sessionId?: string,
    status?: ConversationQueueEntryStatus,
  ): ConversationQueueEntry[] {
    this.#requireWorld(worldId)
    if (sessionId !== undefined) {
      const session = this.#requireSession(sessionId)
      if (session.worldId !== worldId) throw new PersistenceError('Conversation queue session does not match world')
    }
    const rows = status === undefined
      ? sessionId === undefined
        ? this.database.prepare(
            'SELECT * FROM conversation_queue_entries WHERE world_id = ? ORDER BY priority DESC, enqueued_at, id',
          ).all(worldId)
        : this.database.prepare(
            'SELECT * FROM conversation_queue_entries WHERE world_id = ? AND session_id = ? ORDER BY priority DESC, enqueued_at, id',
          ).all(worldId, sessionId)
      : sessionId === undefined
        ? this.database.prepare(
            'SELECT * FROM conversation_queue_entries WHERE world_id = ? AND status = ? ORDER BY priority DESC, enqueued_at, id',
          ).all(worldId, status)
        : this.database.prepare(
            'SELECT * FROM conversation_queue_entries WHERE world_id = ? AND session_id = ? AND status = ? ORDER BY priority DESC, enqueued_at, id',
          ).all(worldId, sessionId, status)
    return rows.map(mapConversationQueueEntry)
  }

  listQueuedConversationTurns(worldId: string, sessionId?: string): ConversationQueueEntry[] {
    return this.listConversationQueue(worldId, sessionId).filter((entry) =>
      entry.status === 'queued' || entry.status === 'running' || entry.status === 'waiting-approval')
  }

  claimConversationQueueEntry(input: ClaimConversationQueueEntryInput): ConversationQueueEntry {
    this.#assertWritable()
    const leaseOwner = normalizeRequiredToken(input.leaseOwner, 'Conversation queue lease owner', 160)
    if (!Number.isSafeInteger(input.leaseDurationMs) || input.leaseDurationMs <= 0) {
      throw new PersistenceError('Conversation queue lease duration must be positive')
    }
    const entry = this.getConversationQueueEntry(input.queueEntryId)
    if (entry === undefined) throw new EntityNotFoundError(`Conversation queue entry not found: ${input.queueEntryId}`)
    if (entry.status !== 'queued') throw new PersistenceError('Conversation queue entry is not queued')
    if (input.expectedRevision !== undefined && input.expectedRevision !== entry.revision) {
      throw new PersistenceError('Conversation queue entry changed concurrently')
    }
    const turn = this.getWorkTurn(entry.workTurnId)
    if (turn === undefined || (turn.status !== 'queued' && turn.status !== 'running')) throw new PersistenceError('Queued WorkTurn is unavailable')
    const now = this.#clock()
    const leaseExpiresAt = new Date(Date.parse(now) + input.leaseDurationMs).toISOString()
    return this.#transaction(() => {
      const result = this.database.prepare(
        `UPDATE conversation_queue_entries
         SET status = 'running', revision = revision + 1,
             attempt_count = attempt_count + 1, claimed_at = COALESCE(claimed_at, ?),
             lease_owner = ?, lease_expires_at = ?, updated_at = ?
         WHERE id = ? AND status = 'queued' AND revision = ? AND available_at <= ?
           AND NOT EXISTS (
             SELECT 1 FROM conversation_queue_entries AS occupied
             WHERE occupied.session_id = conversation_queue_entries.session_id
               AND occupied.id <> conversation_queue_entries.id
               AND occupied.status IN ('running', 'waiting-approval')
           )
           AND NOT EXISTS (
             SELECT 1 FROM json_each(conversation_queue_entries.employee_ids_json) AS candidate_employee
             WHERE (
               SELECT COUNT(*) FROM conversation_queue_entries AS running,
                    json_each(running.employee_ids_json) AS running_employee
               WHERE running.status = 'running'
                 AND (running.lease_expires_at IS NULL OR running.lease_expires_at > ?)
                 AND running_employee.value = candidate_employee.value
             ) >= 2
           )`,
      ).run(now, leaseOwner, leaseExpiresAt, now, entry.id, entry.revision, now, now)
      if (Number(result.changes) !== 1) throw new PersistenceError('Conversation queue entry changed concurrently')
      if (turn.status === 'queued') {
        const turnResult = this.database.prepare(
          `UPDATE work_turns SET status = 'running', started_at = COALESCE(started_at, ?)
           WHERE id = ? AND status = 'queued'`,
        ).run(now, entry.workTurnId)
        if (Number(turnResult.changes) !== 1) throw new PersistenceError('Queued WorkTurn changed concurrently')
      }
      return this.getConversationQueueEntry(entry.id)!
    })
  }

  renewConversationQueueLease(queueEntryId: string, leaseOwner: string, leaseDurationMs: number): ConversationQueueEntry {
    this.#assertWritable()
    if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs <= 0) throw new PersistenceError('Conversation queue lease duration must be positive')
    const now = this.#clock()
    const leaseExpiresAt = new Date(Date.parse(now) + leaseDurationMs).toISOString()
    const row = this.database.prepare(
      `UPDATE conversation_queue_entries SET lease_expires_at = ?, updated_at = ?
       WHERE id = ? AND status = 'running' AND lease_owner = ? RETURNING *`,
    ).get(leaseExpiresAt, now, queueEntryId, leaseOwner.trim())
    if (row === undefined) throw new PersistenceError('Conversation queue lease cannot be renewed')
    return mapConversationQueueEntry(row)
  }

  recoverConversationQueueLeases(afterRestart = false): { requeued: number } {
    this.#assertWritable()
    const now = this.#clock()
    return this.#transaction(() => {
      const predicate = afterRestart
        ? `status = 'running'`
        : `status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`
      const parameters = afterRestart ? [] : [now]
      const rows = this.database.prepare(
        `SELECT id, work_turn_id FROM conversation_queue_entries
         WHERE ${predicate}
           AND NOT EXISTS (
             SELECT 1 FROM agent_runs
             WHERE agent_runs.turn_id = conversation_queue_entries.work_turn_id
               AND agent_runs.status IN ('queued', 'running')
           )`,
      ).all(...parameters) as Array<{ id: string; work_turn_id: string }>
      for (const row of rows) {
        this.database.prepare(
          `UPDATE conversation_queue_entries
           SET status = 'queued', revision = revision + 1, available_at = ?,
               lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
           WHERE id = ? AND status = 'running'`,
        ).run(now, now, row.id)
        this.database.prepare(
          `UPDATE work_turns SET status = 'queued', started_at = NULL
           WHERE id = ? AND status = 'running'`,
        ).run(row.work_turn_id)
      }
      return { requeued: rows.length }
    })
  }

  claimConversationTurn(input: ClaimConversationQueueEntryInput): ConversationQueueEntry {
    return this.claimConversationQueueEntry(input)
  }

  waitConversationQueueEntryForApproval(input: ConversationQueueTransitionInput): ConversationQueueEntry {
    this.#assertWritable()
    const entry = this.#requireQueueEntryForTransition(input.queueEntryId, ['running', 'waiting-approval'], input.expectedRevision)
    const turn = this.getWorkTurn(entry.workTurnId)
    if (turn === undefined || (turn.status !== 'running' && turn.status !== 'waiting-approval')) {
      throw new PersistenceError('Conversation queue WorkTurn cannot wait for approval')
    }
    const now = this.#clock()
    return this.#transaction(() => {
      if (turn.status === 'running') {
        const turnResult = this.database.prepare(
          `UPDATE work_turns SET status = 'waiting-approval'
           WHERE id = ? AND status = 'running'`,
        ).run(entry.workTurnId)
        if (Number(turnResult.changes) !== 1) throw new PersistenceError('WorkTurn changed concurrently')
      }
      const result = this.database.prepare(
        `UPDATE conversation_queue_entries
         SET status = 'waiting-approval', revision = revision + 1,
             lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE id = ? AND status IN ('running', 'waiting-approval') AND revision = ?`,
      ).run(now, entry.id, entry.revision)
      if (Number(result.changes) !== 1) throw new PersistenceError('Conversation queue entry changed concurrently')
      return this.getConversationQueueEntry(entry.id)!
    })
  }

  waitConversationTurnForApproval(input: ConversationQueueTransitionInput): ConversationQueueEntry {
    return this.waitConversationQueueEntryForApproval(input)
  }

  resumeConversationQueueEntryAfterApproval(input: ConversationQueueTransitionInput): ConversationQueueEntry {
    this.#assertWritable()
    const entry = this.#requireQueueEntryForTransition(input.queueEntryId, 'waiting-approval', input.expectedRevision)
    const turn = this.getWorkTurn(entry.workTurnId)
    if (turn === undefined || (turn.status !== 'waiting-approval' && turn.status !== 'running')) {
      throw new PersistenceError('Conversation queue WorkTurn cannot resume after approval')
    }
    const now = this.#clock()
    const leaseExpiresAt = new Date(Date.parse(now) + 30_000).toISOString()
    return this.#transaction(() => {
      if (turn.status === 'waiting-approval') {
        const turnResult = this.database.prepare(
          `UPDATE work_turns SET status = 'running', started_at = COALESCE(started_at, ?)
           WHERE id = ? AND status = 'waiting-approval'`,
        ).run(now, entry.workTurnId)
        if (Number(turnResult.changes) !== 1) throw new PersistenceError('WorkTurn changed concurrently')
      }
      const result = this.database.prepare(
        `UPDATE conversation_queue_entries
         SET status = 'running', revision = revision + 1,
             lease_owner = 'approval-continuation', lease_expires_at = ?, updated_at = ?
         WHERE id = ? AND status = 'waiting-approval' AND revision = ?`,
      ).run(leaseExpiresAt, now, entry.id, entry.revision)
      if (Number(result.changes) !== 1) throw new PersistenceError('Conversation queue entry changed concurrently')
      return this.getConversationQueueEntry(entry.id)!
    })
  }

  resumeConversationTurnAfterApproval(input: ConversationQueueTransitionInput): ConversationQueueEntry {
    return this.resumeConversationQueueEntryAfterApproval(input)
  }

  completeConversationQueueEntry(input: CompleteConversationQueueEntryInput): ConversationQueueEntry {
    this.#assertWritable()
    const entry = this.#requireQueueEntryForTransition(input.queueEntryId, ['running', 'waiting-approval'], input.expectedRevision)
    const turn = this.getWorkTurn(entry.workTurnId)
    if (turn === undefined || (turn.status !== 'running' && turn.status !== 'completed')) {
      throw new PersistenceError('Running WorkTurn is unavailable')
    }
    const now = this.#clock()
    return this.#transaction(() => {
      if (turn.status === 'running') {
        const turnResult = this.database.prepare(
          `UPDATE work_turns SET status = 'completed', completed_at = ?
           WHERE id = ? AND status = 'running'`,
        ).run(now, entry.workTurnId)
        if (Number(turnResult.changes) !== 1) throw new PersistenceError('WorkTurn changed concurrently')
      }
      const result = this.database.prepare(
        `UPDATE conversation_queue_entries
         SET status = 'completed', revision = revision + 1, completed_at = ?,
             lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE id = ? AND status IN ('running', 'waiting-approval') AND revision = ?`,
      ).run(now, now, entry.id, entry.revision)
      if (Number(result.changes) !== 1) throw new PersistenceError('Conversation queue entry changed concurrently')
      return this.getConversationQueueEntry(entry.id)!
    })
  }

  completeConversationTurn(input: CompleteConversationQueueEntryInput): ConversationQueueEntry {
    return this.completeConversationQueueEntry(input)
  }

  failConversationQueueEntry(input: FailConversationQueueEntryInput): ConversationQueueEntry {
    this.#assertWritable()
    const errorCode = normalizeQueueErrorCode(input.errorCode)
    const entry = this.#requireQueueEntryForTransition(input.queueEntryId, ['running', 'waiting-approval'], input.expectedRevision)
    const turn = this.getWorkTurn(entry.workTurnId)
    if (turn === undefined || (turn.status !== 'running' && turn.status !== 'waiting-approval' && turn.status !== 'failed')) {
      throw new PersistenceError('WorkTurn cannot be failed from its current state')
    }
    const finalErrorCode = turn.status === 'failed' ? (turn.errorCode ?? errorCode) : errorCode
    const now = this.#clock()
    return this.#transaction(() => {
      if (turn.status === 'running' || turn.status === 'waiting-approval') {
        const turnResult = this.database.prepare(
          `UPDATE work_turns SET status = 'failed', error_code = ?, completed_at = ?
           WHERE id = ? AND status IN ('running', 'waiting-approval')`,
        ).run(finalErrorCode, now, entry.workTurnId)
        if (Number(turnResult.changes) !== 1) throw new PersistenceError('WorkTurn changed concurrently')
      }
      const result = this.database.prepare(
        `UPDATE conversation_queue_entries
         SET status = 'failed', error_code = ?, revision = revision + 1, completed_at = ?,
             lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE id = ? AND status IN ('running', 'waiting-approval') AND revision = ?`,
      ).run(finalErrorCode, now, now, entry.id, entry.revision)
      if (Number(result.changes) !== 1) throw new PersistenceError('Conversation queue entry changed concurrently')
      return this.getConversationQueueEntry(entry.id)!
    })
  }

  failConversationTurn(input: FailConversationQueueEntryInput): ConversationQueueEntry {
    return this.failConversationQueueEntry(input)
  }

  interruptConversationQueueEntry(input: InterruptConversationQueueEntryInput): ConversationQueueEntry {
    this.#assertWritable()
    const entry = this.#requireQueueEntryForTransition(
      input.queueEntryId,
      ['queued', 'running', 'waiting-approval'],
      input.expectedRevision,
    )
    const turn = this.getWorkTurn(entry.workTurnId)
    if (turn === undefined || (turn.status !== 'queued' && turn.status !== 'running' && turn.status !== 'waiting-approval' && turn.status !== 'interrupted')) {
      throw new PersistenceError('Conversation queue WorkTurn cannot be interrupted')
    }
    const errorCode = normalizeQueueErrorCode(input.errorCode ?? 'interrupted')
    const finalErrorCode = turn.status === 'interrupted' ? (turn.errorCode ?? errorCode) : errorCode
    const now = this.#clock()
    return this.#transaction(() => {
      if (turn.status === 'queued' || turn.status === 'running' || turn.status === 'waiting-approval') {
        const turnResult = this.database.prepare(
          `UPDATE work_turns SET status = 'interrupted', error_code = ?, completed_at = ?
           WHERE id = ? AND status IN ('queued', 'running', 'waiting-approval')`,
        ).run(finalErrorCode, now, entry.workTurnId)
        if (Number(turnResult.changes) !== 1) throw new PersistenceError('WorkTurn changed concurrently')
      }
      const runs = this.database.prepare(
        `SELECT id FROM agent_runs WHERE turn_id = ? AND status IN ('queued', 'running')`,
      ).all(entry.workTurnId) as Array<{ id: string }>
      for (const run of runs) {
        this.database.prepare(
          `UPDATE agent_runs SET status = 'interrupted', error_code = ?, completed_at = ?
           WHERE id = ? AND status IN ('queued', 'running')`,
        ).run(finalErrorCode, now, run.id)
        this.#markRunOutputUnfinished(run.id)
      }
      const result = this.database.prepare(
        `UPDATE conversation_queue_entries
         SET status = 'interrupted', error_code = ?, revision = revision + 1, completed_at = ?,
             lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE id = ? AND status IN ('queued', 'running', 'waiting-approval') AND revision = ?`,
      ).run(finalErrorCode, now, now, entry.id, entry.revision)
      if (Number(result.changes) !== 1) throw new PersistenceError('Conversation queue entry changed concurrently')
      return this.getConversationQueueEntry(entry.id)!
    })
  }

  interruptConversationTurn(input: InterruptConversationQueueEntryInput): ConversationQueueEntry {
    return this.interruptConversationQueueEntry(input)
  }

  removeConversationQueueEntry(input: RemoveConversationQueueEntryInput): ConversationQueueEntry {
    this.#assertWritable()
    const entry = this.#requireQueueEntryForTransition(input.queueEntryId, 'queued', input.expectedRevision)
    const errorCode = normalizeQueueErrorCode(input.errorCode ?? 'queue-cancelled')
    const turn = this.getWorkTurn(entry.workTurnId)
    if (turn === undefined || turn.status !== 'queued') throw new PersistenceError('Queued WorkTurn is unavailable')
    const now = this.#clock()
    return this.#transaction(() => {
      const turnResult = this.database.prepare(
        `UPDATE work_turns SET status = 'interrupted', error_code = ?, completed_at = ?
         WHERE id = ? AND status = 'queued'`,
      ).run(errorCode, now, entry.workTurnId)
      if (Number(turnResult.changes) !== 1) throw new PersistenceError('Queued WorkTurn changed concurrently')
      const result = this.database.prepare(
        `UPDATE conversation_queue_entries
         SET status = 'cancelled', error_code = ?, revision = revision + 1, completed_at = ?, updated_at = ?
         WHERE id = ? AND status = 'queued' AND revision = ?`,
      ).run(errorCode, now, now, entry.id, entry.revision)
      if (Number(result.changes) !== 1) throw new PersistenceError('Conversation queue entry changed concurrently')
      return this.getConversationQueueEntry(entry.id)!
    })
  }

  cancelQueuedConversationTurn(input: RemoveConversationQueueEntryInput): ConversationQueueEntry {
    return this.removeConversationQueueEntry(input)
  }

  clearConversationQueue(input: ClearConversationQueueInput): number {
    this.#assertWritable()
    const world = this.#requireWorld(input.worldId)
    if (input.workspaceId !== undefined && input.workspaceId !== world.workspaceId) {
      throw new PersistenceError('Conversation queue workspace does not match world')
    }
    if (input.sessionId !== undefined) {
      const session = this.#requireSession(input.sessionId)
      if (session.worldId !== world.id) throw new PersistenceError('Conversation queue session does not match world')
    }
    const rows = input.sessionId === undefined
      ? this.database.prepare(
          `SELECT * FROM conversation_queue_entries
           WHERE world_id = ? AND status = 'queued' ORDER BY priority DESC, enqueued_at, id`,
        ).all(world.id)
      : this.database.prepare(
          `SELECT * FROM conversation_queue_entries
           WHERE world_id = ? AND session_id = ? AND status = 'queued'
           ORDER BY priority DESC, enqueued_at, id`,
        ).all(world.id, input.sessionId)
    const entries = rows.map(mapConversationQueueEntry)
    if (entries.length === 0) return 0
    const now = this.#clock()
    return this.#transaction(() => entries.reduce((count, entry) => count + (this.#cancelQueuedQueueEntry(entry, now) ? 1 : 0), 0))
  }

  startWorkTurn(turnId: string): WorkTurn {
    return this.#transitionWorkTurn(turnId, ['queued'], 'running')
  }

  waitWorkTurnForApproval(turnId: string): WorkTurn {
    return this.#transitionWorkTurn(turnId, ['running'], 'waiting-approval')
  }

  resumeWorkTurnAfterApproval(turnId: string): WorkTurn {
    return this.#transitionWorkTurn(turnId, ['waiting-approval'], 'running')
  }

  completeWorkTurn(turnId: string): WorkTurn {
    return this.#transitionWorkTurn(turnId, ['running'], 'completed')
  }

  failWorkTurn(turnId: string, errorCode: string): WorkTurn {
    return this.#transitionWorkTurn(turnId, ['running'], 'failed', errorCode)
  }

  interruptWorkTurn(turnId: string, errorCode = 'interrupted'): WorkTurn {
    return this.#transitionWorkTurn(turnId, ['queued', 'running', 'waiting-approval'], 'interrupted', errorCode)
  }

  createAgentRun(input: CreateAgentRunInput): AgentRun {
    this.#assertWritable()
    const turn = this.getWorkTurn(input.turnId)
    const employee = this.#requireEmployee(input.employeeId)
    if (turn === undefined || turn.workspaceId !== input.workspaceId || turn.worldId !== input.worldId ||
      turn.sessionId !== input.sessionId || employee.workspaceId !== input.workspaceId || employee.worldId !== input.worldId) {
      throw new PersistenceError('Agent run scope does not match turn or employee')
    }
    if (!Number.isInteger(input.ordinal) || input.ordinal < 1) throw new PersistenceError('Agent run ordinal is invalid')
    const run: AgentRun = {
      id: this.#idFactory(), workspaceId: input.workspaceId, worldId: input.worldId,
      turnId: input.turnId, sessionId: input.sessionId, employeeId: input.employeeId,
      ordinal: input.ordinal, status: 'queued', createdAt: this.#clock(),
    }
    this.database.prepare(
      `INSERT INTO agent_runs
       (id, workspace_id, world_id, turn_id, session_id, employee_id, ordinal, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(run.id, run.workspaceId, run.worldId, run.turnId, run.sessionId, run.employeeId,
      run.ordinal, run.status, run.createdAt)
    return run
  }

  getAgentRun(runId: string): AgentRun | undefined {
    const row = this.database.prepare('SELECT * FROM agent_runs WHERE id = ?').get(runId)
    return row === undefined ? undefined : mapAgentRun(row)
  }

  listTurnAgentRuns(turnId: string): AgentRun[] {
    if (this.getWorkTurn(turnId) === undefined) throw new EntityNotFoundError(`Work turn not found: ${turnId}`)
    return this.database.prepare('SELECT * FROM agent_runs WHERE turn_id = ? ORDER BY ordinal').all(turnId).map(mapAgentRun)
  }

  listWorldAgentRuns(worldId: string): AgentRun[] {
    this.#requireWorld(worldId)
    return this.database
      .prepare('SELECT * FROM agent_runs WHERE world_id = ? ORDER BY created_at DESC, id DESC')
      .all(worldId)
      .map(mapAgentRun)
  }

  startAgentRun(runId: string): AgentRun {
    return this.#transitionAgentRun(runId, ['queued'], 'running')
  }

  completeAgentRun(runId: string, runtimeSessionId?: string): AgentRun {
    return this.#transitionAgentRun(runId, ['running'], 'completed', undefined, runtimeSessionId)
  }

  commitAgentRunCompletion(input: CommitAgentRunCompletionInput): {
    run: AgentRun
    messages: WorkMessage[]
    completionJob?: CompletionJob
  } {
    this.#assertWritable()
    return this.#transaction(() => {
      const completionJob = input.completionJob === undefined
        ? undefined
        : this.#completionJobs.create(input.completionJob)
      const messages = input.messages.map((message, index) => this.#appendMessage(
        completionJob !== undefined && index === input.messages.length - 1
          ? { ...message, metadata: { ...(message.metadata ?? {}), completionJobId: completionJob.id } }
          : message,
      ))
      const run = this.#transitionAgentRun(input.runId, ['running'], 'completed', undefined, input.runtimeSessionId)
      return { run, messages, ...(completionJob === undefined ? {} : { completionJob }) }
    })
  }

  getCompletionJob(jobId: string): CompletionJob | undefined {
    return this.#completionJobs.get(jobId)
  }

  listCompletionJobs(worldId: string, status?: CompletionJob['status']): CompletionJob[] {
    this.#requireWorld(worldId)
    return this.#completionJobs.list(worldId, status)
  }

  claimCompletionJob(owner: string, leaseDurationMs: number): CompletionJob | undefined {
    this.#assertWritable()
    return this.#completionJobs.claim(owner, leaseDurationMs)
  }

  renewCompletionJob(jobId: string, owner: string, leaseDurationMs: number): CompletionJob {
    this.#assertWritable()
    return this.#completionJobs.renew(jobId, owner, leaseDurationMs)
  }

  completeCompletionJob(
    jobId: string,
    owner: string,
    contribution: { artifactRefs?: string[]; messageMetadata?: JsonObject },
  ): CompletionJob {
    this.#assertWritable()
    return this.#transaction(() => {
      const job = this.#completionJobs.get(jobId)
      if (job === undefined) throw new EntityNotFoundError(`Completion job not found: ${jobId}`)
      this.#mergeCompletionMessageMetadata(job.agentRunId, {
        ...(contribution.messageMetadata ?? {}),
        ...(contribution.artifactRefs === undefined ? {} : { artifactRefs: uniqueStrings(contribution.artifactRefs) }),
        completionStatus: 'completed',
      })
      return this.#completionJobs.complete(jobId, owner)
    })
  }

  retryCompletionJob(jobId: string, owner: string, errorCode: string, availableAt: string): CompletionJob {
    this.#assertWritable()
    return this.#transaction(() => {
      const job = this.#completionJobs.get(jobId)
      if (job === undefined) throw new EntityNotFoundError(`Completion job not found: ${jobId}`)
      this.#mergeCompletionMessageMetadata(job.agentRunId, { completionStatus: 'retrying' })
      return this.#completionJobs.retry(jobId, owner, errorCode, availableAt)
    })
  }

  failCompletionJob(jobId: string, owner: string, errorCode: string): CompletionJob {
    this.#assertWritable()
    return this.#transaction(() => {
      const job = this.#completionJobs.get(jobId)
      if (job === undefined) throw new EntityNotFoundError(`Completion job not found: ${jobId}`)
      this.#mergeCompletionMessageMetadata(job.agentRunId, {
        completionStatus: 'failed',
        completionErrorCode: errorCode,
      })
      return this.#completionJobs.fail(jobId, owner, errorCode)
    })
  }

  requeueCompletionJob(jobId: string): CompletionJob {
    this.#assertWritable()
    const job = this.#completionJobs.get(jobId)
    if (job === undefined || job.status !== 'failed') throw new PersistenceError('Only a failed completion job can be retried')
    const now = this.#clock()
    this.database.prepare(
      `UPDATE completion_jobs
       SET status = 'retrying', available_at = ?, lease_owner = NULL,
           lease_expires_at = NULL, last_error_code = NULL, updated_at = ?
       WHERE id = ? AND status = 'failed'`,
    ).run(now, now, jobId)
    this.#mergeCompletionMessageMetadata(job.agentRunId, { completionStatus: 'retrying' })
    return this.#completionJobs.get(jobId)!
  }

  recoverCompletionJobsAfterRestart(): number {
    this.#assertWritable()
    return this.#completionJobs.recoverExpired()
  }

  failAgentRun(runId: string, errorCode: string, runtimeSessionId?: string): AgentRun {
    const run = this.#transitionAgentRun(runId, ['running'], 'failed', errorCode, runtimeSessionId)
    this.#markRunOutputUnfinished(runId)
    return run
  }

  interruptAgentRun(runId: string, errorCode = 'interrupted'): AgentRun {
    const run = this.#transitionAgentRun(runId, ['queued', 'running'], 'interrupted', errorCode)
    this.#markRunOutputUnfinished(runId)
    return run
  }

  /**
   * Marks whatever a failed run had already streamed as unfinished.
   *
   * The partial text stays in the transcript, because the user watched it
   * arrive and the provider's own session already carries it forward. What it
   * must not do is come back as recovered history: replaying it into a fresh
   * runtime session would present a half-written answer as something the
   * character actually said.
   */
  #markRunOutputUnfinished(runId: string): void {
    this.database
      .prepare(
        `UPDATE messages
         SET metadata_json = json_set(metadata_json, '$.failed', json('true'))
         WHERE kind = 'assistant' AND json_extract(metadata_json, '$.agentRunId') = ?`,
      )
      .run(runId)
  }

  recoverConversationRuntimeAfterRestart(): ConversationRuntimeRecoveryReport {
    this.#assertWritable()
    const now = this.#clock()
    return this.#transaction(() => {
      this.database.prepare(
        `UPDATE messages
         SET metadata_json = json_set(metadata_json, '$.failed', json('true'))
         WHERE kind = 'assistant' AND json_extract(metadata_json, '$.agentRunId') IN (
           SELECT agent_runs.id FROM agent_runs
           INNER JOIN work_turns ON work_turns.id = agent_runs.turn_id
           WHERE agent_runs.status IN ('queued', 'running') AND work_turns.status = 'running'
         )`,
      ).run()
      const runs = this.database.prepare(
        `UPDATE agent_runs SET status = 'failed', error_code = 'service-restarted', completed_at = ?
         WHERE status IN ('queued', 'running')
           AND turn_id IN (SELECT id FROM work_turns WHERE status = 'running')`,
      ).run(now)
      const turns = this.database.prepare(
        `UPDATE work_turns SET status = 'interrupted', error_code = 'service-restarted', completed_at = ?
         WHERE status = 'running'`,
      ).run(now)
      this.database.prepare(
        `UPDATE conversation_queue_entries
         SET status = 'interrupted', error_code = 'service-restarted', revision = revision + 1,
             lease_owner = NULL, lease_expires_at = NULL, completed_at = ?, updated_at = ?
         WHERE status IN ('running', 'waiting-approval')
           AND work_turn_id IN (
             SELECT id FROM work_turns WHERE status = 'interrupted' AND error_code = 'service-restarted'
           )`,
      ).run(now, now)
      this.database.prepare(
        `UPDATE conversation_queue_entries
         SET status = 'waiting-approval', revision = revision + 1,
             lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE status = 'running'
           AND work_turn_id IN (SELECT id FROM work_turns WHERE status = 'waiting-approval')`,
      ).run(now)
      this.database.prepare(
        `UPDATE conversation_queue_entries
         SET status = 'completed', revision = revision + 1,
             lease_owner = NULL, lease_expires_at = NULL,
             completed_at = COALESCE(completed_at, ?), updated_at = ?
         WHERE status IN ('running', 'waiting-approval')
           AND work_turn_id IN (SELECT id FROM work_turns WHERE status = 'completed')`,
      ).run(now, now)
      this.database.prepare(
        `UPDATE conversation_queue_entries
         SET status = 'failed',
             error_code = COALESCE((SELECT error_code FROM work_turns WHERE work_turns.id = conversation_queue_entries.work_turn_id), 'turn-failed'),
             revision = revision + 1,
             lease_owner = NULL, lease_expires_at = NULL,
             completed_at = COALESCE(completed_at, ?), updated_at = ?
         WHERE status IN ('running', 'waiting-approval')
           AND work_turn_id IN (SELECT id FROM work_turns WHERE status = 'failed')`,
      ).run(now, now)
      this.#recoverTaskCollaborationPlansAfterRestart(now)
      return { turnsFailed: Number(turns.changes), runsFailed: Number(runs.changes) }
    })
  }

  reserveSkillAction(action: CharacterSkillAction, duplicateWindowMs: number): { action: CharacterSkillAction; created: boolean } {
    this.#assertWritable()
    if (!Number.isSafeInteger(duplicateWindowMs) || duplicateWindowMs < 0) throw new PersistenceError('Skill duplicate window is invalid')
    const world = this.#requireWorld(action.worldId)
    const employee = this.#requireEmployee(action.characterId)
    if (employee.worldId !== world.id || employee.workspaceId !== world.workspaceId) throw new PersistenceError('Skill action scope is invalid')
    return this.#transaction(() => {
      const existingId = this.getSkillAction(action.id)
      if (existingId !== undefined) return { action: existingId, created: false }
      const cutoff = new Date(Date.parse(action.createdAt) - duplicateWindowMs).toISOString()
      const duplicate = this.database.prepare(
        `SELECT * FROM skill_actions
         WHERE world_id = ? AND character_id = ? AND skill_id = ? AND adapter_id = ?
           AND action = ? AND target = ? AND scheduled_for IS ? AND work_turn_id IS ? AND created_at > ?
         ORDER BY created_at DESC LIMIT 1`,
      ).get(action.worldId, action.characterId, action.skillId, action.adapterId, action.action,
        action.target, action.scheduledFor ?? null, action.workTurnId ?? null, cutoff)
      if (duplicate !== undefined) return { action: mapSkillAction(duplicate), created: false }
      this.database.prepare(
        `INSERT INTO skill_actions
         (id, workspace_id, world_id, character_id, skill_id, adapter_id, action, target, label,
          risk, authorization, parameters_json, scheduled_for, approval_request_id, work_turn_id,
          agent_run_id, execution_state, execution_attempt_id, execution_started_at,
          execution_completed_at, status, detail, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(action.id, world.workspaceId, action.worldId, action.characterId, action.skillId,
        action.adapterId, action.action, action.target, action.label, action.risk, action.authorization,
        stringifyJson(action.parameters), action.scheduledFor ?? null, action.approvalRequestId ?? null,
        action.workTurnId ?? null, action.agentRunId ?? null, action.executionState ?? null,
        action.executionAttemptId ?? null, action.executionStartedAt ?? null,
        action.executionCompletedAt ?? null, action.status, action.detail,
        action.createdAt, action.updatedAt)
      this.database.prepare(
        'UPDATE skill_actions SET authorization_source = ?, required_world_permission = ? WHERE id = ?',
      ).run(action.authorizationSource ?? null, action.requiredWorldPermission ?? null, action.id)
      return { action: structuredClone(action), created: true }
    })
  }

  saveSkillAction(action: CharacterSkillAction): void {
    this.#assertWritable()
    const result = this.database.prepare(
      `UPDATE skill_actions SET status = ?, detail = ?, authorization = ?, approval_request_id = ?, work_turn_id = ?,
       agent_run_id = ?, execution_state = ?, execution_attempt_id = ?, execution_started_at = ?,
       execution_completed_at = ?, updated_at = ? WHERE id = ?`,
    ).run(action.status, action.detail, action.authorization, action.approvalRequestId ?? null, action.workTurnId ?? null,
      action.agentRunId ?? null, action.executionState ?? null, action.executionAttemptId ?? null,
      action.executionStartedAt ?? null, action.executionCompletedAt ?? null, action.updatedAt, action.id)
    this.database.prepare(
      'UPDATE skill_actions SET authorization_source = ?, required_world_permission = ? WHERE id = ?',
    ).run(action.authorizationSource ?? null, action.requiredWorldPermission ?? null, action.id)
    if (Number(result.changes) !== 1) throw new EntityNotFoundError(`Skill action not found: ${action.id}`)
  }

  getSkillAction(actionId: string): CharacterSkillAction | undefined {
    const row = this.database.prepare('SELECT * FROM skill_actions WHERE id = ?').get(actionId)
    return row === undefined ? undefined : mapSkillAction(row)
  }

  listWorldSkillActions(worldId: string): CharacterSkillAction[] {
    this.#requireWorld(worldId)
    return this.database.prepare(
      'SELECT * FROM skill_actions WHERE world_id = ? ORDER BY created_at DESC, id DESC',
    ).all(worldId).map(mapSkillAction)
  }

  listDueSkillActions(now: Date): CharacterSkillAction[] {
    return this.database.prepare(
      `SELECT * FROM skill_actions WHERE status = 'scheduled' AND scheduled_for <= ? ORDER BY scheduled_for, id`,
    ).all(now.toISOString()).map(mapSkillAction)
  }

  listSkillActionsWaitingForApproval(): CharacterSkillAction[] {
    return this.database.prepare(
      `SELECT * FROM skill_actions WHERE status = 'waiting-for-approval' ORDER BY created_at, id`,
    ).all().map(mapSkillAction)
  }

  listSkillActionsReadyForExecution(): CharacterSkillAction[] {
    return this.database.prepare(
      `SELECT * FROM skill_actions WHERE execution_state = 'approved-ready' ORDER BY updated_at, id`,
    ).all().map(mapSkillAction)
  }

  prepareSkillActionExecution(actionId: string, now = this.#clock()): CharacterSkillAction {
    this.#assertWritable()
    const result = this.database.prepare(
      `UPDATE skill_actions SET execution_state = 'approved-ready', execution_attempt_id = NULL,
       execution_started_at = NULL, execution_completed_at = NULL, updated_at = ?
       WHERE id = ? AND (execution_state IS NULL OR execution_state = 'approved-ready')`,
    ).run(now, actionId)
    if (Number(result.changes) !== 1) throw new PersistenceError('Skill action cannot be prepared for execution')
    return this.getSkillAction(actionId)!
  }

  claimSkillActionExecution(actionId: string, attemptId: string, now = this.#clock()): CharacterSkillAction | undefined {
    this.#assertWritable()
    if (!attemptId.trim()) throw new PersistenceError('Skill action execution attempt is required')
    const result = this.database.prepare(
      `UPDATE skill_actions SET execution_state = 'executing', execution_attempt_id = ?,
       execution_started_at = ?, execution_completed_at = NULL, status = 'waiting-for-integration', updated_at = ?
       WHERE id = ? AND execution_state = 'approved-ready'`,
    ).run(attemptId, now, now, actionId)
    return Number(result.changes) === 1 ? this.getSkillAction(actionId)! : undefined
  }

  reconcileApprovedSkillActions(now = this.#clock()): number {
    this.#assertWritable()
    return Number(this.database.prepare(
      `UPDATE skill_actions SET execution_state = 'approved-ready', status = 'waiting-for-integration',
       detail = '审批已通过，等待安全继续原工作回合', updated_at = ?
       WHERE status = 'waiting-for-approval' AND execution_state IS NULL
         AND approval_request_id IN (SELECT id FROM approval_requests WHERE status = 'approved')`,
    ).run(now).changes)
  }

  createApprovalRequest(input: CreateApprovalRequestInput): ApprovalRequest {
    this.#assertWritable()
    const world = this.#requireWorld(input.worldId)
    if (world.workspaceId !== input.workspaceId) throw new PersistenceError('Approval workspace does not match world')
    if (input.characterId !== undefined) {
      const employee = this.#requireEmployee(input.characterId)
      if (employee.worldId !== world.id) throw new PersistenceError('Approval character does not match world')
    }
    if (input.sessionId !== undefined) {
      const session = this.getSession(input.sessionId)
      if (session === undefined || session.worldId !== world.id) throw new PersistenceError('Approval session does not match world')
    }
    if (input.workTurnId !== undefined) {
      const turn = this.getWorkTurn(input.workTurnId)
      if (turn === undefined || turn.worldId !== world.id || (input.sessionId !== undefined && turn.sessionId !== input.sessionId)) {
        throw new PersistenceError('Approval turn does not match scope')
      }
    }
    if (input.agentRunId !== undefined) {
      const run = this.getAgentRun(input.agentRunId)
      if (run === undefined || run.worldId !== world.id || (input.workTurnId !== undefined && run.turnId !== input.workTurnId)) {
        throw new PersistenceError('Approval run does not match scope')
      }
    }
    const existing = this.getApprovalRequestBySubject(input.subjectType, input.subjectId)
    if (existing !== undefined) {
      if (existing.workspaceId !== input.workspaceId || existing.worldId !== input.worldId
        || existing.sessionId !== input.sessionId || existing.workTurnId !== input.workTurnId
        || existing.agentRunId !== input.agentRunId || existing.characterId !== input.characterId
        || existing.risk !== input.risk) {
        throw new PersistenceError('Approval subject is already bound to another scope')
      }
      return existing
    }
    const createdAt = input.createdAt ?? this.#clock()
    if (!Number.isFinite(Date.parse(createdAt))) throw new PersistenceError('Approval creation time is invalid')
    if (!Number.isFinite(Date.parse(input.expiresAt)) || Date.parse(input.expiresAt) <= Date.parse(createdAt)) {
      throw new PersistenceError('Approval expiry is invalid')
    }
    const request: ApprovalRequest = {
      id: this.#idFactory(), workspaceId: input.workspaceId, worldId: input.worldId,
      subjectType: input.subjectType, subjectId: input.subjectId, risk: input.risk,
      summary: input.summary.trim(), status: 'pending', scope: 'once', createdAt, expiresAt: input.expiresAt,
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      ...(input.workTurnId === undefined ? {} : { workTurnId: input.workTurnId }),
      ...(input.agentRunId === undefined ? {} : { agentRunId: input.agentRunId }),
      ...(input.characterId === undefined ? {} : { characterId: input.characterId }),
    }
    if (!request.summary) throw new PersistenceError('Approval summary cannot be empty')
    this.database.prepare(
      `INSERT INTO approval_requests
       (id, workspace_id, world_id, session_id, work_turn_id, agent_run_id, character_id,
        subject_type, subject_id, risk, summary, status, scope, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(request.id, request.workspaceId, request.worldId, request.sessionId ?? null,
      request.workTurnId ?? null, request.agentRunId ?? null, request.characterId ?? null,
      request.subjectType, request.subjectId, request.risk, request.summary, request.status,
      request.scope, request.createdAt, request.expiresAt)
    return request
  }

  getApprovalRequest(approvalId: string): ApprovalRequest | undefined {
    const row = this.database.prepare('SELECT * FROM approval_requests WHERE id = ?').get(approvalId)
    return row === undefined ? undefined : mapApprovalRequest(row)
  }

  getApprovalRequestBySubject(subjectType: ApprovalSubjectType, subjectId: string): ApprovalRequest | undefined {
    const row = this.database.prepare(
      'SELECT * FROM approval_requests WHERE subject_type = ? AND subject_id = ?',
    ).get(subjectType, subjectId)
    return row === undefined ? undefined : mapApprovalRequest(row)
  }

  listWorldApprovalRequests(worldId: string, status?: ApprovalStatus): ApprovalRequest[] {
    this.#requireWorld(worldId)
    const rows = status === undefined
      ? this.database.prepare('SELECT * FROM approval_requests WHERE world_id = ? ORDER BY created_at DESC, id DESC').all(worldId)
      : this.database.prepare('SELECT * FROM approval_requests WHERE world_id = ? AND status = ? ORDER BY created_at DESC, id DESC').all(worldId, status)
    return rows.map(mapApprovalRequest)
  }

  decideApprovalRequest(approvalId: string, decision: 'approved' | 'rejected', scope: ApprovalScope, actorId: string, now = this.#clock()): ApprovalRequest {
    this.#assertWritable()
    if (!['once', 'character', 'world'].includes(scope)) throw new PersistenceError('Approval scope is invalid')
    if (!actorId.trim()) throw new PersistenceError('Approval actor is required')
    return this.#transaction(() => {
      const request = this.getApprovalRequest(approvalId)
      if (request === undefined) throw new EntityNotFoundError(`Approval request not found: ${approvalId}`)
      if (request.status !== 'pending') throw new PersistenceError(`Approval request is already ${request.status}`)
      if (Date.parse(request.expiresAt) <= Date.parse(now)) {
        this.database.prepare(
          `UPDATE approval_requests SET status = 'expired', decided_at = ?, decided_by = ? WHERE id = ? AND status = 'pending'`,
        ).run(now, 'system', approvalId)
        return this.getApprovalRequest(approvalId)!
      }
      this.database.prepare(
        `UPDATE approval_requests SET status = ?, scope = ?, decided_at = ?, decided_by = ?
         WHERE id = ? AND status = 'pending'`,
      ).run(decision, decision === 'rejected' ? 'once' : scope, now, actorId, approvalId)
      if (this.getApprovalRequest(approvalId)?.status !== decision) throw new PersistenceError('Approval decision lost a concurrent race')
      return this.getApprovalRequest(approvalId)!
    })
  }

  expirePendingApprovals(now = this.#clock()): number {
    this.#assertWritable()
    return Number(this.database.prepare(
      `UPDATE approval_requests SET status = 'expired', decided_at = ?, decided_by = 'system'
       WHERE status = 'pending' AND expires_at <= ?`,
    ).run(now, now).changes)
  }

  createApprovalPolicy(input: CreateApprovalPolicyInput): ApprovalPolicy {
    this.#assertWritable()
    const approval = this.getApprovalRequest(input.sourceApprovalId)
    if (approval === undefined || approval.status !== 'approved') throw new PersistenceError('Approval policy requires an approved request')
    if (approval.workspaceId !== input.workspaceId || approval.worldId !== input.worldId
      || approval.subjectType !== input.subjectType || approval.risk !== input.risk || approval.scope !== input.scope) {
      throw new PersistenceError('Approval policy does not match its source approval')
    }
    if (input.scope === 'character' && !input.characterId) throw new PersistenceError('Character approval policy requires a character')
    if (input.scope === 'character' && approval.characterId !== input.characterId) throw new PersistenceError('Approval policy character does not match')
    if (input.subjectType === 'skill-action') {
      const action = this.getSkillAction(approval.subjectId)
      if (action === undefined || action.worldId !== input.worldId || action.characterId !== approval.characterId
        || action.skillId !== input.skillId || action.action !== input.action || action.target !== input.target || action.risk !== input.risk) {
        throw new PersistenceError('Approval policy must exactly match the approved skill action')
      }
    }
    const policy: ApprovalPolicy = {
      id: this.#idFactory(), workspaceId: input.workspaceId, worldId: input.worldId,
      subjectType: input.subjectType, action: input.action.trim(), target: input.target.trim(),
      risk: input.risk, scope: input.scope, sourceApprovalId: input.sourceApprovalId,
      createdAt: this.#clock(),
      ...(input.characterId === undefined ? {} : { characterId: input.characterId }),
      ...(input.skillId === undefined ? {} : { skillId: input.skillId }),
    }
    if (!policy.action || !policy.target) throw new PersistenceError('Approval policy action and target are required')
    this.database.prepare(
      `INSERT INTO approval_policies
       (id, workspace_id, world_id, character_id, subject_type, skill_id, action, target, risk,
        scope, source_approval_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(policy.id, policy.workspaceId, policy.worldId, policy.characterId ?? null,
      policy.subjectType, policy.skillId ?? null, policy.action, policy.target, policy.risk,
      policy.scope, policy.sourceApprovalId, policy.createdAt)
    return policy
  }

  findApprovalPolicy(input: Omit<CreateApprovalPolicyInput, 'scope' | 'sourceApprovalId'>): ApprovalPolicy | undefined {
    const world = this.#requireWorld(input.worldId)
    if (world.workspaceId !== input.workspaceId) throw new PersistenceError('Approval policy workspace does not match world')
    const row = this.database.prepare(
      `SELECT * FROM approval_policies
       WHERE world_id = ? AND subject_type = ? AND skill_id IS ? AND action = ? AND target = ?
         AND risk = ? AND revoked_at IS NULL
         AND ((scope = 'character' AND character_id = ?) OR scope = 'world')
       ORDER BY CASE scope WHEN 'character' THEN 0 ELSE 1 END, created_at DESC LIMIT 1`,
    ).get(input.worldId, input.subjectType, input.skillId ?? null, input.action, input.target,
      input.risk, input.characterId ?? null)
    return row === undefined ? undefined : mapApprovalPolicy(row)
  }

  listWorldApprovalPolicies(worldId: string): ApprovalPolicy[] {
    this.#requireWorld(worldId)
    return this.database.prepare(
      'SELECT * FROM approval_policies WHERE world_id = ? ORDER BY created_at DESC, id DESC',
    ).all(worldId).map(mapApprovalPolicy)
  }

  getApprovalPolicy(policyId: string): ApprovalPolicy | undefined {
    const row = this.database.prepare('SELECT * FROM approval_policies WHERE id = ?').get(policyId)
    return row === undefined ? undefined : mapApprovalPolicy(row)
  }

  revokeApprovalPolicy(policyId: string, now = this.#clock()): ApprovalPolicy {
    this.#assertWritable()
    const result = this.database.prepare(
      'UPDATE approval_policies SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL',
    ).run(now, policyId)
    if (Number(result.changes) !== 1) throw new PersistenceError('Approval policy is unavailable')
    const row = this.database.prepare('SELECT * FROM approval_policies WHERE id = ?').get(policyId)
    return mapApprovalPolicy(row!)
  }

  recoverSkillActionsAfterRestart(now = this.#clock()): number {
    this.#assertWritable()
    return Number(this.database.prepare(
      `UPDATE skill_actions SET status = 'outcome-unknown', execution_state = 'settled',
       execution_completed_at = ?,
       detail = '应用在外部动作执行期间中断，结果未知；不得自动重试', updated_at = ?
       WHERE status = 'waiting-for-integration'
         AND (execution_state = 'executing' OR execution_state IS NULL)`,
    ).run(now, now).changes)
  }

  listParticipants(sessionId: string): WorkSessionParticipant[] {
    return this.database
      .prepare('SELECT * FROM work_session_participants WHERE session_id = ? ORDER BY joined_at, participant_id')
      .all(sessionId)
      .map(mapParticipant)
  }

  saveOwnerRuntimeAccessGrant(input: {
    id: string
    worldId: string
    sessionId: string
    employeeIds: string[]
  }): OwnerRuntimeAccessGrant {
    this.#assertWritable()
    this.#requireWorld(input.worldId)
    const session = this.#requireSession(input.sessionId)
    if (session.worldId !== input.worldId) throw new PersistenceError('Runtime access grant session belongs to another world')
    const employeeIds = [...new Set(input.employeeIds.map((value) => value.trim()).filter(Boolean))]
    if (employeeIds.length === 0) throw new PersistenceError('Runtime access grant requires at least one employee')
    const now = this.#clock()
    const current = this.getOwnerRuntimeAccessGrantForSession(input.worldId, input.sessionId)
    this.database.prepare(
      `INSERT INTO owner_runtime_access_grants (
        id, world_id, session_id, employee_ids_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(world_id, session_id) DO UPDATE SET
        id = excluded.id,
        employee_ids_json = excluded.employee_ids_json,
        updated_at = excluded.updated_at`,
    ).run(input.id, input.worldId, input.sessionId, JSON.stringify(employeeIds), current?.createdAt ?? now, now)
    return this.getOwnerRuntimeAccessGrant(input.id)!
  }

  getOwnerRuntimeAccessGrant(id: string): OwnerRuntimeAccessGrant | undefined {
    const row = this.database.prepare('SELECT * FROM owner_runtime_access_grants WHERE id = ?').get(id)
    return row === undefined ? undefined : mapOwnerRuntimeAccessGrant(row)
  }

  getOwnerRuntimeAccessGrantForSession(worldId: string, sessionId: string): OwnerRuntimeAccessGrant | undefined {
    const row = this.database
      .prepare('SELECT * FROM owner_runtime_access_grants WHERE world_id = ? AND session_id = ?')
      .get(worldId, sessionId)
    return row === undefined ? undefined : mapOwnerRuntimeAccessGrant(row)
  }

  listOwnerRuntimeAccessGrants(worldId: string): OwnerRuntimeAccessGrant[] {
    return this.database
      .prepare('SELECT * FROM owner_runtime_access_grants WHERE world_id = ? ORDER BY updated_at DESC, id')
      .all(worldId)
      .map(mapOwnerRuntimeAccessGrant)
  }

  deleteOwnerRuntimeAccessGrant(id: string): boolean {
    this.#assertWritable()
    return this.database.prepare('DELETE FROM owner_runtime_access_grants WHERE id = ?').run(id).changes > 0
  }

  appendMessage(input: AppendMessageInput): WorkMessage {
    this.#assertWritable()
    return this.#transaction(() => this.#appendMessage(input))
  }

  listMessages(sessionId: string, afterSequence = 0): WorkMessage[] {
    return this.database
      .prepare(
        'SELECT * FROM messages WHERE session_id = ? AND sequence > ? ORDER BY sequence',
      )
      .all(sessionId, afterSequence)
      .map(mapMessage)
  }

  /**
   * Relocates durable messages by id, across sessions.
   *
   * A memory index entry keeps the ids of the messages it was derived from, so
   * a retrieved memory can bring back what was actually said instead of only a
   * rendered summary. That read is by id, not by conversation, which is why it
   * cannot go through `listMessages`. It is deliberately batched and capped: a
   * hydration path must never turn one retrieval into an unbounded scan.
   *
   * This is a pure relocation. It applies no scope rule of its own, so every
   * caller has to decide for itself whether the conversation it is composing
   * is allowed to see the message it just read back.
   */
  getMessages(ids: readonly string[]): WorkMessage[] {
    const wanted = [...new Set(ids.map((value) => value.trim()).filter(Boolean))].slice(0, MAX_MESSAGE_ID_LOOKUP)
    if (wanted.length === 0) return []
    return this.database
      .prepare(
        `SELECT * FROM messages WHERE id IN (${wanted.map(() => '?').join(', ')})
         ORDER BY session_id, sequence`,
      )
      .all(...wanted)
      .map(mapMessage)
  }

  listWorldTraceMessages(worldId: string): WorkMessage[] {
    this.#requireWorld(worldId)
    return this.database
      .prepare(
        `SELECT messages.* FROM messages
         INNER JOIN work_sessions ON work_sessions.id = messages.session_id
         WHERE work_sessions.world_id = ?
           AND messages.kind IN ('reasoning', 'tool-call', 'tool-result')
         ORDER BY messages.created_at, messages.id`,
      )
      .all(worldId)
      .map(mapMessage)
  }

  listMessagesPage(sessionId: string, input: ListMessagesPageInput = {}): MessagePage {
    this.#requireSession(sessionId)
    const pageSize = clampMessagePageSize(input.limit)
    const search = input.search?.trim()
    const date = input.date?.trim()
    const chatOnly = input.chatOnly === true
    const filters: string[] = ['session_id = ?']
    const parameters: Array<string | number> = [sessionId]

    if (chatOnly) filters.push("kind IN ('user', 'assistant', 'system')")
    if (search !== undefined && search.length > 0) {
      filters.push("content LIKE ? ESCAPE '\\' COLLATE NOCASE")
      parameters.push(`%${escapeMessageSearch(search)}%`)
    }
    if (date !== undefined && date.length > 0) {
      filters.push('substr(created_at, 1, 10) = ?')
      parameters.push(date)
    }
    const where = filters.join(' AND ')
    const countRow = this.database.prepare(`SELECT COUNT(*) AS count FROM messages WHERE ${where}`).get(...parameters) as { count: number }
    const total = Number(countRow.count)

    // Search/date history uses numbered pages. The sequence cursor path is used by
    // the chat surface so loading an older page never changes while new messages arrive.
    if ((search !== undefined && search.length > 0) || (date !== undefined && date.length > 0) || input.page !== undefined) {
      const page = Math.max(1, Math.floor(input.page ?? 1))
      const offset = (page - 1) * pageSize
      const rows = this.database
        .prepare(`SELECT * FROM messages WHERE ${where} ORDER BY sequence DESC LIMIT ? OFFSET ?`)
        .all(...parameters, pageSize, offset)
        .map(mapMessage)
        .reverse()
      return {
        items: rows,
        total,
        page,
        pageSize,
        hasMore: offset + rows.length < total,
      }
    }

    if (input.afterSequence !== undefined) {
      const after = Math.max(0, Math.floor(input.afterSequence))
      const afterWhere = `${where} AND sequence > ?`
      const rows = this.database
        .prepare(`SELECT * FROM messages WHERE ${afterWhere} ORDER BY sequence LIMIT ?`)
        .all(...parameters, after, pageSize)
        .map(mapMessage)
      const remaining = rows.length === 0
        ? 0
        : Number((this.database.prepare(`SELECT COUNT(*) AS count FROM messages WHERE ${afterWhere} AND sequence > ?`).get(...parameters, after, rows[rows.length - 1]!.sequence) as { count: number }).count)
      const hasMore = remaining > 0
      return {
        items: rows,
        total,
        page: 1,
        pageSize,
        hasMore,
        ...(hasMore ? { nextAfter: rows[rows.length - 1]!.sequence } : {}),
      }
    }

    const before = input.beforeSequence === undefined ? undefined : Math.max(1, Math.floor(input.beforeSequence))
    const cursorWhere = before === undefined ? where : `${where} AND sequence < ?`
    const cursorParameters = before === undefined ? parameters : [...parameters, before]
    const rows = this.database
      .prepare(`SELECT * FROM messages WHERE ${cursorWhere} ORDER BY sequence DESC LIMIT ?`)
      .all(...cursorParameters, pageSize)
      .map(mapMessage)
      .reverse()
    const remaining = rows.length === 0
      ? 0
      : Number((this.database.prepare(`SELECT COUNT(*) AS count FROM messages WHERE ${where} AND sequence < ?`).get(...parameters, rows[0]!.sequence) as { count: number }).count)
    const hasMore = remaining > 0
    return {
      items: rows,
      total,
      page: 1,
      pageSize,
      hasMore,
      ...(hasMore ? { nextBefore: rows[0]!.sequence } : {}),
    }
  }

  latestMessageBySender(sessionId: string, senderKind: WorkMessage['senderKind']): WorkMessage | undefined {
    const row = this.database
      .prepare(
        'SELECT * FROM messages WHERE session_id = ? AND sender_kind = ? ORDER BY sequence DESC LIMIT 1',
      )
      .get(sessionId, senderKind)
    return row === undefined ? undefined : mapMessage(row)
  }

  appendDomainEvent(input: AppendDomainEventInput): DomainEvent {
    this.#assertWritable()
    this.#requireWorkspace(input.workspaceId)
    if (input.worldId !== undefined) {
      const world = this.#requireWorld(input.worldId)
      if (world.workspaceId !== input.workspaceId) {
        throw new PersistenceError('Domain event world does not belong to workspace')
      }
    }
    return this.#transaction(() => this.#appendEvent(input))
  }

  listDomainEvents(workspaceId: string, afterSequence = 0): DomainEvent[] {
    return this.database
      .prepare(
        'SELECT * FROM domain_events WHERE workspace_id = ? AND sequence > ? ORDER BY sequence',
      )
      .all(workspaceId, afterSequence)
      .map(mapDomainEvent)
  }

  /**
   * Domain events a world trace can actually render.
   *
   * The trace discards every other type after loading it, which at a few
   * thousand turns means tens of thousands of rows read and thrown away on
   * every materialization. The exclusion list is asserted against the adapter
   * in packages/server/tests, so it cannot drift silently.
   */
  listWorldTraceDomainEvents(worldId: string, excludedTypes: readonly string[]): DomainEvent[] {
    this.#requireWorld(worldId)
    if (excludedTypes.length === 0) return this.listWorldDomainEvents(worldId)
    const placeholders = excludedTypes.map(() => '?').join(', ')
    return this.database
      .prepare(
        `SELECT * FROM domain_events WHERE world_id = ? AND type NOT IN (${placeholders}) ORDER BY sequence`,
      )
      .all(worldId, ...excludedTypes)
      .map(mapDomainEvent)
  }

  listWorldDomainEvents(worldId: string, afterSequence = 0): DomainEvent[] {
    return this.database
      .prepare(
        'SELECT * FROM domain_events WHERE world_id = ? AND sequence > ? ORDER BY sequence',
      )
      .all(worldId, afterSequence)
      .map(mapDomainEvent)
  }

  getActivePackage(workspaceId: string, packageId: string): InstalledPackage | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM installed_packages
         WHERE workspace_id = ? AND package_id = ? AND status = 'active'`,
      )
      .get(workspaceId, packageId)
    return row ? mapInstalledPackage(row) : undefined
  }

  listInstalledPackages(workspaceId: string): InstalledPackage[] {
    return this.database
      .prepare(
        `SELECT * FROM installed_packages
         WHERE workspace_id = ? ORDER BY package_id, installed_at DESC`,
      )
      .all(workspaceId)
      .map(mapInstalledPackage)
  }

  getInstalledPackage(workspaceId: string, packageId: string, version: string): InstalledPackage | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM installed_packages
         WHERE workspace_id = ? AND package_id = ? AND version = ?`,
      )
      .get(workspaceId, packageId, version)
    return row ? mapInstalledPackage(row) : undefined
  }

  disableInstalledPackage(workspaceId: string, packageId: string, version: string, actorId = 'owner'): InstalledPackage {
    this.#assertWritable()
    const current = this.getInstalledPackage(workspaceId, packageId, version)
    if (current === undefined) throw new EntityNotFoundError('Installed package not found')
    if (current.status === 'disabled') return current
    if (current.status !== 'active') throw new PersistenceError('Only the active package version can be uninstalled')
    const now = this.#clock()
    return this.#transaction(() => {
      const result = this.database.prepare(
        `UPDATE installed_packages SET status = 'disabled', updated_at = ?
         WHERE workspace_id = ? AND package_id = ? AND version = ? AND status = 'active'`,
      ).run(now, workspaceId, packageId, version)
      if (Number(result.changes) !== 1) throw new PersistenceError('Installed package changed concurrently')
      const disabled = { ...current, status: 'disabled' as const, updatedAt: now }
      this.#appendEvent({
        workspaceId,
        type: 'package.uninstalled',
        actorId,
        actorKind: actorId === 'system' ? 'system' : 'owner',
        correlationId: `${packageId}@${version}`,
        payload: { packageId, version },
      })
      return disabled
    })
  }

  getWorldPackageInstance(instanceId: string): WorldPackageInstance | undefined {
    const row = this.database
      .prepare('SELECT * FROM world_package_instances WHERE id = ?')
      .get(instanceId)
    return row ? mapWorldPackageInstance(row) : undefined
  }

  listWorldPackageInstances(worldId: string, status?: WorldPackageInstance['status']): WorldPackageInstance[] {
    const rows = status === undefined
      ? this.database.prepare(
          'SELECT * FROM world_package_instances WHERE world_id = ? ORDER BY created_at, id',
        ).all(worldId)
      : this.database.prepare(
          'SELECT * FROM world_package_instances WHERE world_id = ? AND status = ? ORDER BY created_at, id',
        ).all(worldId, status)
    return rows.map(mapWorldPackageInstance)
  }

  createWorldPackageInstance(input: CreateWorldPackageInstanceInput): WorldPackageInstance {
    this.#assertWritable()
    const world = this.#requireWorld(input.worldId)
    if (world.workspaceId !== input.workspaceId) {
      throw new PersistenceError('World package instance workspace does not match its world')
    }
    const installed = this.getInstalledPackage(input.workspaceId, input.packageId, input.packageVersion)
    if (installed === undefined || installed.kind !== input.packageKind) {
      throw new PersistenceError('World package instance source package is unavailable')
    }
    const digest = input.contentDigest.trim().toLowerCase()
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new PersistenceError('World package content digest is invalid')
    const originPath = assertManagedRelativePath(input.originPath, 'origin path')
    const overridesPath = assertManagedRelativePath(input.overridesPath, 'overrides path')
    const now = this.#clock()
    const instance: WorldPackageInstance = {
      id: input.id ?? this.#idFactory(), workspaceId: input.workspaceId, worldId: input.worldId,
      packageId: input.packageId, packageVersion: input.packageVersion, packageKind: input.packageKind,
      contentDigest: digest, status: 'active', originPath, overridesPath, createdAt: now, updatedAt: now,
    }
    return this.#transaction(() => {
      this.database.prepare(
        `INSERT INTO world_package_instances
         (id, workspace_id, world_id, package_id, package_version, package_kind,
          content_digest, status, origin_path, overrides_path, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
      ).run(
        instance.id, instance.workspaceId, instance.worldId, instance.packageId,
        instance.packageVersion, instance.packageKind, instance.contentDigest,
        instance.originPath, instance.overridesPath, instance.createdAt, instance.updatedAt,
      )
      this.#appendEvent({
        workspaceId: instance.workspaceId, worldId: instance.worldId,
        type: 'world.package.instantiated', actorId: input.actorId ?? 'owner', actorKind: 'owner',
        correlationId: instance.id,
        payload: { instanceId: instance.id, packageId: instance.packageId,
          packageVersion: instance.packageVersion, contentDigest: instance.contentDigest },
      })
      return instance
    })
  }

  disableWorldPackageInstance(instanceId: string, actorId = 'owner'): WorldPackageInstance {
    this.#assertWritable()
    const current = this.getWorldPackageInstance(instanceId)
    if (current === undefined) throw new EntityNotFoundError('World package instance not found')
    if (current.status === 'disabled') return current
    const now = this.#clock()
    return this.#transaction(() => {
      const result = this.database.prepare(
        `UPDATE world_package_instances SET status = 'disabled', updated_at = ?
         WHERE id = ? AND status = 'active'`,
      ).run(now, instanceId)
      if (Number(result.changes) !== 1) throw new PersistenceError('World package instance changed concurrently')
      this.#appendEvent({
        workspaceId: current.workspaceId, worldId: current.worldId,
        type: 'world.package.disabled', actorId, actorKind: 'owner', correlationId: current.id,
        payload: { instanceId: current.id, packageId: current.packageId,
          packageVersion: current.packageVersion },
      })
      return { ...current, status: 'disabled', updatedAt: now }
    })
  }

  getPackageInstallTransaction(transactionId: string): PackageInstallTransaction | undefined {
    const row = this.database
      .prepare('SELECT * FROM package_install_transactions WHERE id = ?')
      .get(transactionId)
    return row ? mapPackageInstallTransaction(row) : undefined
  }

  listPackageInstallTransactions(workspaceId: string): PackageInstallTransaction[] {
    return this.database
      .prepare(
        `SELECT * FROM package_install_transactions
         WHERE workspace_id = ? ORDER BY created_at DESC, id DESC`,
      )
      .all(workspaceId)
      .map(mapPackageInstallTransaction)
  }

  beginPackageInstall(input: BeginPackageInstallInput): PackageInstallTransaction {
    this.#assertWritable()
    this.#requireWorkspace(input.workspaceId)
    const previous = this.getActivePackage(input.workspaceId, input.manifest.id)
    const now = this.#clock()
    const transaction: PackageInstallTransaction = {
      id: this.#idFactory(),
      workspaceId: input.workspaceId,
      packageId: input.manifest.id,
      version: input.manifest.version,
      status: 'approved',
      approvedCapabilities: [...input.approvedCapabilities],
      createdAt: now,
      updatedAt: now,
      ...(previous === undefined ? {} : { previousVersion: previous.version }),
    }
    return this.#transaction(() => {
      this.database
        .prepare(
          `INSERT INTO package_install_transactions (
             id, workspace_id, package_id, version, status, previous_version,
             approved_capabilities_json, error_code, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        )
        .run(
          transaction.id,
          transaction.workspaceId,
          transaction.packageId,
          transaction.version,
          transaction.status,
          transaction.previousVersion ?? null,
          stringifyJson(transaction.approvedCapabilities),
          transaction.createdAt,
          transaction.updatedAt,
        )
      this.#appendEvent({
        workspaceId: transaction.workspaceId,
        type: 'package.install.approved',
        actorId: input.actorId ?? 'owner',
        actorKind: 'owner',
        correlationId: transaction.id,
        payload: {
          transactionId: transaction.id,
          packageId: transaction.packageId,
          version: transaction.version,
          kind: input.manifest.kind,
          capabilities: transaction.approvedCapabilities,
          dataEgress: input.manifest.dataEgress,
        },
      })
      return transaction
    })
  }

  markPackageInstallStaged(transactionId: string): PackageInstallTransaction {
    this.#assertWritable()
    const transaction = this.getPackageInstallTransaction(transactionId)
    if (transaction === undefined || transaction.status !== 'approved') {
      throw new PersistenceError('Package install transaction cannot enter staged state')
    }
    const now = this.#clock()
    return this.#transaction(() => {
      this.database
        .prepare(
          `UPDATE package_install_transactions
           SET status = 'staged', updated_at = ? WHERE id = ? AND status = 'approved'`,
        )
        .run(now, transaction.id)
      this.#appendEvent({
        workspaceId: transaction.workspaceId,
        type: 'package.install.staged',
        actorId: 'system',
        actorKind: 'system',
        correlationId: transaction.id,
        payload: {
          transactionId: transaction.id,
          packageId: transaction.packageId,
          version: transaction.version,
        },
      })
      return { ...transaction, status: 'staged', updatedAt: now }
    })
  }

  completePackageInstall(input: CompletePackageInstallInput): InstalledPackage {
    this.#assertWritable()
    const transaction = this.getPackageInstallTransaction(input.transactionId)
    if (
      transaction === undefined ||
      transaction.status !== 'staged' ||
      transaction.packageId !== input.manifest.id ||
      transaction.version !== input.manifest.version
    ) {
      throw new PersistenceError('Package install transaction cannot be activated')
    }
    const existingRow = this.database.prepare(
      `SELECT * FROM installed_packages
       WHERE workspace_id = ? AND package_id = ? AND version = ?`,
    ).get(transaction.workspaceId, input.manifest.id, input.manifest.version)
    const existing = existingRow === undefined ? undefined : mapInstalledPackage(existingRow)
    if (
      existing !== undefined
      && stableJson(existing.manifest as unknown as JsonValue) !== stableJson(input.manifest as unknown as JsonValue)
    ) {
      throw new PersistenceError('package_version_content_conflict')
    }
    const now = this.#clock()
    const installed: InstalledPackage = {
      workspaceId: transaction.workspaceId,
      packageId: input.manifest.id,
      version: input.manifest.version,
      kind: input.manifest.kind,
      status: 'active',
      installedPath: existing?.installedPath ?? resolve(input.installedPath),
      capabilities: [...transaction.approvedCapabilities],
      manifest: input.manifest,
      installedAt: existing?.installedAt ?? now,
      updatedAt: now,
    }
    return this.#transaction(() => {
      this.database
        .prepare(
          `UPDATE installed_packages SET status = 'superseded', updated_at = ?
           WHERE workspace_id = ? AND package_id = ? AND status = 'active'`,
        )
        .run(now, installed.workspaceId, installed.packageId)
      this.database
        .prepare(
          `INSERT INTO installed_packages (
             workspace_id, package_id, version, kind, status, installed_path,
             capabilities_json, manifest_json, installed_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (workspace_id, package_id, version) DO UPDATE SET
             kind = excluded.kind,
             status = excluded.status,
             installed_path = excluded.installed_path,
             capabilities_json = excluded.capabilities_json,
             manifest_json = excluded.manifest_json,
             updated_at = excluded.updated_at`,
        )
        .run(
          installed.workspaceId,
          installed.packageId,
          installed.version,
          installed.kind,
          installed.status,
          installed.installedPath,
          stringifyJson(installed.capabilities),
          stringifyJson(installed.manifest as unknown as JsonValue),
          installed.installedAt,
          installed.updatedAt,
        )
      this.database
        .prepare(
          `UPDATE package_install_transactions
           SET status = 'activated', updated_at = ? WHERE id = ? AND status = 'staged'`,
        )
        .run(now, transaction.id)
      this.#appendEvent({
        workspaceId: installed.workspaceId,
        type: 'package.install.activated',
        actorId: input.actorId ?? 'owner',
        actorKind: 'owner',
        correlationId: transaction.id,
        payload: {
          transactionId: transaction.id,
          packageId: installed.packageId,
          version: installed.version,
          previousVersion: transaction.previousVersion ?? null,
        },
      })
      return installed
    })
  }

  rollbackPackageInstall(input: RollbackPackageInstallInput): PackageInstallTransaction {
    this.#assertWritable()
    const transaction = this.getPackageInstallTransaction(input.transactionId)
    if (transaction === undefined || transaction.status === 'activated') {
      throw new PersistenceError('Package install transaction cannot be rolled back')
    }
    const now = this.#clock()
    const rolledBack: PackageInstallTransaction = {
      ...transaction,
      status: 'rolled-back',
      errorCode: input.errorCode,
      updatedAt: now,
    }
    return this.#transaction(() => {
      this.database
        .prepare(
          `UPDATE package_install_transactions
           SET status = 'rolled-back', error_code = ?, updated_at = ? WHERE id = ?`,
        )
        .run(input.errorCode, now, transaction.id)
      this.#appendEvent({
        workspaceId: transaction.workspaceId,
        type: 'package.install.rolled-back',
        actorId: input.actorId ?? 'system',
        actorKind: input.actorId === undefined ? 'system' : 'owner',
        correlationId: transaction.id,
        payload: {
          transactionId: transaction.id,
          packageId: transaction.packageId,
          version: transaction.version,
          errorCode: rolledBack.errorCode ?? 'install-failed',
        },
      })
      return rolledBack
    })
  }

  compensateActivatedPackageInstall(input: RollbackPackageInstallInput): PackageInstallTransaction {
    this.#assertWritable()
    const transaction = this.getPackageInstallTransaction(input.transactionId)
    if (transaction === undefined || transaction.status !== 'activated') {
      throw new PersistenceError('Only an activated package install can be compensated')
    }
    const active = this.getActivePackage(transaction.workspaceId, transaction.packageId)
    if (active === undefined || active.version !== transaction.version) {
      throw new PersistenceError('Activated package no longer matches the compensation target')
    }
    const now = this.#clock()
    const rolledBack: PackageInstallTransaction = {
      ...transaction,
      status: 'rolled-back',
      errorCode: input.errorCode,
      updatedAt: now,
    }
    return this.#transaction(() => {
      this.database
        .prepare(
          `UPDATE installed_packages SET status = 'disabled', updated_at = ?
           WHERE workspace_id = ? AND package_id = ? AND version = ? AND status = 'active'`,
        )
        .run(now, transaction.workspaceId, transaction.packageId, transaction.version)
      if (transaction.previousVersion !== undefined) {
        const restored = this.database
          .prepare(
            `UPDATE installed_packages SET status = 'active', updated_at = ?
             WHERE workspace_id = ? AND package_id = ? AND version = ?`,
          )
          .run(now, transaction.workspaceId, transaction.packageId, transaction.previousVersion)
        if (restored.changes !== 1) throw new PersistenceError('Previous package version cannot be restored')
      }
      this.database
        .prepare(
          `UPDATE package_install_transactions
           SET status = 'rolled-back', error_code = ?, updated_at = ?
           WHERE id = ? AND status = 'activated'`,
        )
        .run(input.errorCode, now, transaction.id)
      this.#appendEvent({
        workspaceId: transaction.workspaceId,
        type: 'package.install.rolled-back',
        actorId: input.actorId ?? 'system',
        actorKind: input.actorId === undefined || input.actorId === 'system' ? 'system' : 'owner',
        correlationId: transaction.id,
        payload: {
          transactionId: transaction.id,
          packageId: transaction.packageId,
          version: transaction.version,
          previousVersion: transaction.previousVersion ?? null,
          errorCode: input.errorCode,
          compensatedAfterActivation: true,
        },
      })
      return rolledBack
    })
  }

  getRuntimeUpdateTransaction(transactionId: string): RuntimeUpdateTransaction | undefined {
    const row = this.database
      .prepare('SELECT * FROM runtime_update_transactions WHERE id = ?')
      .get(transactionId)
    return row ? mapRuntimeUpdateTransaction(row) : undefined
  }

  listRuntimeUpdateTransactions(): RuntimeUpdateTransaction[] {
    return this.database
      .prepare('SELECT * FROM runtime_update_transactions ORDER BY created_at DESC, id DESC')
      .all()
      .map(mapRuntimeUpdateTransaction)
  }

  beginRuntimeUpdate(input: BeginRuntimeUpdateInput): RuntimeUpdateTransaction {
    this.#assertWritable()
    const candidateRoot = resolve(input.candidateRoot.trim())
    const version = input.version.trim()
    const contractId = input.contractId.trim()
    if (!input.candidateRoot.trim()) throw new PersistenceError('Candidate runtime root cannot be empty')
    if (!version) throw new PersistenceError('Candidate runtime version cannot be empty')
    if (!contractId) throw new PersistenceError('Runtime compatibility contract cannot be empty')
    assertSecretFree(input.report)
    const now = this.#clock()
    const transaction: RuntimeUpdateTransaction = {
      id: this.#idFactory(),
      candidateRoot,
      version,
      contractId,
      status: 'verified',
      report: input.report,
      createdAt: now,
      updatedAt: now,
      ...(input.previousRuntimeRoot === undefined
        ? {}
        : { previousRuntimeRoot: resolve(input.previousRuntimeRoot) }),
    }
    this.database
      .prepare(
        `INSERT INTO runtime_update_transactions (
           id, candidate_root, version, contract_id, status, previous_runtime_root,
           report_json, error_code, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'verified', ?, ?, NULL, ?, ?)`,
      )
      .run(
        transaction.id,
        transaction.candidateRoot,
        transaction.version,
        transaction.contractId,
        transaction.previousRuntimeRoot ?? null,
        stringifyJson(transaction.report),
        transaction.createdAt,
        transaction.updatedAt,
      )
    return transaction
  }

  transitionRuntimeUpdate(input: TransitionRuntimeUpdateInput): RuntimeUpdateTransaction {
    this.#assertWritable()
    const transaction = this.getRuntimeUpdateTransaction(input.transactionId)
    if (transaction === undefined) throw new EntityNotFoundError('Runtime update transaction not found')
    const allowedTransitions: Record<RuntimeUpdateStatus, RuntimeUpdateStatus[]> = {
      verified: ['contract-tested', 'rejected'],
      'contract-tested': ['canary-passed', 'rejected'],
      'canary-passed': ['activated', 'rejected'],
      activated: ['rolled-back'],
      rejected: [],
      'rolled-back': [],
    }
    if (!allowedTransitions[transaction.status].includes(input.status)) {
      throw new PersistenceError(
        `Runtime update cannot transition from ${transaction.status} to ${input.status}`,
      )
    }
    if (input.status === 'rejected' && !input.errorCode?.trim()) {
      throw new PersistenceError('Rejected runtime update requires an error code')
    }
    assertSecretFree(input.report)
    const now = this.#clock()
    const updated: RuntimeUpdateTransaction = {
      ...transaction,
      status: input.status,
      report: input.report,
      updatedAt: now,
      ...(input.errorCode?.trim() ? { errorCode: input.errorCode.trim() } : {}),
    }
    const result = this.database
      .prepare(
        `UPDATE runtime_update_transactions
         SET status = ?, report_json = ?, error_code = ?, updated_at = ?
         WHERE id = ? AND status = ?`,
      )
      .run(
        updated.status,
        stringifyJson(updated.report),
        updated.errorCode ?? null,
        updated.updatedAt,
        updated.id,
        transaction.status,
      )
    if (Number(result.changes) !== 1) {
      throw new PersistenceError('Runtime update changed concurrently; reload before retrying')
    }
    return updated
  }

  getWorkspaceSnapshot(workspaceId: string): WorkspaceSnapshot {
    const workspace = this.#requireWorkspace(workspaceId)
    const row = this.database
      .prepare('SELECT COALESCE(MAX(sequence), 0) AS last FROM domain_events WHERE workspace_id = ?')
      .get(workspaceId) as { last: number }
    return {
      workspace,
      worlds: this.listWorlds(workspaceId),
      lastEventSequence: Number(row.last),
    }
  }

  getWorldSnapshot(worldId: string): WorldSnapshot {
    const world = this.#requireWorld(worldId)
    const workspace = this.#requireWorkspace(world.workspaceId)
    const employees = this.listEmployees(worldId)
    const openSessions = this.listSessions(worldId, 'open')
    const row = this.database
      .prepare('SELECT COALESCE(MAX(sequence), 0) AS last FROM domain_events WHERE world_id = ?')
      .get(worldId) as { last: number }
    return {
      workspace,
      world,
      employees,
      dossiers: employees.map((employee) => this.getEmployeeDossier(employee.id)),
      authorities: this.#worldAuthorities.list(worldId),
      openSessions,
      sessionParticipants: openSessions.flatMap((session) => this.listParticipants(session.id)),
      lastEventSequence: Number(row.last),
    }
  }

  getWorldRuntimeSnapshot(worldId: string): WorldRuntimeSnapshot | undefined {
    const row = this.database
      .prepare('SELECT snapshot_json FROM world_runtime_snapshots WHERE world_id = ?')
      .get(worldId) as { snapshot_json?: string } | undefined
    return row?.snapshot_json === undefined
      ? undefined
      : parseJson<WorldRuntimeSnapshot>(row.snapshot_json)
  }

  saveWorldRuntimeSnapshot(snapshot: WorldRuntimeSnapshot): WorldRuntimeSnapshot {
    this.#assertWritable()
    const world = this.#requireWorld(snapshot.worldId)
    if (world.workspaceId !== snapshot.workspaceId) {
      throw new PersistenceError('World runtime snapshot workspace does not match its world')
    }
    const updatedAt = this.#clock()
    return this.#transaction(() => {
      this.database
        .prepare(
          `INSERT INTO world_runtime_snapshots
           (world_id, theme_id, scene_id, sequence, snapshot_json, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (world_id) DO UPDATE SET
             theme_id = excluded.theme_id,
             scene_id = excluded.scene_id,
             sequence = excluded.sequence,
             snapshot_json = excluded.snapshot_json,
             updated_at = excluded.updated_at`,
        )
        .run(
          snapshot.worldId,
          snapshot.themeId,
          snapshot.sceneId,
          snapshot.sequence,
          stringifyJson(snapshot as unknown as JsonValue),
          updatedAt,
        )

      this.database.prepare('DELETE FROM world_entity_states WHERE world_id = ?').run(snapshot.worldId)
      const insertEntity = this.database.prepare(
        `INSERT INTO world_entity_states
         (world_id, entity_id, scene_id, anchor_id, target_anchor_id, facing, activity,
          activity_ref, target_entity_id, state_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      for (const entity of snapshot.entities) {
        insertEntity.run(
          snapshot.worldId,
          entity.id,
          entity.sceneId,
          entity.anchorId ?? null,
          entity.targetAnchorId ?? null,
          entity.facing,
          entity.activity,
          entity.activityRef ?? null,
          entity.targetEntityId ?? null,
          stringifyJson(entity as unknown as JsonValue),
          entity.updatedAt,
        )
      }

      this.database.prepare('DELETE FROM world_object_states WHERE world_id = ?').run(snapshot.worldId)
      const insertObject = this.database.prepare(
        `INSERT INTO world_object_states
         (world_id, entity_id, scene_id, state_json, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      for (const object of snapshot.objects) {
        insertObject.run(
          snapshot.worldId,
          object.id,
          object.sceneId,
          stringifyJson(object as unknown as JsonValue),
          object.updatedAt,
        )
      }

      return snapshot
    })
  }

  listWorldEntityStates(worldId: string): WorldRuntimeEntityState[] {
    return this.database
      .prepare('SELECT state_json FROM world_entity_states WHERE world_id = ? ORDER BY entity_id')
      .all(worldId)
      .map((row) => parseJson<WorldRuntimeEntityState>((row as { state_json: string }).state_json))
  }

  listWorldObjectStates(worldId: string): WorldRuntimeObjectState[] {
    return this.database
      .prepare('SELECT state_json FROM world_object_states WHERE world_id = ? ORDER BY entity_id')
      .all(worldId)
      .map((row) => parseJson<WorldRuntimeObjectState>((row as { state_json: string }).state_json))
  }

  getWorldThemeBinding(worldId: string): WorldThemeBinding | undefined {
    const row = this.database
      .prepare('SELECT * FROM world_theme_bindings WHERE world_id = ?')
      .get(worldId) as Record<string, unknown> | undefined
    if (row === undefined) return undefined
    return {
      worldId: String(row.world_id),
      packageId: String(row.package_id),
      packageVersion: String(row.package_version),
      themeId: String(row.theme_id),
      themeVersion: String(row.theme_version),
      contentDigest: String(row.content_digest),
      status: row.status as WorldThemeBinding['status'],
      manifest: parseJson<WorldThemeManifestV1>(row.manifest_json),
      updatedAt: String(row.updated_at),
    }
  }

  bindWorldTheme(
    worldId: string,
    identity: Pick<WorldThemeBinding, 'packageId' | 'packageVersion' | 'themeId' | 'themeVersion' | 'contentDigest'>,
    manifest: WorldThemeManifestV1,
  ): WorldThemeBinding {
    this.#assertWritable()
    const world = this.#requireWorld(worldId)
    if (!themeTemplateMatches(world.templateId, manifest.templateId)) {
      throw new PersistenceError('World theme is not compatible with this world')
    }
    const updatedAt = this.#clock()
    this.#transaction(() => {
      this.database
        .prepare(
          `INSERT INTO world_theme_bindings
           (world_id, package_id, package_version, theme_id, theme_version, content_digest, status, manifest_json, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
           ON CONFLICT (world_id) DO UPDATE SET
             package_id = excluded.package_id,
             package_version = excluded.package_version,
             theme_id = excluded.theme_id,
             theme_version = excluded.theme_version,
             content_digest = excluded.content_digest,
             status = 'active',
             manifest_json = excluded.manifest_json,
             updated_at = excluded.updated_at`,
        )
        .run(worldId, identity.packageId, identity.packageVersion, identity.themeId, identity.themeVersion, identity.contentDigest, stringifyJson(manifest as unknown as JsonValue), updatedAt)
      this.clearWorldRuntimeProjection(worldId)
    })
    return this.getWorldThemeBinding(worldId)!
  }

  disableWorldTheme(worldId: string): WorldThemeBinding | undefined {
    this.#assertWritable()
    this.#requireWorld(worldId)
    const updatedAt = this.#clock()
    this.#transaction(() => {
      this.database
        .prepare("UPDATE world_theme_bindings SET status = 'disabled', updated_at = ? WHERE world_id = ?")
        .run(updatedAt, worldId)
      this.clearWorldRuntimeProjection(worldId)
    })
    return this.getWorldThemeBinding(worldId)
  }

  clearWorldRuntimeProjection(worldId: string): void {
    this.#assertWritable()
    this.#requireWorld(worldId)
    this.database.prepare('DELETE FROM world_runtime_snapshots WHERE world_id = ?').run(worldId)
    this.database.prepare('DELETE FROM world_entity_states WHERE world_id = ?').run(worldId)
    this.database.prepare('DELETE FROM world_object_states WHERE world_id = ?').run(worldId)
  }

  async backup(destinationPath: string): Promise<string> {
    const destination = resolve(destinationPath)
    if (destination === this.databasePath) {
      throw new PersistenceError('Backup destination must differ from the live database')
    }
    await mkdir(dirname(destination), { recursive: true })
    await backup(this.database, destination)
    return destination
  }

  async exportJson(destinationPath: string): Promise<string> {
    const destination = resolve(destinationPath)
    const temporary = `${destination}.tmp-${randomUUID()}`
    await mkdir(dirname(destination), { recursive: true })
    const payload = {
      format: 'dsh-cyber-export',
      schemaVersion: readUserVersion(this.database),
      exportedAt: this.#clock(),
      runtimeUpdates: this.listRuntimeUpdateTransactions(),
       workspaces: this.listWorkspaces().map((workspace) => ({
         workspace,
         preferences: this.getWorkspacePreferences(workspace.id),
         modelProfiles: this.listModelProfiles(workspace.id),
         modelAssignments: this.listModelAssignments(workspace.id),
         localAssets: this.listLocalAssets(workspace.id),
         packages: this.listInstalledPackages(workspace.id),
        packageTransactions: this.listPackageInstallTransactions(workspace.id),
        worlds: this.listWorlds(workspace.id, true).map((world) => ({
          world,
           employees: this.listEmployees(world.id, true).map((employee) => ({
             employee,
             revisions: this.listEmployeeRevisions(employee.id),
             dossier: this.getEmployeeDossier(employee.id),
           })),
          sessions: this.listSessions(world.id).map((session) => ({
            session,
            participants: this.listParticipants(session.id),
            messages: this.listMessages(session.id),
          })),
          collaborationPlans: this.listTaskCollaborationPlans(world.id),
          conversationQueue: this.listConversationQueue(world.id),
          runtime: this.getWorldRuntimeSnapshot(world.id),
          themeBinding: this.getWorldThemeBinding(world.id),
          authorities: this.listWorldCharacterAuthorities(world.id),
          authorityChanges: this.listWorldAuthorityChanges(world.id),
          permissionRequests: this.listWorldPermissionRequests(world.id),
          events: this.listWorldDomainEvents(world.id),
        })),
        events: this.listDomainEvents(workspace.id).filter((event) => event.worldId === undefined),
      })),
    }
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, destination)
    return destination
  }

  doctor(): DatabaseDoctorReport {
    const errors: string[] = []
    const integrity = readIntegrity(this.database)
    if (integrity.length !== 1 || integrity[0] !== 'ok') errors.push(...integrity)
    const foreignKeyViolations = this.database.prepare('PRAGMA foreign_key_check').all()
    if (foreignKeyViolations.length > 0) errors.push(`Foreign key check found ${foreignKeyViolations.length} violation(s)`)
    const schemaVersion = readUserVersion(this.database)
    if (schemaVersion !== CYBER_SCHEMA_VERSION) {
      errors.push(`Expected schema ${CYBER_SCHEMA_VERSION}, found ${schemaVersion}`)
    }
    const migrationHistory = this.database.prepare('SELECT COUNT(*) AS count, MAX(version) AS maximum FROM schema_migrations').get() as { count: number; maximum: number | null }
    if (Number(migrationHistory.count) !== CYBER_SCHEMA_VERSION || Number(migrationHistory.maximum) !== CYBER_SCHEMA_VERSION) {
      errors.push(`Migration history is incomplete: ${migrationHistory.count} entries, latest ${migrationHistory.maximum ?? 'none'}`)
    }

    const report: DatabaseDoctorReport = {
      path: this.databasePath,
      ok: errors.length === 0,
      readOnly: this.readOnly,
      schemaVersion,
      integrity,
      counts: {
        workspaces: countRows(this.database, 'workspaces'),
        worlds: countRows(this.database, 'worlds'),
        employees: countRows(this.database, 'employee_instances'),
        employeeProfiles: countRows(this.database, 'employee_profile_revisions'),
        skillEvidence: countRows(this.database, 'skill_evidence'),
        employeeSkills: countRows(this.database, 'employee_skill_revisions'),
        employeeMilestones: countRows(this.database, 'employee_milestones'),
        employeeMemoryIndexEntries: countRows(this.database, 'employee_memory_index'),
        employeeJournals: countRows(this.database, 'employee_daily_journals'),
        employeeRelationships: countRows(this.database, 'employee_relationships'),
        workspacePreferences: countRows(this.database, 'workspace_preferences'),
        modelProfiles: countRows(this.database, 'model_profiles'),
        modelAssignments: countRows(this.database, 'model_assignments'),
        localAssets: countRows(this.database, 'local_assets'),
        sessions: countRows(this.database, 'work_sessions'),
        conversationQueueEntries: countRows(this.database, 'conversation_queue_entries'),
        completionJobs: countRows(this.database, 'completion_jobs'),
        taskCollaborationPlans: countRows(this.database, 'task_collaboration_plans'),
        taskCollaborationSteps: countRows(this.database, 'task_collaboration_steps'),
        messages: countRows(this.database, 'messages'),
        installedPackages: countRows(this.database, 'installed_packages'),
        worldPackageInstances: countRows(this.database, 'world_package_instances'),
        packageTransactions: countRows(this.database, 'package_install_transactions'),
        runtimeUpdates: countRows(this.database, 'runtime_update_transactions'),
        worldRuntimeSnapshots: countRows(this.database, 'world_runtime_snapshots'),
        worldEntityStates: countRows(this.database, 'world_entity_states'),
        worldObjectStates: countRows(this.database, 'world_object_states'),
        worldThemeBindings: countRows(this.database, 'world_theme_bindings'),
        modelInteractionLogs: countRows(this.database, 'model_interaction_logs'),
        taskSchedules: countRows(this.database, 'task_schedules'),
        taskScheduleRuns: countRows(this.database, 'task_schedule_runs'),
        approvalRequests: countRows(this.database, 'approval_requests'),
        approvalPolicies: countRows(this.database, 'approval_policies'),
        skillActions: countRows(this.database, 'skill_actions'),
        worldAuthorities: countRows(this.database, 'world_character_authorities'),
        worldAuthorityChanges: countRows(this.database, 'world_authority_changes'),
        worldPermissionRequests: countRows(this.database, 'world_permission_requests'),
        worldArtifacts: countRows(this.database, 'world_artifacts'),
        worldArtifactVersions: countRows(this.database, 'world_artifact_versions'),
        worldArtifactsMissing: countMissingWorldArtifacts(this.database),
        knowledgeCollections: countRows(this.database, 'knowledge_collections'),
        knowledgeDocuments: countRows(this.database, 'knowledge_documents'),
        knowledgeDocumentsMissing: countMissingKnowledgeDocuments(this.database),
        knowledgeChunks: countRows(this.database, 'knowledge_chunks'),
        knowledgeEntities: countRows(this.database, 'knowledge_entities'),
        knowledgeEvidence: countRows(this.database, 'knowledge_evidence'),
        knowledgeClaims: countRows(this.database, 'knowledge_claims'),
        knowledgeRelations: countRows(this.database, 'knowledge_relations'),
        knowledgeConsolidationJobs: countRows(this.database, 'knowledge_consolidation_jobs'),
        events: countRows(this.database, 'domain_events'),
        outbox: countRows(this.database, 'sync_outbox'),
      },
      errors,
    }
    const journalMode = readPragmaString(this.database, 'journal_mode')
    if (journalMode !== undefined) report.journalMode = journalMode
    const foreignKeys = readPragmaNumber(this.database, 'foreign_keys')
    if (foreignKeys !== undefined) report.foreignKeysEnabled = foreignKeys === 1
    return report
  }

  #configure(): void {
    this.database.exec('PRAGMA foreign_keys = ON')
    this.database.exec('PRAGMA busy_timeout = 5000')
    if (!this.readOnly) {
      this.database.exec('PRAGMA journal_mode = WAL')
      this.database.exec('PRAGMA synchronous = NORMAL')
      this.database.exec('PRAGMA wal_autocheckpoint = 1000')
    }
  }

  #assertWritable(): void {
    if (this.readOnly) throw new PersistenceError('Database is open in read-only mode')
    if (this.#closed) throw new PersistenceError('Database is closed')
  }

  #enqueueConversationTurn(input: EnqueueConversationTurnInput, priority: number): ConversationQueueEntry {
    this.#assertWritable()
    const workspace = this.#requireWorkspace(input.workspaceId)
    const world = this.#requireWorld(input.worldId)
    if (world.workspaceId !== workspace.id || world.status === 'archived') {
      throw new PersistenceError('Conversation queue world does not belong to workspace')
    }
    const session = this.#requireSession(input.sessionId)
    if (session.workspaceId !== workspace.id || session.worldId !== world.id) {
      throw new PersistenceError('Conversation queue session does not match world')
    }
    const turn = this.getWorkTurn(input.workTurnId)
    if (turn === undefined || turn.workspaceId !== workspace.id || turn.worldId !== world.id || turn.sessionId !== session.id) {
      throw new PersistenceError('Conversation queue WorkTurn does not match its session')
    }
    if (turn.status !== 'queued') throw new PersistenceError('Only queued WorkTurns can be enqueued')
    if (input.conversationKind !== session.kind) {
      throw new PersistenceError('Conversation queue kind does not match its session')
    }
    const collaborationMode = validateSessionCollaborationMode(
      input.collaborationMode ?? session.collaborationMode ?? 'discussion',
    )
    if (collaborationMode === 'task' && session.kind !== 'group') {
      throw new PersistenceError('Task collaboration mode requires a group session')
    }
    if (session.kind === 'group' && (collaborationMode === 'task') !== (turn.interactionKind === 'task')) {
      throw new PersistenceError('Conversation queue collaboration mode does not match its WorkTurn')
    }
    const employeeIds = normalizeQueueEmployeeIds(input.employeeIds)
    for (const employeeId of employeeIds) {
      const employee = this.#requireEmployee(employeeId)
      if (employee.workspaceId !== workspace.id || employee.worldId !== world.id || employee.status === 'archived') {
        throw new PersistenceError('Conversation queue employee does not belong to this world')
      }
    }
    const normalizedPriority = validateQueuePriority(priority)
    const reasoningEffort = input.reasoningEffort === undefined
      ? undefined
      : validateQueueReasoningEffort(input.reasoningEffort)
    const permissionMode = input.permissionMode === undefined
      ? undefined
      : validateQueuePermissionMode(input.permissionMode)
    const id = normalizeRequiredToken(input.id ?? this.#idFactory(), 'Conversation queue id', 160)
    const now = this.#clock()

    return this.#transaction(() => {
      const existingByTurn = this.database
        .prepare('SELECT * FROM conversation_queue_entries WHERE work_turn_id = ?')
        .get(turn.id)
      if (existingByTurn !== undefined) {
        const existing = mapConversationQueueEntry(existingByTurn)
        const metadata: NormalizedConversationQueueMetadata = {
          workspaceId: input.workspaceId,
          worldId: input.worldId,
          sessionId: input.sessionId,
          workTurnId: input.workTurnId,
          conversationKind: input.conversationKind,
          priority: normalizedPriority,
          collaborationMode,
          employeeIds,
          ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
          ...(permissionMode === undefined ? {} : { permissionMode }),
        }
        if (sameConversationQueueMetadata(existing, metadata)) return existing
        throw new PersistenceError('Conversation queue WorkTurn already has a different entry')
      }
      const existingById = this.database.prepare('SELECT * FROM conversation_queue_entries WHERE id = ?').get(id)
      if (existingById !== undefined) throw new PersistenceError(`Conversation queue entry already exists: ${id}`)
      this.database.prepare(
        `INSERT INTO conversation_queue_entries
         (id, workspace_id, world_id, session_id, work_turn_id, employee_ids_json,
          conversation_kind, collaboration_mode, reasoning_effort, permission_mode,
          priority, revision, status, error_code, attempt_count, available_at,
          lease_owner, lease_expires_at, enqueued_at, claimed_at, completed_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id, workspace.id, world.id, session.id, turn.id, stringifyJson(employeeIds),
        session.kind, collaborationMode, reasoningEffort ?? null, permissionMode ?? null,
        normalizedPriority, 1, 'queued', null, 0, now, null, null, now, null, null, now,
      )
      return mapConversationQueueEntry(this.database.prepare(
        'SELECT * FROM conversation_queue_entries WHERE id = ?',
      ).get(id)!)
    })
  }

  #requireQueueEntryForTransition(
    queueEntryId: string,
    expectedStatus: ConversationQueueEntryStatus | readonly ConversationQueueEntryStatus[],
    expectedRevision?: number,
  ): ConversationQueueEntry {
    const entry = this.getConversationQueueEntry(queueEntryId)
    if (entry === undefined) throw new EntityNotFoundError(`Conversation queue entry not found: ${queueEntryId}`)
    const statuses = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus]
    if (!statuses.includes(entry.status)) {
      throw new PersistenceError(`Conversation queue entry cannot transition from ${entry.status}`)
    }
    if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision !== entry.revision)) {
      throw new PersistenceError('Conversation queue entry changed concurrently')
    }
    return entry
  }

  #cancelQueuedQueueEntry(entry: ConversationQueueEntry, now: string): boolean {
    if (entry.status !== 'queued') return false
    const errorCode = 'queue-cancelled'
    const turnResult = this.database.prepare(
      `UPDATE work_turns SET status = 'interrupted', error_code = ?, completed_at = ?
       WHERE id = ? AND status = 'queued'`,
    ).run(errorCode, now, entry.workTurnId)
    if (Number(turnResult.changes) !== 1) return false
    const queueResult = this.database.prepare(
      `UPDATE conversation_queue_entries
       SET status = 'cancelled', error_code = ?, revision = revision + 1, completed_at = ?, updated_at = ?
       WHERE id = ? AND status = 'queued' AND revision = ?`,
    ).run(errorCode, now, now, entry.id, entry.revision)
    if (Number(queueResult.changes) !== 1) throw new PersistenceError('Conversation queue entry changed concurrently')
    return true
  }

  #syncCompatibilityPrimaryAdministrator(worldId: string, updatedAt: string): void {
    const world = this.getWorld(worldId)
    if (world === undefined) return
    const activeEmployees = this.listEmployees(worldId)
    const activeIds = new Set(activeEmployees.map((employee) => employee.id))
    const pointerAuthority = world.administratorEmployeeId === undefined
      ? undefined
      : this.#worldAuthorities.get(worldId, world.administratorEmployeeId)
    const pointerIsValid = world.administratorEmployeeId !== undefined &&
      activeIds.has(world.administratorEmployeeId) && pointerAuthority?.role === 'administrator'
    if (pointerIsValid) return
    const next = this.#worldAuthorities
      .listActive(worldId)
      .filter((authority) => authority.role === 'administrator')
      .map((authority) => activeEmployees.find((employee) => employee.id === authority.employeeId))
      .filter((employee): employee is EmployeeInstance => employee !== undefined)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))[0]
    this.database
      .prepare('UPDATE worlds SET administrator_employee_id = ?, updated_at = ? WHERE id = ?')
      .run(next?.id ?? null, updatedAt, worldId)
  }

  #transaction<T>(operation: () => T): T {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      this.database.exec('COMMIT')
      return result
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  #appendMessage(input: AppendMessageInput): WorkMessage {
    const session = this.#requireSession(input.sessionId)
    const now = this.#clock()
    const next = this.database
      .prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM messages WHERE session_id = ?')
      .get(session.id) as { next: number }
    const message: WorkMessage = {
      id: this.#idFactory(),
      sessionId: session.id,
      sequence: Number(next.next),
      senderId: input.senderId,
      senderKind: input.senderKind,
      kind: input.kind,
      content: input.content,
      metadata: input.metadata ?? {},
      createdAt: now,
    }
    this.database.prepare(
      `INSERT INTO messages
       (id, session_id, sequence, sender_id, sender_kind, kind, content, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      message.id, message.sessionId, message.sequence, message.senderId, message.senderKind,
      message.kind, message.content, stringifyJson(message.metadata), message.createdAt,
    )
    this.database.prepare('UPDATE work_sessions SET updated_at = ? WHERE id = ?').run(now, session.id)
    const eventInput: AppendDomainEventInput = {
      workspaceId: session.workspaceId,
      worldId: session.worldId,
      type: 'message.appended',
      actorId: message.senderId,
      actorKind: message.senderKind,
      sessionId: session.id,
      payload: {
        messageId: message.id,
        messageSequence: message.sequence,
        messageKind: message.kind,
        senderId: message.senderId,
      },
    }
    if (input.causationId !== undefined) eventInput.causationId = input.causationId
    if (input.correlationId !== undefined) eventInput.correlationId = input.correlationId
    this.#appendEvent(eventInput)
    return message
  }

  #mergeCompletionMessageMetadata(agentRunId: string, patch: JsonObject): void {
    const row = this.database.prepare(
      `SELECT id, metadata_json FROM messages
       WHERE kind = 'assistant' AND json_extract(metadata_json, '$.agentRunId') = ?
       ORDER BY sequence DESC LIMIT 1`,
    ).get(agentRunId) as { id: string; metadata_json: string } | undefined
    if (row === undefined) throw new PersistenceError('Completion job lost its final assistant message')
    const metadata = { ...parseJson<JsonObject>(row.metadata_json), ...patch }
    assertSecretFree(metadata)
    this.database.prepare('UPDATE messages SET metadata_json = ? WHERE id = ?')
      .run(stringifyJson(metadata), row.id)
  }

  #appendEvent(input: AppendDomainEventInput): DomainEvent {
    if (!isDomainEventType(input.type)) throw new PersistenceError(`Unknown event type: ${input.type}`)
    const payload = input.payload ?? {}
    assertSecretFree(payload)
    const id = this.#idFactory()
    const createdAt = this.#clock()
    const result = this.database
      .prepare(
        `INSERT INTO domain_events
         (event_id, workspace_id, world_id, type, actor_id, actor_kind, session_id,
          causation_id, correlation_id, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.workspaceId,
        input.worldId ?? null,
        input.type,
        input.actorId,
        input.actorKind,
        input.sessionId ?? null,
        input.causationId ?? null,
        input.correlationId ?? null,
        stringifyJson(payload),
        createdAt,
      )
    this.database
      .prepare(
        `INSERT INTO sync_outbox
         (event_id, status, attempts, available_at, created_at, updated_at)
         VALUES (?, 'pending', 0, ?, ?, ?)`,
      )
      .run(id, createdAt, createdAt, createdAt)

    const event: DomainEvent = {
      id,
      workspaceId: input.workspaceId,
      sequence: Number(result.lastInsertRowid),
      type: input.type,
      actorId: input.actorId,
      actorKind: input.actorKind,
      payload,
      createdAt,
    }
    if (input.worldId !== undefined) event.worldId = input.worldId
    if (input.sessionId !== undefined) event.sessionId = input.sessionId
    if (input.causationId !== undefined) event.causationId = input.causationId
    if (input.correlationId !== undefined) event.correlationId = input.correlationId
    return event
  }

  #addParticipant(
    session: WorkSession,
    participantId: string,
    kind: ParticipantKind,
  ): WorkSessionParticipant {
    if (kind === 'employee') {
      const employee = this.#requireEmployee(participantId)
      if (
        employee.workspaceId !== session.workspaceId ||
        employee.worldId !== session.worldId ||
        employee.status === 'archived'
      ) {
        throw new PersistenceError('Employee cannot join this session')
      }
    }
    const joinedAt = this.#clock()
    this.database
      .prepare(
        `INSERT INTO work_session_participants (session_id, participant_id, kind, joined_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (session_id, participant_id) DO NOTHING`,
      )
      .run(session.id, participantId, kind, joinedAt)
    this.#appendEvent({
      workspaceId: session.workspaceId,
      worldId: session.worldId,
      type: 'session.participant.joined',
      actorId: participantId,
      actorKind: kind,
      sessionId: session.id,
      payload: { sessionId: session.id, participantId, participantKind: kind },
    })
    return { sessionId: session.id, participantId, kind, joinedAt }
  }

  #insertEmployee(employee: EmployeeInstance): void {
    this.database
      .prepare(
        `INSERT INTO employee_instances (
          id, workspace_id, world_id, blueprint_id, blueprint_version, display_name, role,
          status, health, health_error_code, health_detail, current_revision,
          agent_session_id, created_at, updated_at, archived_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        employee.id,
        employee.workspaceId,
        employee.worldId,
        employee.blueprintId,
        employee.blueprintVersion,
        employee.displayName,
        employee.role,
        employee.status,
        employee.health,
        employee.healthErrorCode ?? null,
        employee.healthDetail ?? null,
        employee.currentRevision,
        employee.agentSessionId ?? null,
        employee.createdAt,
        employee.updatedAt,
        employee.archivedAt ?? null,
      )
  }

  #mapEmployeeRuntimeState(row: object): EmployeeInstance {
    const employee = mapEmployee(row)
    if (employee.status === 'archived') return employee
    const activeRunRow = this.database.prepare(
      `SELECT COUNT(*) AS count FROM agent_runs
       WHERE employee_id = ? AND status IN ('queued', 'running')`,
    ).get(employee.id) as { count: number | bigint }
    const waitingApprovalRow = this.database.prepare(
      `SELECT COUNT(DISTINCT queue.id) AS count
       FROM conversation_queue_entries AS queue, json_each(queue.employee_ids_json) AS participant
       WHERE queue.status = 'waiting-approval' AND participant.value = ?`,
    ).get(employee.id) as { count: number | bigint }
    const activeRunCount = Number(activeRunRow.count)
    const waitingApprovalCount = Number(waitingApprovalRow.count)
    employee.presence = activeRunCount + waitingApprovalCount > 0 ? 'working' : 'available'
    employee.status = employee.health === 'blocked' ? 'blocked' : employee.presence
    return employee
  }

  #insertRevision(revision: EmployeeRevision): void {
    this.database
      .prepare(
        `INSERT INTO employee_revisions
         (employee_id, revision, persona, skill_grants_json, capability_grants_json,
           model_policy_json, runtime_permission_mode, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        revision.employeeId,
        revision.revision,
        revision.persona,
        stringifyJson(revision.skillGrants),
        stringifyJson(revision.capabilityGrants),
        stringifyJson(revision.modelPolicy),
        revision.runtimePermissionMode ?? 'read-only',
        revision.reason,
        revision.createdAt,
      )
  }

  #insertTaskCollaborationStep(step: TaskCollaborationStep): void {
    this.database.prepare(
      `INSERT INTO task_collaboration_steps
       (id, plan_id, ordinal, required_skills_json, assigned_employee_ids_json,
        depends_on_json, execution_mode, status, error_code, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      step.id,
      step.planId,
      step.ordinal,
      stringifyJson(step.requiredSkills),
      stringifyJson(step.assignedEmployeeIds),
      stringifyJson(step.dependsOn),
      step.executionMode,
      step.status,
      step.errorCode ?? null,
      step.createdAt,
      step.updatedAt,
    )
  }

  #mapTaskCollaborationPlan(row: object): TaskCollaborationPlan {
    const value = row as Record<string, unknown>
    const plan: TaskCollaborationPlan = {
      id: String(value.id),
      taskId: String(value.task_id),
      workspaceId: String(value.workspace_id),
      worldId: String(value.world_id),
      sessionId: String(value.session_id),
      workTurnId: String(value.work_turn_id),
      revision: Number(value.revision),
      status: value.status as TaskCollaborationPlanStatus,
      steps: this.database.prepare(
        `SELECT * FROM task_collaboration_steps
         WHERE plan_id = ? ORDER BY ordinal, id`,
      ).all(String(value.id)).map(mapTaskCollaborationStep),
      createdAt: String(value.created_at),
      updatedAt: String(value.updated_at),
    }
    if (typeof value.error_code === 'string') plan.errorCode = value.error_code
    return plan
  }

  #assertTaskStepEmployees(world: World, steps: NormalizedTaskStep[]): void {
    for (const step of steps) {
      for (const employeeId of step.assignedEmployeeIds) {
        const employee = this.#requireEmployee(employeeId)
        if (employee.workspaceId !== world.workspaceId || employee.worldId !== world.id || employee.status === 'archived') {
          throw new PersistenceError(`Task collaboration step employee does not belong to this world: ${employeeId}`)
        }
      }
    }
  }

  #recoverTaskCollaborationPlansAfterRestart(now: string, worldId?: string): TaskCollaborationRecoveryReport {
    const planWhere = worldId === undefined ? '' : ' AND world_id = ?'
    const planParams = worldId === undefined ? [] : [worldId]
    const steps = this.database.prepare(
      `UPDATE task_collaboration_steps
       SET status = 'interrupted', error_code = 'service-restarted', updated_at = ?
       WHERE status IN ('pending', 'ready', 'running', 'blocked')
         AND plan_id IN (
           SELECT id FROM task_collaboration_plans WHERE status = 'running'${planWhere}
         )`,
    ).run(now, ...planParams)
    const plans = this.database.prepare(
      `UPDATE task_collaboration_plans
       SET status = 'interrupted', revision = revision + 1, error_code = 'service-restarted', updated_at = ?
       WHERE status = 'running'${planWhere}`,
    ).run(now, ...planParams)
    return { plansInterrupted: Number(plans.changes), stepsInterrupted: Number(steps.changes) }
  }

  #assertEvidenceSources(
    employee: EmployeeInstance,
    sourceEventIds: string[],
    sourceMessageIds: string[],
  ): void {
    if (sourceEventIds.length === 0 && sourceMessageIds.length === 0) {
      throw new PersistenceError('Growth records require a source event or message')
    }
    for (const eventId of sourceEventIds) {
      const row = this.database
        .prepare(
          `SELECT workspace_id, world_id FROM domain_events
           WHERE event_id = ?`,
        )
        .get(eventId) as { workspace_id: string; world_id?: string | null } | undefined
      if (
        row === undefined ||
        String(row.workspace_id) !== employee.workspaceId ||
        String(row.world_id ?? '') !== employee.worldId
      ) {
        throw new PersistenceError(`Growth source event does not belong to this world: ${eventId}`)
      }
    }
    for (const messageId of sourceMessageIds) {
      const row = this.database
        .prepare(
          `SELECT sessions.workspace_id, sessions.world_id
           FROM messages JOIN work_sessions AS sessions ON sessions.id = messages.session_id
           WHERE messages.id = ?`,
        )
        .get(messageId) as { workspace_id: string; world_id: string } | undefined
      if (
        row === undefined ||
        String(row.workspace_id) !== employee.workspaceId ||
        String(row.world_id) !== employee.worldId
      ) {
        throw new PersistenceError(`Growth source message does not belong to this world: ${messageId}`)
      }
    }
  }

  #insertMilestone(
    employee: EmployeeInstance,
    input: {
      category: EmployeeMilestoneCategory
      title: string
      summary: string
      sourceEventIds: string[]
      sourceMessageIds: string[]
      artifactRefs: string[]
      occurredAt: string
      actorId: string
    },
  ): EmployeeMilestone {
    const milestone: EmployeeMilestone = {
      id: this.#idFactory(),
      workspaceId: employee.workspaceId,
      worldId: employee.worldId,
      employeeId: employee.id,
      category: input.category,
      title: input.title.trim(),
      summary: input.summary.trim(),
      sourceEventIds: uniqueStrings(input.sourceEventIds),
      sourceMessageIds: uniqueStrings(input.sourceMessageIds),
      artifactRefs: uniqueStrings(input.artifactRefs),
      occurredAt: input.occurredAt,
      createdAt: this.#clock(),
    }
    if (!milestone.title) throw new PersistenceError('Milestone title cannot be empty')
    if (!milestone.summary) throw new PersistenceError('Milestone summary cannot be empty')
    this.#assertEvidenceSources(employee, milestone.sourceEventIds, milestone.sourceMessageIds)
    this.database
      .prepare(
        `INSERT INTO employee_milestones
         (id, workspace_id, world_id, employee_id, category, title, summary,
          source_event_ids_json, source_message_ids_json, artifact_refs_json,
          occurred_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        milestone.id,
        milestone.workspaceId,
        milestone.worldId,
        milestone.employeeId,
        milestone.category,
        milestone.title,
        milestone.summary,
        stringifyJson(milestone.sourceEventIds),
        stringifyJson(milestone.sourceMessageIds),
        stringifyJson(milestone.artifactRefs),
        milestone.occurredAt,
        milestone.createdAt,
      )
    const eventInput: AppendDomainEventInput = {
      workspaceId: employee.workspaceId,
      worldId: employee.worldId,
      type: 'employee.milestone.recorded',
      actorId: input.actorId,
      actorKind: input.actorId === employee.id ? 'employee' : input.actorId === 'system' ? 'system' : 'owner',
      payload: {
        employeeId: employee.id,
        milestoneId: milestone.id,
        category: milestone.category,
      },
    }
    const causationId = milestone.sourceEventIds[0]
    if (causationId !== undefined) eventInput.causationId = causationId
    this.#appendEvent(eventInput)
    return milestone
  }

  #requireRelationship(employeeId: string, colleagueId: string): EmployeeRelationship {
    const row = this.database
      .prepare(
        `SELECT * FROM employee_relationships
         WHERE employee_id = ? AND colleague_id = ?`,
      )
      .get(employeeId, colleagueId)
    if (row === undefined) {
      throw new EntityNotFoundError(`Employee relationship not found: ${employeeId}/${colleagueId}`)
    }
    return mapEmployeeRelationship(row)
  }

  #transitionWorkTurn(
    turnId: string,
    from: WorkTurn['status'][],
    to: WorkTurn['status'],
    errorCode?: string,
  ): WorkTurn {
    this.#assertWritable()
    const turn = this.getWorkTurn(turnId)
    if (turn === undefined) throw new EntityNotFoundError(`Work turn not found: ${turnId}`)
    if (!from.includes(turn.status)) throw new PersistenceError(`Illegal work turn transition: ${turn.status} -> ${to}`)
    const now = this.#clock()
    const normalizedError = errorCode?.trim()
    if ((to === 'failed' || to === 'interrupted') && !normalizedError) throw new PersistenceError('Terminal work turn requires an error code')
    const result = this.database.prepare(
      `UPDATE work_turns SET status = ?, error_code = ?,
       started_at = CASE WHEN ? = 'running' THEN COALESCE(started_at, ?) ELSE started_at END,
       completed_at = CASE WHEN ? IN ('completed', 'failed', 'interrupted') THEN ? ELSE completed_at END
       WHERE id = ? AND status = ?`,
    ).run(to, normalizedError ?? null, to, now, to, now, turnId, turn.status)
    if (Number(result.changes) !== 1) throw new PersistenceError('Work turn transition lost a concurrent race')
    return this.getWorkTurn(turnId)!
  }

  #transitionAgentRun(
    runId: string,
    from: AgentRun['status'][],
    to: AgentRun['status'],
    errorCode?: string,
    runtimeSessionId?: string,
  ): AgentRun {
    this.#assertWritable()
    const run = this.getAgentRun(runId)
    if (run === undefined) throw new EntityNotFoundError(`Agent run not found: ${runId}`)
    if (!from.includes(run.status)) throw new PersistenceError(`Illegal agent run transition: ${run.status} -> ${to}`)
    const now = this.#clock()
    const normalizedError = errorCode?.trim()
    if ((to === 'failed' || to === 'interrupted') && !normalizedError) throw new PersistenceError('Terminal agent run requires an error code')
    this.database.prepare(
      `UPDATE agent_runs SET status = ?, error_code = ?, runtime_session_id = COALESCE(?, runtime_session_id),
       started_at = CASE WHEN ? = 'running' THEN ? ELSE started_at END,
       completed_at = CASE WHEN ? IN ('completed', 'failed', 'interrupted') THEN ? ELSE completed_at END
       WHERE id = ?`,
    ).run(to, normalizedError ?? null, runtimeSessionId?.trim() || null, to, now, to, now, runId)
    return this.getAgentRun(runId)!
  }

  #requireWorkspace(workspaceId: string): Workspace {
    const workspace = this.getWorkspace(workspaceId)
    if (!workspace) throw new EntityNotFoundError(`Workspace not found: ${workspaceId}`)
    return workspace
  }

  #requireWorld(worldId: string): World {
    const world = this.getWorld(worldId)
    if (!world) throw new EntityNotFoundError(`World not found: ${worldId}`)
    return world
  }

  #requireEmployee(employeeId: string): EmployeeInstance {
    const employee = this.getEmployee(employeeId)
    if (!employee) throw new EntityNotFoundError(`Employee not found: ${employeeId}`)
    return employee
  }

  #requireSession(sessionId: string): WorkSession {
    const session = this.getSession(sessionId)
    if (!session) throw new EntityNotFoundError(`Session not found: ${sessionId}`)
    return session
  }
}

export async function exportReadonlyRecovery(
  sourcePath: string,
  destinationPath: string,
): Promise<RecoveryExportReport> {
  const source = resolve(sourcePath)
  const destination = resolve(destinationPath)
  const report: RecoveryExportReport = {
    sourcePath: source,
    destinationPath: destination,
    opened: false,
    integrity: [],
    tables: {},
    errors: [],
  }
  const exportPayload: Record<string, unknown> = {
    format: 'dsh-cyber-readonly-recovery',
    recoveredAt: new Date().toISOString(),
    sourcePath: source,
    tables: {},
  }
  let database: DatabaseSync | undefined
  try {
    database = new DatabaseSync(source, { readOnly: true })
    report.opened = true
    try {
      report.integrity = readIntegrity(database)
    } catch (error) {
      report.errors.push(`Integrity check failed: ${errorMessage(error)}`)
    }
    const tables = exportPayload.tables as Record<string, unknown>
    for (const table of KNOWN_TABLES) {
      try {
        const rows = database.prepare(`SELECT * FROM ${table}`).all()
        tables[table] = rows
        report.tables[table] = { rows: rows.length }
      } catch (error) {
        const message = errorMessage(error)
        report.tables[table] = { rows: 0, error: message }
        report.errors.push(`${table}: ${message}`)
      }
    }
  } catch (error) {
    report.errors.push(`Open failed: ${errorMessage(error)}`)
  } finally {
    database?.close()
  }
  exportPayload.report = report
  await writeJsonAtomic(destination, exportPayload)
  return report
}

async function assertExistingDatabaseHealthy(databasePath: string): Promise<void> {
  const size = (await stat(databasePath)).size
  if (size === 0) {
    const preserved = await preserveCorruptCopy(databasePath)
    throw new DatabaseCorruptError('Existing SQLite database is empty', databasePath, preserved)
  }

  let database: DatabaseSync | undefined
  try {
    database = new DatabaseSync(databasePath, { readOnly: true })
    const integrity = readIntegrity(database)
    if (integrity.length !== 1 || integrity[0] !== 'ok') {
      throw new Error(integrity.join('; '))
    }
  } catch (error) {
    const preserved = await preserveCorruptCopy(databasePath)
    throw new DatabaseCorruptError(
      `SQLite integrity preflight failed: ${errorMessage(error)}`,
      databasePath,
      preserved,
    )
  } finally {
    database?.close()
  }
}

async function preserveCorruptCopy(databasePath: string): Promise<string | undefined> {
  if (!(await fileExists(databasePath))) return undefined
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-')
  const destination = `${databasePath}.corrupt-${stamp}`
  await copyFile(databasePath, destination)
  return destination
}

async function writeJsonAtomic(destination: string, value: unknown): Promise<void> {
  await mkdir(dirname(destination), { recursive: true })
  const temporary = `${destination}.tmp-${randomUUID()}`
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporary, destination)
}

function readIntegrity(database: DatabaseSync): string[] {
  return database
    .prepare('PRAGMA quick_check')
    .all()
    .flatMap((row) => Object.values(row).map(String))
}

function readPragmaString(database: DatabaseSync, pragma: string): string | undefined {
  const row = database.prepare(`PRAGMA ${pragma}`).get()
  if (!row) return undefined
  const value = Object.values(row)[0]
  return value === undefined ? undefined : String(value)
}

function readPragmaNumber(database: DatabaseSync, pragma: string): number | undefined {
  const value = readPragmaString(database, pragma)
  return value === undefined ? undefined : Number(value)
}

function countRows(database: DatabaseSync, table: string): number {
  try {
    const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as
      | { count?: number }
      | undefined
    return Number(row?.count ?? 0)
  } catch {
    return 0
  }
}

function countMissingWorldArtifacts(database: DatabaseSync): number {
  try {
    const row = database.prepare("SELECT COUNT(*) AS count FROM world_artifacts WHERE status = 'missing'").get() as
      | { count?: number }
      | undefined
    return Number(row?.count ?? 0)
  } catch {
    return 0
  }
}

function countMissingKnowledgeDocuments(database: DatabaseSync): number {
  try {
    const row = database.prepare("SELECT COUNT(*) AS count FROM knowledge_documents WHERE status = 'missing'").get() as
      | { count?: number }
      | undefined
    return Number(row?.count ?? 0)
  } catch {
    return 0
  }
}

function themeTemplateMatches(worldTemplateId: string, themeTemplateId: string): boolean {
  if (worldTemplateId === themeTemplateId) return true
  return new Set([worldTemplateId, themeTemplateId]).size === 2 &&
    [worldTemplateId, themeTemplateId].every((value) => value === 'company' || value === 'cyber-company')
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath)
    return true
  } catch {
    return false
  }
}

function stringifyJson(value: JsonValue): string {
  return JSON.stringify(value)
}

function stableJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key]!)}`).join(',')}}`
}

function parseJson<T>(value: unknown): T {
  return JSON.parse(String(value)) as T
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

function assertSubset(values: string[], allowedValues: string[], label: string): void {
  assertUnique(values, label)
  const allowed = new Set(allowedValues)
  const denied = values.find((value) => !allowed.has(value))
  if (denied !== undefined) throw new PersistenceError(`Employee ${label} is not requested by the blueprint: ${denied}`)
}

function assertUnique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) throw new PersistenceError(`Employee ${label}s must be unique`)
}

function employeeBlueprintEquals(left: EmployeeBlueprint, right: EmployeeBlueprint): boolean {
  return left.schemaVersion === right.schemaVersion &&
    left.id === right.id &&
    left.version === right.version &&
    left.worldTemplateId === right.worldTemplateId &&
    left.displayName === right.displayName &&
    left.role === right.role &&
    left.summary === right.summary &&
    left.persona === right.persona &&
    left.createdAt === right.createdAt &&
    [...left.requestedSkills].sort().join('\u0000') === [...right.requestedSkills].sort().join('\u0000') &&
    [...left.requestedCapabilities].sort().join('\u0000') === [...right.requestedCapabilities].sort().join('\u0000') &&
    JSON.stringify(left.embodiment ?? null) === JSON.stringify(right.embodiment ?? null)
}

function assertBirthday(value: string): void {
  if (!/^(?:\d{4}-)?\d{2}-\d{2}$/.test(value)) {
    throw new PersistenceError('Birthday must use MM-DD or YYYY-MM-DD')
  }
  const parts = value.split('-').map(Number)
  const month = parts.length === 2 ? parts[0] : parts[1]
  const day = parts.length === 2 ? parts[1] : parts[2]
  if (month === undefined || day === undefined || month < 1 || month > 12 || day < 1 || day > 31) {
    throw new PersistenceError('Birthday is not a valid calendar date')
  }
}

function assertLocalAssetRef(value: string): void {
  if (
    value.length > 240 ||
    value.includes('..') ||
    value.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    /^[a-z][a-z0-9+.-]*:/i.test(value) ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)
  ) {
    throw new PersistenceError('Background asset must be a safe local asset reference')
  }
}

function assertManagedRelativePath(value: string, label: string): string {
  const normalized = value.trim().replace(/\\/g, '/')
  if (
    normalized.length === 0 || normalized.length > 512 || normalized.includes('..') ||
    normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized) ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(normalized)
  ) {
    throw new PersistenceError(`World package ${label} must be a safe relative path`)
  }
  return normalized
}

function assertOptionalCount(label: string, value: number | undefined): void {
  if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
    throw new PersistenceError(`Model interaction ${label} must be a non-negative integer`)
  }
}

function normalizeModelBaseUrl(value: string, providerKind: ModelProviderKind): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new PersistenceError('Model base URL is invalid')
  }
  if (providerKind === 'openai-compatible-local' && (!isLocalModelHostname(url.hostname) || !['http:', 'https:'].includes(url.protocol))) {
    throw new PersistenceError('Local model base URL must use a loopback or private-network HTTP(S) address')
  }
  if (providerKind !== 'openai-compatible-local' && url.protocol !== 'https:') {
    throw new PersistenceError('Remote model base URL must use HTTPS')
  }
  url.username = ''
  url.password = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

function isLocalModelHostname(value: string): boolean {
  const hostname = value.toLowerCase().replace(/^\[|\]$/g, '')
  if (hostname === 'localhost' || hostname === '::1' || hostname === 'host.docker.internal' || hostname === 'host.containers.internal' || hostname.endsWith('.local')) return true
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname)
  if (ipv4 !== null) {
    const octets = ipv4.slice(1).map(Number)
    if (octets.some((octet) => octet > 255)) return false
    const [first, second] = octets
    return first === 10
      || first === 127
      || (first === 172 && second !== undefined && second >= 16 && second <= 31)
      || (first === 192 && second === 168)
      || (first === 169 && second === 254)
      || (first === 100 && second !== undefined && second >= 64 && second <= 127)
  }
  return hostname.includes(':') && (hostname.startsWith('fc') || hostname.startsWith('fd') || hostname.startsWith('fe80:'))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function mapWorkspace(row: object): Workspace {
  const value = row as Record<string, unknown>
  return {
    id: String(value.id),
    name: String(value.name),
    status: value.status as Workspace['status'],
    createdAt: String(value.created_at),
    updatedAt: String(value.updated_at),
  }
}

function mapWorld(row: object): World {
  const value = row as Record<string, unknown>
  const world: World = {
    id: String(value.id),
    workspaceId: String(value.workspace_id),
    name: String(value.name),
    templateId: String(value.template_id),
    status: value.status as World['status'],
    createdAt: String(value.created_at),
    updatedAt: String(value.updated_at),
  }
  if (typeof value.administrator_employee_id === 'string') world.administratorEmployeeId = value.administrator_employee_id
  return world
}

function mapBlueprint(row: object): EmployeeBlueprint {
  const value = row as Record<string, unknown>
  const blueprint: EmployeeBlueprint = {
    schemaVersion: 1,
    id: String(value.id),
    version: Number(value.version),
    worldTemplateId: String(value.world_template_id),
    displayName: String(value.display_name),
    role: String(value.role),
    summary: String(value.summary),
    persona: String(value.persona),
    requestedSkills: parseJson<string[]>(value.requested_skills_json),
    requestedCapabilities: parseJson<string[]>(value.requested_capabilities_json),
    createdAt: String(value.created_at),
  }
  if (typeof value.embodiment_json === 'string') {
    blueprint.embodiment = parseJson<NonNullable<EmployeeBlueprint['embodiment']>>(value.embodiment_json)
  }
  return blueprint
}

function mapEmployee(row: object): EmployeeInstance {
  const value = row as Record<string, unknown>
  const persistedStatus = value.status as EmployeeStatus
  const employee: EmployeeInstance = {
    id: String(value.id),
    workspaceId: String(value.workspace_id),
    worldId: String(value.world_id),
    blueprintId: String(value.blueprint_id),
    blueprintVersion: Number(value.blueprint_version),
    displayName: String(value.display_name),
    role: String(value.role),
    presence: persistedStatus === 'working' ? 'working' : 'available',
    health: (typeof value.health === 'string' ? value.health : persistedStatus === 'blocked' ? 'degraded' : 'healthy') as EmployeeHealth,
    status: persistedStatus,
    currentRevision: Number(value.current_revision),
    createdAt: String(value.created_at),
    updatedAt: String(value.updated_at),
  }
  if (typeof value.health_error_code === 'string') employee.healthErrorCode = value.health_error_code
  if (typeof value.health_detail === 'string') employee.healthDetail = value.health_detail
  if (typeof value.agent_session_id === 'string') employee.agentSessionId = value.agent_session_id
  if (typeof value.archived_at === 'string') employee.archivedAt = value.archived_at
  return employee
}

function mapRevision(row: object): EmployeeRevision {
  const value = row as Record<string, unknown>
  return {
    employeeId: String(value.employee_id),
    revision: Number(value.revision),
    persona: String(value.persona),
    skillGrants: parseJson<string[]>(value.skill_grants_json),
    capabilityGrants: parseJson<string[]>(value.capability_grants_json),
    modelPolicy: parseJson<JsonObject>(value.model_policy_json),
    runtimePermissionMode: (typeof value.runtime_permission_mode === 'string' ? value.runtime_permission_mode : 'read-only') as AgentPermissionMode,
    reason: String(value.reason),
    createdAt: String(value.created_at),
  }
}

function mapEmployeeProfile(row: object): EmployeeProfile {
  const value = row as Record<string, unknown>
  const profile: EmployeeProfile = {
    employeeId: String(value.employee_id),
    revision: Number(value.revision),
    gender: normalizeCharacterGender(value.gender),
    voiceProfile: normalizeEmployeeVoiceProfile(
      typeof value.voice_profile_json === 'string'
        ? parseJson<EmployeeVoiceProfile>(value.voice_profile_json)
        : undefined,
    ),
    background: String(value.background),
    personalityTraits: parseJson<string[]>(value.personality_traits_json),
    appearance: parseJson<JsonObject>(value.appearance_json),
    reason: String(value.reason),
    createdAt: String(value.created_at),
  }
  if (typeof value.birthday === 'string') profile.birthday = value.birthday
  return profile
}

function defaultEmployeeVoiceProfile(): EmployeeVoiceProfile {
  return { provider: 'auto', voiceId: '', speed: 1.1, pitch: 1 }
}

function normalizeCharacterGender(value: unknown): CharacterGender {
  return value === 'female' || value === 'male' ? value : 'neutral'
}

function normalizeEmployeeVoiceProfile(value: EmployeeVoiceProfile | undefined): EmployeeVoiceProfile {
  if (value === undefined) return defaultEmployeeVoiceProfile()
  const provider = ['auto', 'system', 'kokoro', 'moss', 'qwen-tts', 'dots-tts', 'cosyvoice'].includes(value.provider)
    ? value.provider
    : 'auto'
  const voiceId = typeof value.voiceId === 'string' && value.voiceId.length <= 240 ? value.voiceId : ''
  const speed = Number.isFinite(value.speed) ? Math.min(1.3, Math.max(0.8, Math.round(value.speed * 20) / 20)) : 1.1
  const pitch = Number.isFinite(value.pitch) ? Math.min(1.2, Math.max(0.8, Math.round(value.pitch * 20) / 20)) : 1
  return { provider, voiceId, speed, pitch }
}

function mapSkillEvidence(row: object): SkillEvidence {
  const value = row as Record<string, unknown>
  return {
    id: String(value.id),
    workspaceId: String(value.workspace_id),
    worldId: String(value.world_id),
    employeeId: String(value.employee_id),
    skillId: String(value.skill_id),
    kind: value.kind as SkillEvidenceKind,
    outcome: value.outcome as SkillEvidenceOutcome,
    summary: String(value.summary),
    sourceEventIds: parseJson<string[]>(value.source_event_ids_json),
    sourceMessageIds: parseJson<string[]>(value.source_message_ids_json),
    artifactRefs: parseJson<string[]>(value.artifact_refs_json),
    createdAt: String(value.created_at),
  }
}

function mapEmployeeSkill(row: object): EmployeeSkill {
  const value = row as Record<string, unknown>
  return {
    employeeId: String(value.employee_id),
    skillId: String(value.skill_id),
    revision: Number(value.revision),
    status: value.status as EmployeeSkillStatus,
    evidenceIds: parseJson<string[]>(value.evidence_ids_json),
    reason: String(value.reason),
    createdAt: String(value.created_at),
  }
}

function mapEmployeeMilestone(row: object): EmployeeMilestone {
  const value = row as Record<string, unknown>
  return {
    id: String(value.id),
    workspaceId: String(value.workspace_id),
    worldId: String(value.world_id),
    employeeId: String(value.employee_id),
    category: value.category as EmployeeMilestoneCategory,
    title: String(value.title),
    summary: String(value.summary),
    sourceEventIds: parseJson<string[]>(value.source_event_ids_json),
    sourceMessageIds: parseJson<string[]>(value.source_message_ids_json),
    artifactRefs: parseJson<string[]>(value.artifact_refs_json),
    occurredAt: String(value.occurred_at),
    createdAt: String(value.created_at),
  }
}

function mapEmployeeJournal(row: object): EmployeeDailyJournal {
  const value = row as Record<string, unknown>
  return {
    employeeId: String(value.employee_id),
    localDate: String(value.local_date),
    revision: Number(value.revision),
    summary: String(value.summary),
    highlights: parseJson<string[]>(value.highlights_json),
    sourceEventIds: parseJson<string[]>(value.source_event_ids_json),
    sourceMessageIds: parseJson<string[]>(value.source_message_ids_json),
    createdAt: String(value.created_at),
  }
}

function mapEmployeeRelationship(row: object): EmployeeRelationship {
  const value = row as Record<string, unknown>
  return {
    employeeId: String(value.employee_id),
    colleagueId: String(value.colleague_id),
    collaborationCount: Number(value.collaboration_count),
    reviewCount: Number(value.review_count),
    handoffCount: Number(value.handoff_count),
    lastInteractionAt: String(value.last_interaction_at),
    updatedAt: String(value.updated_at),
  }
}

function mapWorkspacePreferences(row: object): WorkspacePreferences {
  const value = row as Record<string, unknown>
  const preferences: WorkspacePreferences = {
    workspaceId: String(value.workspace_id),
    locale: (typeof value.locale === 'string' ? value.locale : 'zh-CN') as WorkspacePreferences['locale'],
    colorScheme: value.color_scheme as WorkspacePreferences['colorScheme'],
    skinId: String(value.skin_id),
    backgroundFit: value.background_fit as WorkspacePreferences['backgroundFit'],
    backgroundOpacity: Number(value.background_opacity),
    interfaceDensity: value.interface_density as WorkspacePreferences['interfaceDensity'],
    motion: value.motion as WorkspacePreferences['motion'],
    leftPaneWidth: Number(value.left_pane_width),
    rightPaneWidth: Number(value.right_pane_width),
    updatedAt: String(value.updated_at),
  }
  if (typeof value.background_asset_ref === 'string') {
    preferences.backgroundAssetRef = value.background_asset_ref
  }
  return preferences
}

function mapModelProfile(row: object): ModelProfile {
  const value = row as Record<string, unknown>
  const profile: ModelProfile = {
    id: String(value.id),
    workspaceId: String(value.workspace_id),
    displayName: String(value.display_name),
    providerKind: value.provider_kind as ModelProviderKind,
    baseUrl: String(value.base_url),
    modelId: String(value.model_id),
    api: value.api as ModelApiKind,
    isDefault: Number(value.is_default) === 1,
    settings: parseJson<JsonObject>(value.settings_json),
    createdAt: String(value.created_at),
    updatedAt: String(value.updated_at),
  }
  if (typeof value.credential_env_name === 'string') {
    profile.credentialEnvName = value.credential_env_name
  }
  return profile
}

function mapModelAssignment(row: object): ModelAssignment {
  const value = row as Record<string, unknown>
  return {
    workspaceId: String(value.workspace_id),
    scope: value.scope as ModelAssignmentScope,
    scopeId: String(value.scope_id),
    modelProfileId: String(value.model_profile_id),
    updatedAt: String(value.updated_at),
  }
}

function mapLocalAsset(row: object): LocalAsset {
  const value = row as Record<string, unknown>
  return {
    id: String(value.id),
    workspaceId: String(value.workspace_id),
    kind: value.kind as LocalAssetKind,
    mimeType: value.mime_type as LocalAsset['mimeType'],
    sha256: String(value.sha256),
    relativePath: String(value.relative_path),
    byteLength: Number(value.byte_length),
    createdAt: String(value.created_at),
  }
}

function mapCharacterAvatarAsset(row: object): CharacterAvatarAsset {
  const value = row as Record<string, unknown>
  return {
    assetId: String(value.asset_id),
    workspaceId: String(value.workspace_id),
    worldId: String(value.world_id),
    employeeId: String(value.employee_id),
    rendererKind: value.renderer_kind as CharacterAvatarAssetRendererKind,
    originalName: String(value.original_name),
    validation: parseJson<JsonObject>(value.validation_json),
    createdAt: String(value.created_at),
  }
}

function mapModelInteractionLog(row: object): ModelInteractionLog {
  const value = row as Record<string, unknown>
  const log: ModelInteractionLog = {
    id: String(value.id),
    workspaceId: String(value.workspace_id),
    source: value.source as ModelInteractionLogSource,
    modelId: String(value.model_id),
    provider: String(value.provider),
    status: value.status as ModelInteractionLogStatus,
    promptMessageCount: Number(value.prompt_message_count),
    promptCharCount: Number(value.prompt_char_count),
    durationMs: Number(value.duration_ms),
    createdAt: String(value.created_at),
  }
  if (typeof value.world_id === 'string') log.worldId = value.world_id
  if (typeof value.session_id === 'string') log.sessionId = value.session_id
  if (typeof value.employee_id === 'string') log.employeeId = value.employee_id
  if (typeof value.work_turn_id === 'string') log.workTurnId = value.work_turn_id
  if (typeof value.agent_run_id === 'string') log.agentRunId = value.agent_run_id
  if (typeof value.error_code === 'string') log.errorCode = value.error_code
  if (typeof value.error_message === 'string') log.errorMessage = value.error_message
  if (value.http_status !== null && value.http_status !== undefined) {
    log.httpStatus = Number(value.http_status)
  }
  if (value.response_char_count !== null && value.response_char_count !== undefined) {
    log.responseCharCount = Number(value.response_char_count)
  }
  if (value.tool_call_count !== null && value.tool_call_count !== undefined) {
    log.toolCallCount = Number(value.tool_call_count)
  }
  if (value.tokens_prompt !== null && value.tokens_prompt !== undefined) {
    log.tokensPrompt = Number(value.tokens_prompt)
  }
  if (value.tokens_completion !== null && value.tokens_completion !== undefined) {
    log.tokensCompletion = Number(value.tokens_completion)
  }
  if (value.tokens_total !== null && value.tokens_total !== undefined) {
    log.tokensTotal = Number(value.tokens_total)
  }
  return log
}

function mapSession(row: object): WorkSession {
  const value = row as Record<string, unknown>
  return {
    id: String(value.id),
    workspaceId: String(value.workspace_id),
    worldId: String(value.world_id),
    kind: value.kind as WorkSession['kind'],
    collaborationMode: value.collaboration_mode === 'task' ? 'task' : 'discussion',
    title: String(value.title),
    status: value.status as WorkSession['status'],
    createdAt: String(value.created_at),
    updatedAt: String(value.updated_at),
  }
}

function mapWorkTurn(row: object): WorkTurn {
  const value = row as Record<string, unknown>
  const turn: WorkTurn = {
    id: String(value.id), workspaceId: String(value.workspace_id), worldId: String(value.world_id),
    sessionId: String(value.session_id), interactionKind: value.interaction_kind as WorkTurn['interactionKind'],
    status: value.status as WorkTurn['status'], createdAt: String(value.created_at),
  }
  if (typeof value.client_turn_id === 'string') turn.clientTurnId = value.client_turn_id
  if (typeof value.error_code === 'string') turn.errorCode = value.error_code
  if (typeof value.started_at === 'string') turn.startedAt = value.started_at
  if (typeof value.completed_at === 'string') turn.completedAt = value.completed_at
  return turn
}

function mapConversationQueueEntry(row: object): ConversationQueueEntry {
  const value = row as Record<string, unknown>
  const entry: ConversationQueueEntry = {
    id: String(value.id),
    workspaceId: String(value.workspace_id),
    worldId: String(value.world_id),
    sessionId: String(value.session_id),
    workTurnId: String(value.work_turn_id),
    employeeIds: parseJson<string[]>(value.employee_ids_json),
    conversationKind: value.conversation_kind as ConversationQueueEntry['conversationKind'],
    collaborationMode: value.collaboration_mode === 'task' ? 'task' : 'discussion',
    priority: Number(value.priority),
    revision: Number(value.revision),
    status: value.status as ConversationQueueEntryStatus,
    attemptCount: Number(value.attempt_count ?? 0),
    availableAt: typeof value.available_at === 'string' ? value.available_at : String(value.enqueued_at),
    enqueuedAt: String(value.enqueued_at),
    updatedAt: String(value.updated_at),
  }
  if (typeof value.reasoning_effort === 'string') entry.reasoningEffort = value.reasoning_effort as Exclude<ReasoningEffort, 'auto'>
  if (typeof value.permission_mode === 'string') entry.permissionMode = value.permission_mode as AgentPermissionMode
  if (typeof value.error_code === 'string') entry.errorCode = value.error_code
  if (typeof value.lease_owner === 'string') entry.leaseOwner = value.lease_owner
  if (typeof value.lease_expires_at === 'string') entry.leaseExpiresAt = value.lease_expires_at
  if (typeof value.claimed_at === 'string') entry.claimedAt = value.claimed_at
  if (typeof value.completed_at === 'string') entry.completedAt = value.completed_at
  return entry
}

function mapAgentRun(row: object): AgentRun {
  const value = row as Record<string, unknown>
  const run: AgentRun = {
    id: String(value.id), workspaceId: String(value.workspace_id), worldId: String(value.world_id),
    turnId: String(value.turn_id), sessionId: String(value.session_id), employeeId: String(value.employee_id),
    ordinal: Number(value.ordinal), status: value.status as AgentRun['status'], createdAt: String(value.created_at),
  }
  if (typeof value.runtime_session_id === 'string') run.runtimeSessionId = value.runtime_session_id
  if (typeof value.error_code === 'string') run.errorCode = value.error_code
  if (typeof value.started_at === 'string') run.startedAt = value.started_at
  if (typeof value.completed_at === 'string') run.completedAt = value.completed_at
  return run
}

function mapSkillAction(row: object): CharacterSkillAction {
  const value = row as Record<string, unknown>
  const action: CharacterSkillAction = {
    id: String(value.id),
    worldId: String(value.world_id),
    characterId: String(value.character_id),
    skillId: String(value.skill_id),
    adapterId: String(value.adapter_id),
    action: String(value.action),
    target: String(value.target),
    label: String(value.label),
    risk: value.risk as CharacterSkillAction['risk'],
    authorization: value.authorization as CharacterSkillAction['authorization'],
    parameters: parseJson<CharacterSkillAction['parameters']>(value.parameters_json),
    status: value.status as CharacterSkillAction['status'],
    detail: String(value.detail),
    createdAt: String(value.created_at),
    updatedAt: String(value.updated_at),
  }
  if (typeof value.scheduled_for === 'string') action.scheduledFor = value.scheduled_for
  if (typeof value.approval_request_id === 'string') action.approvalRequestId = value.approval_request_id
  if (typeof value.work_turn_id === 'string') action.workTurnId = value.work_turn_id
  if (typeof value.agent_run_id === 'string') action.agentRunId = value.agent_run_id
  if (typeof value.execution_state === 'string') action.executionState = value.execution_state as NonNullable<CharacterSkillAction['executionState']>
  if (typeof value.execution_attempt_id === 'string') action.executionAttemptId = value.execution_attempt_id
  if (typeof value.execution_started_at === 'string') action.executionStartedAt = value.execution_started_at
  if (typeof value.execution_completed_at === 'string') action.executionCompletedAt = value.execution_completed_at
  if (value.authorization_source === 'skill-grant' || value.authorization_source === 'world-authority') {
    action.authorizationSource = value.authorization_source
  }
  if (typeof value.required_world_permission === 'string' && isWorldCharacterPermission(value.required_world_permission)) {
    action.requiredWorldPermission = value.required_world_permission
  }
  return action
}

function mapApprovalRequest(row: object): ApprovalRequest {
  const value = row as Record<string, unknown>
  const request: ApprovalRequest = {
    id: String(value.id), workspaceId: String(value.workspace_id), worldId: String(value.world_id),
    subjectType: value.subject_type as ApprovalSubjectType, subjectId: String(value.subject_id),
    risk: value.risk as ApprovalRisk, summary: String(value.summary),
    status: value.status as ApprovalStatus, scope: value.scope as ApprovalScope,
    createdAt: String(value.created_at), expiresAt: String(value.expires_at),
  }
  if (typeof value.session_id === 'string') request.sessionId = value.session_id
  if (typeof value.work_turn_id === 'string') request.workTurnId = value.work_turn_id
  if (typeof value.agent_run_id === 'string') request.agentRunId = value.agent_run_id
  if (typeof value.character_id === 'string') request.characterId = value.character_id
  if (typeof value.decided_at === 'string') request.decidedAt = value.decided_at
  if (typeof value.decided_by === 'string') request.decidedBy = value.decided_by
  return request
}

function mapApprovalPolicy(row: object): ApprovalPolicy {
  const value = row as Record<string, unknown>
  const policy: ApprovalPolicy = {
    id: String(value.id), workspaceId: String(value.workspace_id), worldId: String(value.world_id),
    subjectType: value.subject_type as ApprovalSubjectType, action: String(value.action),
    target: String(value.target), risk: value.risk as ApprovalRisk,
    scope: value.scope as ApprovalPolicy['scope'], sourceApprovalId: String(value.source_approval_id),
    createdAt: String(value.created_at),
  }
  if (typeof value.character_id === 'string') policy.characterId = value.character_id
  if (typeof value.skill_id === 'string') policy.skillId = value.skill_id
  if (typeof value.revoked_at === 'string') policy.revokedAt = value.revoked_at
  return policy
}

function mapParticipant(row: object): WorkSessionParticipant {
  const value = row as Record<string, unknown>
  return {
    sessionId: String(value.session_id),
    participantId: String(value.participant_id),
    kind: value.kind as ParticipantKind,
    joinedAt: String(value.joined_at),
  }
}

function mapOwnerRuntimeAccessGrant(row: object): OwnerRuntimeAccessGrant {
  const value = row as Record<string, unknown>
  return {
    id: String(value.id),
    worldId: String(value.world_id),
    sessionId: String(value.session_id),
    employeeIds: parseJson<string[]>(value.employee_ids_json),
    createdAt: String(value.created_at),
    updatedAt: String(value.updated_at),
  }
}

function clampMessagePageSize(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 20
  return Math.min(100, Math.max(1, Math.floor(value)))
}

function escapeMessageSearch(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`)
}

function mapMessage(row: object): WorkMessage {
  const value = row as Record<string, unknown>
  return {
    id: String(value.id),
    sessionId: String(value.session_id),
    sequence: Number(value.sequence),
    senderId: String(value.sender_id),
    senderKind: value.sender_kind as ParticipantKind,
    kind: value.kind as WorkMessage['kind'],
    content: String(value.content),
    metadata: parseJson<JsonObject>(value.metadata_json),
    createdAt: String(value.created_at),
  }
}

function mapInstalledPackage(row: object): InstalledPackage {
  const value = row as Record<string, unknown>
  return {
    workspaceId: String(value.workspace_id),
    packageId: String(value.package_id),
    version: String(value.version),
    kind: value.kind as InstalledPackage['kind'],
    status: value.status as InstalledPackage['status'],
    installedPath: String(value.installed_path),
    capabilities: parseJson<string[]>(value.capabilities_json),
    manifest: parseJson<CyberPackageManifest>(value.manifest_json),
    installedAt: String(value.installed_at),
    updatedAt: String(value.updated_at),
  }
}

function mapWorldPackageInstance(row: object): WorldPackageInstance {
  const value = row as Record<string, unknown>
  return {
    id: String(value.id), workspaceId: String(value.workspace_id), worldId: String(value.world_id),
    packageId: String(value.package_id), packageVersion: String(value.package_version),
    packageKind: value.package_kind as WorldPackageInstance['packageKind'],
    contentDigest: String(value.content_digest), status: value.status as WorldPackageInstance['status'],
    originPath: String(value.origin_path), overridesPath: String(value.overrides_path),
    createdAt: String(value.created_at), updatedAt: String(value.updated_at),
  }
}

function mapPackageInstallTransaction(row: object): PackageInstallTransaction {
  const value = row as Record<string, unknown>
  const transaction: PackageInstallTransaction = {
    id: String(value.id),
    workspaceId: String(value.workspace_id),
    packageId: String(value.package_id),
    version: String(value.version),
    status: value.status as PackageInstallTransaction['status'],
    approvedCapabilities: parseJson<string[]>(value.approved_capabilities_json),
    createdAt: String(value.created_at),
    updatedAt: String(value.updated_at),
  }
  if (typeof value.previous_version === 'string') {
    transaction.previousVersion = value.previous_version
  }
  if (typeof value.error_code === 'string') transaction.errorCode = value.error_code
  return transaction
}

function mapRuntimeUpdateTransaction(row: object): RuntimeUpdateTransaction {
  const value = row as Record<string, unknown>
  const transaction: RuntimeUpdateTransaction = {
    id: String(value.id),
    candidateRoot: String(value.candidate_root),
    version: String(value.version),
    contractId: String(value.contract_id),
    status: value.status as RuntimeUpdateStatus,
    report: parseJson<JsonObject>(value.report_json),
    createdAt: String(value.created_at),
    updatedAt: String(value.updated_at),
  }
  if (typeof value.previous_runtime_root === 'string') {
    transaction.previousRuntimeRoot = value.previous_runtime_root
  }
  if (typeof value.error_code === 'string') transaction.errorCode = value.error_code
  return transaction
}

function mapDomainEvent(row: object): DomainEvent {
  const value = row as Record<string, unknown>
  const event: DomainEvent = {
    id: String(value.event_id),
    workspaceId: String(value.workspace_id),
    sequence: Number(value.sequence),
    type: value.type as DomainEventType,
    actorId: String(value.actor_id),
    actorKind: value.actor_kind as ParticipantKind,
    payload: parseJson<JsonObject>(value.payload_json),
    createdAt: String(value.created_at),
  }
  if (typeof value.session_id === 'string') event.sessionId = value.session_id
  if (typeof value.world_id === 'string') event.worldId = value.world_id
  if (typeof value.causation_id === 'string') event.causationId = value.causation_id
  if (typeof value.correlation_id === 'string') event.correlationId = value.correlation_id
  return event
}

function recommendedAdminPermissions() {
  return [...RECOMMENDED_ADMIN_PERMISSIONS]
}

function sameAuthority(
  left: ReturnType<WorldCharacterAuthorityRepository['get']>,
  right: ReturnType<WorldCharacterAuthorityRepository['get']>,
): boolean {
  if (left === undefined || right === undefined) return left === right
  return left.role === right.role && left.updatedAt === right.updatedAt &&
    left.permissionGrants.length === right.permissionGrants.length &&
    left.permissionGrants.every((permission, index) => permission === right.permissionGrants[index])
}

interface NormalizedTaskStep {
  id: string
  ordinal: number
  requiredSkills: string[]
  assignedEmployeeIds: string[]
  dependsOn: string[]
  executionMode: TaskCollaborationExecutionMode
  status: TaskCollaborationStepStatus
  errorCode?: string
}

function normalizeTaskSteps(
  inputs: TaskCollaborationStepInput[],
  idFactory: () => string,
): NormalizedTaskStep[] {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new PersistenceError('Task collaboration plan requires at least one step')
  }
  const ids = new Set<string>()
  return inputs.map((input, ordinal) => {
    const id = normalizeOptionalId(input.id, idFactory)
    if (ids.has(id)) throw new PersistenceError(`Task collaboration step id is duplicated: ${id}`)
    ids.add(id)
    const step: NormalizedTaskStep = {
      id,
      ordinal: ordinal + 1,
      requiredSkills: normalizeStringList(input.requiredSkills, 'required skills'),
      assignedEmployeeIds: normalizeStringList(input.assignedEmployeeIds, 'assigned employee ids'),
      dependsOn: normalizeStringList(input.dependsOn, 'step dependencies'),
      executionMode: validateTaskExecutionMode(input.executionMode),
      status: validateTaskStepStatus(input.status ?? 'pending'),
    }
    const errorCode = normalizeOptionalError(input.errorCode)
    if (errorCode !== undefined) step.errorCode = errorCode
    return step
  })
}

function taskStepFromNormalized(step: NormalizedTaskStep, planId: string, now: string, createdAt = now): TaskCollaborationStep {
  const result: TaskCollaborationStep = {
    id: step.id,
    planId,
    ordinal: step.ordinal,
    requiredSkills: [...step.requiredSkills],
    assignedEmployeeIds: [...step.assignedEmployeeIds],
    dependsOn: [...step.dependsOn],
    executionMode: step.executionMode,
    status: step.status,
    createdAt,
    updatedAt: now,
  }
  if (step.errorCode !== undefined) result.errorCode = step.errorCode
  return result
}

function taskStepToInput(step: TaskCollaborationStep): TaskCollaborationStepInput {
  return {
    id: step.id,
    requiredSkills: [...step.requiredSkills],
    assignedEmployeeIds: [...step.assignedEmployeeIds],
    dependsOn: [...step.dependsOn],
    executionMode: step.executionMode,
    status: step.status,
    ...(step.errorCode === undefined ? {} : { errorCode: step.errorCode }),
  }
}

function assertTaskStepGraph(steps: NormalizedTaskStep[]): void {
  const ids = new Set(steps.map((step) => step.id))
  for (const step of steps) {
    if (step.dependsOn.includes(step.id)) throw new PersistenceError(`Task collaboration step cannot depend on itself: ${step.id}`)
    for (const dependency of step.dependsOn) {
      if (!ids.has(dependency)) throw new PersistenceError(`Task collaboration step dependency is missing: ${dependency}`)
    }
  }
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const byId = new Map(steps.map((step) => [step.id, step]))
  const visit = (id: string): void => {
    if (visited.has(id)) return
    if (visiting.has(id)) throw new PersistenceError('Task collaboration step dependencies contain a cycle')
    visiting.add(id)
    for (const dependency of byId.get(id)!.dependsOn) visit(dependency)
    visiting.delete(id)
    visited.add(id)
  }
  for (const step of steps) visit(step.id)
}

function normalizeStringList(values: string[], label: string): string[] {
  if (!Array.isArray(values)) throw new PersistenceError(`Task collaboration ${label} must be an array`)
  const normalized = values.map((value) => {
    if (typeof value !== 'string') throw new PersistenceError(`Task collaboration ${label} must contain strings`)
    return normalizeRequiredToken(value, `Task collaboration ${label} item`, 160)
  })
  if (new Set(normalized).size !== normalized.length) throw new PersistenceError(`Task collaboration ${label} must be unique`)
  return normalized
}

type NormalizedConversationQueueMetadata = {
  workspaceId: string
  worldId: string
  sessionId: string
  workTurnId: string
  employeeIds: string[]
  conversationKind: WorkSessionKind
  collaborationMode: WorkSessionCollaborationMode
  reasoningEffort?: Exclude<ReasoningEffort, 'auto'>
  permissionMode?: AgentPermissionMode
  priority: number
}

function normalizeQueueEmployeeIds(values: string[]): string[] {
  if (!Array.isArray(values) || values.length === 0) {
    throw new PersistenceError('Conversation queue requires at least one employee')
  }
  const normalized = values.map((value) => {
    if (typeof value !== 'string') throw new PersistenceError('Conversation queue employee id is invalid')
    return normalizeRequiredToken(value, 'Conversation queue employee id', 160)
  })
  if (new Set(normalized).size !== normalized.length) {
    throw new PersistenceError('Conversation queue employee ids must be unique')
  }
  return normalized
}

function validateQueuePriority(value: number): number {
  if (!Number.isSafeInteger(value) || value < -1_000_000_000 || value > 1_000_000_000) {
    throw new PersistenceError('Conversation queue priority is invalid')
  }
  return value
}

function validateQueueReasoningEffort(value: Exclude<ReasoningEffort, 'auto'>): Exclude<ReasoningEffort, 'auto'> {
  if (!['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value)) {
    throw new PersistenceError('Conversation queue reasoning effort is invalid')
  }
  return value
}

function validateQueuePermissionMode(value: AgentPermissionMode): AgentPermissionMode {
  if (!['read-only', 'workspace-write', 'danger-full-access'].includes(value)) {
    throw new PersistenceError('Conversation queue permission mode is invalid')
  }
  return value
}

function normalizeQueueErrorCode(value: string): string {
  return normalizeRequiredToken(value, 'Conversation queue error code', 160)
}

function sameConversationQueueMetadata(
  existing: ConversationQueueEntry,
  input: NormalizedConversationQueueMetadata,
): boolean {
  return existing.workspaceId === input.workspaceId &&
    existing.worldId === input.worldId &&
    existing.sessionId === input.sessionId &&
    existing.workTurnId === input.workTurnId &&
    existing.conversationKind === input.conversationKind &&
    (existing.collaborationMode ?? 'discussion') === input.collaborationMode &&
    (existing.reasoningEffort ?? undefined) === input.reasoningEffort &&
    (existing.permissionMode ?? undefined) === input.permissionMode &&
    existing.priority === input.priority &&
    existing.employeeIds.length === input.employeeIds.length &&
    existing.employeeIds.every((employeeId, index) => employeeId === input.employeeIds[index])
}

function normalizeRequiredToken(value: string, label: string, maximum: number): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new PersistenceError(`${label} is invalid`)
  }
  return normalized
}

function normalizeOptionalId(value: string | undefined, idFactory: () => string): string {
  return normalizeRequiredToken(value ?? idFactory(), 'Task collaboration id', 160)
}

function normalizeOptionalError(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined
  const normalized = value.trim()
  if (!normalized || normalized.length > 160 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new PersistenceError('Task collaboration error code is invalid')
  }
  return normalized
}

function validateTaskPlanStatus(value: TaskCollaborationPlanStatus): TaskCollaborationPlanStatus {
  if (!['planned', 'running', 'completed', 'failed', 'interrupted', 'cancelled'].includes(value)) {
    throw new PersistenceError(`Task collaboration plan status is invalid: ${value}`)
  }
  return value
}

function validateTaskStepStatus(value: TaskCollaborationStepStatus): TaskCollaborationStepStatus {
  if (!['pending', 'ready', 'running', 'completed', 'failed', 'blocked', 'interrupted', 'cancelled'].includes(value)) {
    throw new PersistenceError(`Task collaboration step status is invalid: ${value}`)
  }
  return value
}

function validateTaskExecutionMode(value: TaskCollaborationExecutionMode): TaskCollaborationExecutionMode {
  if (value !== 'parallel' && value !== 'sequential') {
    throw new PersistenceError(`Task collaboration execution mode is invalid: ${value}`)
  }
  return value
}

function assertTaskPlanTransition(from: TaskCollaborationPlanStatus, to: TaskCollaborationPlanStatus): void {
  if (from === to) return
  const allowed: Record<TaskCollaborationPlanStatus, readonly TaskCollaborationPlanStatus[]> = {
    planned: ['running', 'cancelled', 'interrupted'],
    running: ['completed', 'failed', 'interrupted', 'cancelled'],
    completed: [],
    failed: [],
    interrupted: [],
    cancelled: [],
  }
  if (!allowed[from].includes(to)) throw new PersistenceError(`Illegal task collaboration plan transition: ${from} -> ${to}`)
}

function isTerminalTaskPlanStatus(value: TaskCollaborationPlanStatus): boolean {
  return value === 'completed' || value === 'failed' || value === 'interrupted' || value === 'cancelled'
}

function assertTerminalTaskPlanSteps(status: TaskCollaborationPlanStatus, steps: readonly NormalizedTaskStep[]): void {
  if (!isTerminalTaskPlanStatus(status)) return
  if (steps.some((step) => step.status === 'pending' || step.status === 'ready' || step.status === 'running')) {
    throw new PersistenceError('Terminal task collaboration plan cannot contain unfinished steps')
  }
}

function assertTaskStepTransition(from: TaskCollaborationStepStatus, to: TaskCollaborationStepStatus): void {
  if (from === to) return
  const allowed: Record<TaskCollaborationStepStatus, readonly TaskCollaborationStepStatus[]> = {
    pending: ['ready', 'running', 'blocked', 'interrupted', 'cancelled'],
    ready: ['running', 'blocked', 'interrupted', 'cancelled'],
    running: ['completed', 'failed', 'blocked', 'interrupted', 'cancelled'],
    blocked: ['ready', 'running', 'interrupted', 'cancelled'],
    completed: [],
    failed: [],
    interrupted: [],
    cancelled: [],
  }
  if (!allowed[from].includes(to)) throw new PersistenceError(`Illegal task collaboration step transition: ${from} -> ${to}`)
}

function validateSessionCollaborationMode(value: WorkSessionCollaborationMode): WorkSessionCollaborationMode {
  if (value !== 'discussion' && value !== 'task') throw new PersistenceError(`Session collaboration mode is invalid: ${value}`)
  return value
}

function mapTaskCollaborationStep(row: object): TaskCollaborationStep {
  const value = row as Record<string, unknown>
  const step: TaskCollaborationStep = {
    id: String(value.id),
    planId: String(value.plan_id),
    ordinal: Number(value.ordinal),
    requiredSkills: parseJson<string[]>(value.required_skills_json),
    assignedEmployeeIds: parseJson<string[]>(value.assigned_employee_ids_json),
    dependsOn: parseJson<string[]>(value.depends_on_json),
    executionMode: value.execution_mode as TaskCollaborationExecutionMode,
    status: value.status as TaskCollaborationStepStatus,
    createdAt: String(value.created_at),
    updatedAt: String(value.updated_at),
  }
  if (typeof value.error_code === 'string') step.errorCode = value.error_code
  return step
}

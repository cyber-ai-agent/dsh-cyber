import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, open, rename, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { DatabaseSync, backup } from 'node:sqlite'

import {
  CYBER_SCHEMA_VERSION,
  RECOMMENDED_ADMIN_PERMISSIONS,
  isWorldCharacterPermission,
  isDomainEventType,
  type DatabaseDoctorReport,
  type DomainEvent,
  type DomainEventType,
  type EmployeeBlueprint,
  type EmployeeDailyJournal,
  type EmployeeDossier,
  type EmployeeInstance,
  type EmployeeMilestone,
  type EmployeeMilestoneCategory,
  type EmployeeProfile,
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
  type CyberPackageManifest,
  type InstalledPackage,
  type PackageInstallTransaction,
  type ParticipantKind,
  type RecordModelInteractionInput,
  type RuntimeUpdateStatus,
  type RuntimeUpdateTransaction,
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
  type WorkspaceSnapshot,
} from '@dsh-cyber/contracts'
import type { CharacterSkillAction } from '@dsh-cyber/contracts/skill-runtime'

import { DatabaseCorruptError, EntityNotFoundError, PersistenceError } from './errors.js'
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
  persona?: string
  skillGrants?: string[]
  capabilityGrants?: string[]
  modelPolicy?: JsonObject
  reason?: string
  actorId?: string
}

export interface ReviseEmployeeInput {
  employeeId: string
  persona?: string
  skillGrants?: string[]
  capabilityGrants?: string[]
  modelPolicy?: JsonObject
  reason: string
  actorId?: string
}

export interface ReviseEmployeeProfileInput {
  employeeId: string
  displayName?: string
  role?: string
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

export interface CreateSessionInput {
  workspaceId: string
  worldId: string
  kind: WorkSessionKind
  title: string
  participants?: Array<{ participantId: string; kind: ParticipantKind }>
  actorId?: string
}

export interface CreateWorkTurnInput {
  workspaceId: string
  worldId: string
  sessionId: string
  clientTurnId?: string
  interactionKind: WorkTurnInteractionKind
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
  'employee_daily_journals',
  'employee_relationships',
  'workspace_preferences',
  'model_profiles',
  'model_assignments',
  'local_assets',
  'work_sessions',
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
] as const

export class SqliteStore {
  readonly databasePath: string
  readonly readOnly: boolean
  readonly database: DatabaseSync
  readonly #clock: Clock
  readonly #idFactory: () => string
  readonly #worldAuthorities: WorldCharacterAuthorityRepository
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
      if (!readOnly) migrate(database, store.#clock)
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
    if (preferences.backgroundOpacity < 0 || preferences.backgroundOpacity > 1) {
      throw new PersistenceError('Background opacity must be between 0 and 1')
    }
    if (!Number.isInteger(preferences.leftPaneWidth) || preferences.leftPaneWidth < 220 || preferences.leftPaneWidth > 520) {
      throw new PersistenceError('Left pane width must be between 220 and 520 pixels')
    }
    if (!Number.isInteger(preferences.rightPaneWidth) || preferences.rightPaneWidth < 300 || preferences.rightPaneWidth > 1_440) {
      throw new PersistenceError('Right pane width must be between 300 and 760 pixels')
    }

    return this.#transaction(() => {
      this.database
        .prepare(
          `INSERT INTO workspace_preferences
           (workspace_id, color_scheme, skin_id, background_asset_ref, background_fit,
            background_opacity, interface_density, motion, left_pane_width, right_pane_width,
            updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (workspace_id) DO UPDATE SET
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
    if (profileId !== undefined) return this.getModelProfile(profileId)
    return this.listModelProfiles(workspaceId).find((profile) => profile.isDefault)
      ?? this.listModelProfiles(workspaceId)[0]
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
    if (input.source !== 'turn' && input.source !== 'discovery') {
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
      const updated = this.#worldAuthorities.save(input.authority)
      const activeEmployees = this.listEmployees(input.authority.worldId)
        .filter((employee) => employee.status !== 'archived')
      const activeAdmins = this.#worldAuthorities.listActive(input.authority.worldId)
        .filter((authority) => authority.role === 'administrator')
      if (activeEmployees.length > 0 && activeAdmins.length === 0) {
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
    assertSubset(initialSkillGrants, blueprint.requestedSkills, 'skill grant')
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
      reason: input.reason ?? 'recruited',
      createdAt: now,
    }

    return this.#transaction(() => {
      this.#insertEmployee(employee)
      this.#insertRevision(revision)
      const isFirstActiveCharacter = world.administratorEmployeeId === undefined
      this.#worldAuthorities.save({
        worldId: world.id,
        employeeId: employee.id,
        role: isFirstActiveCharacter ? 'administrator' : 'member',
        permissionGrants: isFirstActiveCharacter
          ? recommendedAdminPermissions()
          : ['world.files.read'],
        createdAt: now,
        updatedAt: now,
      })
      if (isFirstActiveCharacter) {
        this.database.prepare(
          'UPDATE worlds SET administrator_employee_id = ?, updated_at = ? WHERE id = ? AND administrator_employee_id IS NULL',
        ).run(employee.id, now, world.id)
      }
      this.database
        .prepare(
          `INSERT INTO employee_profile_revisions
           (employee_id, revision, birthday, background, personality_traits_json,
            appearance_json, reason, created_at)
           VALUES (?, 1, NULL, ?, '[]', '{}', 'recruited', ?)`,
        )
        .run(employee.id, blueprint.summary, now)
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
      assertSubset(input.skillGrants, blueprint.requestedSkills, 'skill grant')
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
    const employee = this.#requireEmployee(employeeId)
    if (status === 'archived') return this.archiveEmployee(employeeId, actorId)
    const now = this.#clock()
    this.database
      .prepare('UPDATE employee_instances SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, now, employee.id)
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
    return row ? mapEmployee(row) : undefined
  }

  listEmployees(worldId: string, includeArchived = false): EmployeeInstance[] {
    const sql = includeArchived
      ? 'SELECT * FROM employee_instances WHERE world_id = ? ORDER BY created_at, id'
      : `SELECT * FROM employee_instances
         WHERE world_id = ? AND status <> 'archived' ORDER BY created_at, id`
    return this.database.prepare(sql).all(worldId).map(mapEmployee)
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
    if (birthday !== undefined) assertBirthday(birthday)
    if (!displayName) throw new PersistenceError('Employee display name cannot be empty')
    if (displayName.length > 48) throw new PersistenceError('Employee display name is too long')
    if (!role) throw new PersistenceError('Character identity label cannot be empty')
    if (role.length > 100) throw new PersistenceError('Character identity label is too long')
    const profile: EmployeeProfile = {
      employeeId: employee.id,
      revision: (previous?.revision ?? 0) + 1,
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
           (employee_id, revision, birthday, background, personality_traits_json,
            appearance_json, reason, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          profile.employeeId,
          profile.revision,
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
           (id, workspace_id, world_id, kind, title, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          session.id,
          session.workspaceId,
          session.worldId,
          session.kind,
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
           SELECT id FROM agent_runs WHERE status IN ('queued', 'running')
         )`,
      ).run()
      const runs = this.database.prepare(
        `UPDATE agent_runs SET status = 'failed', error_code = 'service-restarted', completed_at = ?
         WHERE status IN ('queued', 'running')`,
      ).run(now)
      const turns = this.database.prepare(
        `UPDATE work_turns SET status = 'failed', error_code = 'service-restarted', completed_at = ?
         WHERE status IN ('queued', 'running')`,
      ).run(now)
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

  appendMessage(input: AppendMessageInput): WorkMessage {
    this.#assertWritable()
    const session = this.#requireSession(input.sessionId)
    const now = this.#clock()

    return this.#transaction(() => {
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
      this.database
        .prepare(
          `INSERT INTO messages
           (id, session_id, sequence, sender_id, sender_kind, kind, content, metadata_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          message.id,
          message.sessionId,
          message.sequence,
          message.senderId,
          message.senderKind,
          message.kind,
          message.content,
          stringifyJson(message.metadata),
          message.createdAt,
        )
      this.database
        .prepare('UPDATE work_sessions SET updated_at = ? WHERE id = ?')
        .run(now, session.id)
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
    })
  }

  listMessages(sessionId: string, afterSequence = 0): WorkMessage[] {
    return this.database
      .prepare(
        'SELECT * FROM messages WHERE session_id = ? AND sequence > ? ORDER BY sequence',
      )
      .all(sessionId, afterSequence)
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
    const now = this.#clock()
    const installed: InstalledPackage = {
      workspaceId: transaction.workspaceId,
      packageId: input.manifest.id,
      version: input.manifest.version,
      kind: input.manifest.kind,
      status: 'active',
      installedPath: resolve(input.installedPath),
      capabilities: [...transaction.approvedCapabilities],
      manifest: input.manifest,
      installedAt: now,
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
    const row = this.database
      .prepare('SELECT COALESCE(MAX(sequence), 0) AS last FROM domain_events WHERE world_id = ?')
      .get(worldId) as { last: number }
    return {
      workspace,
      world,
      employees: this.listEmployees(worldId),
      authorities: this.#worldAuthorities.list(worldId),
      openSessions: this.listSessions(worldId, 'open'),
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
    const schemaVersion = readUserVersion(this.database)
    if (schemaVersion !== CYBER_SCHEMA_VERSION) {
      errors.push(`Expected schema ${CYBER_SCHEMA_VERSION}, found ${schemaVersion}`)
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
        employeeJournals: countRows(this.database, 'employee_daily_journals'),
        employeeRelationships: countRows(this.database, 'employee_relationships'),
        workspacePreferences: countRows(this.database, 'workspace_preferences'),
        modelProfiles: countRows(this.database, 'model_profiles'),
        modelAssignments: countRows(this.database, 'model_assignments'),
        localAssets: countRows(this.database, 'local_assets'),
        sessions: countRows(this.database, 'work_sessions'),
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
          status, current_revision, agent_session_id, created_at, updated_at, archived_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        employee.currentRevision,
        employee.agentSessionId ?? null,
        employee.createdAt,
        employee.updatedAt,
        employee.archivedAt ?? null,
      )
  }

  #insertRevision(revision: EmployeeRevision): void {
    this.database
      .prepare(
        `INSERT INTO employee_revisions
         (employee_id, revision, persona, skill_grants_json, capability_grants_json,
          model_policy_json, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        revision.employeeId,
        revision.revision,
        revision.persona,
        stringifyJson(revision.skillGrants),
        stringifyJson(revision.capabilityGrants),
        stringifyJson(revision.modelPolicy),
        revision.reason,
        revision.createdAt,
      )
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

function parseJson<T>(value: unknown): T {
  return JSON.parse(String(value)) as T
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

function assertSubset(values: string[], allowedValues: string[], label: string): void {
  if (new Set(values).size !== values.length) throw new PersistenceError(`Employee ${label}s must be unique`)
  const allowed = new Set(allowedValues)
  const denied = values.find((value) => !allowed.has(value))
  if (denied !== undefined) throw new PersistenceError(`Employee ${label} is not requested by the blueprint: ${denied}`)
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
  const employee: EmployeeInstance = {
    id: String(value.id),
    workspaceId: String(value.workspace_id),
    worldId: String(value.world_id),
    blueprintId: String(value.blueprint_id),
    blueprintVersion: Number(value.blueprint_version),
    displayName: String(value.display_name),
    role: String(value.role),
    status: value.status as EmployeeStatus,
    currentRevision: Number(value.current_revision),
    createdAt: String(value.created_at),
    updatedAt: String(value.updated_at),
  }
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
    reason: String(value.reason),
    createdAt: String(value.created_at),
  }
}

function mapEmployeeProfile(row: object): EmployeeProfile {
  const value = row as Record<string, unknown>
  const profile: EmployeeProfile = {
    employeeId: String(value.employee_id),
    revision: Number(value.revision),
    background: String(value.background),
    personalityTraits: parseJson<string[]>(value.personality_traits_json),
    appearance: parseJson<JsonObject>(value.appearance_json),
    reason: String(value.reason),
    createdAt: String(value.created_at),
  }
  if (typeof value.birthday === 'string') profile.birthday = value.birthday
  return profile
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

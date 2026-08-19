import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, open, rename, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { DatabaseSync, backup } from 'node:sqlite'

import {
  CYBER_SCHEMA_VERSION,
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
  type ModelApiKind,
  type ModelProfile,
  type ModelProviderKind,
  type CyberPackageManifest,
  type InstalledPackage,
  type PackageInstallTransaction,
  type ParticipantKind,
  type SkillEvidence,
  type SkillEvidenceKind,
  type SkillEvidenceOutcome,
  type WorkMessage,
  type WorkSession,
  type WorkSessionKind,
  type WorkSessionParticipant,
  type World,
  type WorldSnapshot,
  type Workspace,
  type WorkspacePreferences,
  type WorkspaceSnapshot,
} from '@dsh-cyber/contracts'

import { DatabaseCorruptError, EntityNotFoundError, PersistenceError } from './errors.js'
import { migrate, readUserVersion } from './migrations.js'
import { assertSecretFree } from './secrets.js'

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

export interface RollbackPackageInstallInput {
  transactionId: string
  errorCode: string
  actorId?: string
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
  'local_assets',
  'work_sessions',
  'work_session_participants',
  'messages',
  'installed_packages',
  'package_install_transactions',
  'domain_events',
  'sync_outbox',
] as const

export class SqliteStore {
  readonly databasePath: string
  readonly readOnly: boolean
  readonly database: DatabaseSync
  readonly #clock: Clock
  readonly #idFactory: () => string
  #closed = false

  private constructor(databasePath: string, database: DatabaseSync, options: StoreOptions) {
    this.databasePath = databasePath
    this.database = database
    this.readOnly = options.readOnly ?? false
    this.#clock = options.clock ?? (() => new Date().toISOString())
    this.#idFactory = options.idFactory ?? randomUUID
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
      colorScheme: 'system',
      skinId: 'cyber-graphite',
      backgroundFit: 'cover',
      backgroundOpacity: 0.18,
      interfaceDensity: 'compact',
      motion: 'system',
      leftPaneWidth: 288,
      rightPaneWidth: 520,
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
    if (!Number.isInteger(preferences.rightPaneWidth) || preferences.rightPaneWidth < 300 || preferences.rightPaneWidth > 760) {
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
    if (credentialEnvName !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(credentialEnvName)) {
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

  listWorlds(workspaceId: string, includeArchived = false): World[] {
    const sql = includeArchived
      ? 'SELECT * FROM worlds WHERE workspace_id = ? ORDER BY created_at, id'
      : `SELECT * FROM worlds
         WHERE workspace_id = ? AND status <> 'archived' ORDER BY created_at, id`
    return this.database.prepare(sql).all(workspaceId).map(mapWorld)
  }

  saveBlueprint(blueprint: EmployeeBlueprint): EmployeeBlueprint {
    this.#assertWritable()
    if (blueprint.version < 1) throw new PersistenceError('Blueprint version must be positive')
    this.database
      .prepare(
        `INSERT INTO employee_blueprints (
           id, version, world_template_id, display_name, role, summary, persona,
           requested_skills_json, requested_capabilities_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id, version) DO UPDATE SET
           world_template_id = excluded.world_template_id,
           display_name = excluded.display_name,
           role = excluded.role,
           summary = excluded.summary,
           persona = excluded.persona,
           requested_skills_json = excluded.requested_skills_json,
           requested_capabilities_json = excluded.requested_capabilities_json`,
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
    if (blueprint.worldTemplateId !== world.templateId) {
      throw new PersistenceError(
        `Blueprint ${blueprint.id}@${blueprint.version} belongs to ${blueprint.worldTemplateId}, not ${world.templateId}`,
      )
    }
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
      skillGrants: input.skillGrants ?? [],
      capabilityGrants: input.capabilityGrants ?? [],
      modelPolicy: input.modelPolicy ?? {},
      reason: input.reason ?? 'recruited',
      createdAt: now,
    }

    return this.#transaction(() => {
      this.#insertEmployee(employee)
      this.#insertRevision(revision)
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
    if (birthday !== undefined) assertBirthday(birthday)
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
        payload: { employeeId: employee.id, revision: profile.revision, reason: profile.reason },
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
      openSessions: this.listSessions(worldId, 'open'),
      lastEventSequence: Number(row.last),
    }
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
       workspaces: this.listWorkspaces().map((workspace) => ({
         workspace,
         preferences: this.getWorkspacePreferences(workspace.id),
         modelProfiles: this.listModelProfiles(workspace.id),
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
        localAssets: countRows(this.database, 'local_assets'),
        sessions: countRows(this.database, 'work_sessions'),
        messages: countRows(this.database, 'messages'),
        installedPackages: countRows(this.database, 'installed_packages'),
        packageTransactions: countRows(this.database, 'package_install_transactions'),
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

function normalizeModelBaseUrl(value: string, providerKind: ModelProviderKind): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new PersistenceError('Model base URL is invalid')
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1'
  if (providerKind === 'openai-compatible-local' && (!loopback || url.protocol !== 'http:')) {
    throw new PersistenceError('Local model base URL must use loopback HTTP')
  }
  if (providerKind !== 'openai-compatible-local' && url.protocol !== 'https:') {
    throw new PersistenceError('Remote model base URL must use HTTPS')
  }
  url.username = ''
  url.password = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
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
  return {
    id: String(value.id),
    workspaceId: String(value.workspace_id),
    name: String(value.name),
    templateId: String(value.template_id),
    status: value.status as World['status'],
    createdAt: String(value.created_at),
    updatedAt: String(value.updated_at),
  }
}

function mapBlueprint(row: object): EmployeeBlueprint {
  const value = row as Record<string, unknown>
  return {
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

function mapParticipant(row: object): WorkSessionParticipant {
  const value = row as Record<string, unknown>
  return {
    sessionId: String(value.session_id),
    participantId: String(value.participant_id),
    kind: value.kind as ParticipantKind,
    joinedAt: String(value.joined_at),
  }
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

import type { DatabaseSync } from 'node:sqlite'

import { CYBER_SCHEMA_VERSION } from '@dsh-cyber/contracts'

import { DatabaseSchemaError } from './errors.js'

interface Migration {
  version: number
  name: string
  sql: string
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'local-authority-foundation',
    sql: `
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE worlds (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        template_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX worlds_workspace_idx
        ON worlds(workspace_id, status, created_at);

      CREATE TABLE employee_blueprints (
        id TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version > 0),
        world_template_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL,
        summary TEXT NOT NULL,
        persona TEXT NOT NULL,
        requested_skills_json TEXT NOT NULL,
        requested_capabilities_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (id, version)
      ) STRICT;

      CREATE TABLE employee_instances (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
        blueprint_id TEXT NOT NULL,
        blueprint_version INTEGER NOT NULL,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('available', 'working', 'waiting', 'blocked', 'archived')),
        current_revision INTEGER NOT NULL CHECK (current_revision > 0),
        agent_session_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT,
        FOREIGN KEY (blueprint_id, blueprint_version)
          REFERENCES employee_blueprints(id, version)
      ) STRICT;

      CREATE INDEX employee_instances_workspace_idx
        ON employee_instances(workspace_id, world_id, status, created_at);

      CREATE TABLE employee_revisions (
        employee_id TEXT NOT NULL REFERENCES employee_instances(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL CHECK (revision > 0),
        persona TEXT NOT NULL,
        skill_grants_json TEXT NOT NULL,
        capability_grants_json TEXT NOT NULL,
        model_policy_json TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (employee_id, revision)
      ) STRICT;

      CREATE TABLE work_sessions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('direct', 'group', 'meeting', 'task')),
        title TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('open', 'completed', 'archived')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX work_sessions_workspace_idx
        ON work_sessions(workspace_id, world_id, status, updated_at DESC);

      CREATE TABLE work_session_participants (
        session_id TEXT NOT NULL REFERENCES work_sessions(id) ON DELETE CASCADE,
        participant_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('owner', 'employee', 'system')),
        joined_at TEXT NOT NULL,
        PRIMARY KEY (session_id, participant_id)
      ) STRICT;

      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES work_sessions(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL CHECK (sequence > 0),
        sender_id TEXT NOT NULL,
        sender_kind TEXT NOT NULL CHECK (sender_kind IN ('owner', 'employee', 'system')),
        kind TEXT NOT NULL CHECK (kind IN ('user', 'assistant', 'reasoning', 'tool-call', 'tool-result', 'system')),
        content TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (session_id, sequence)
      ) STRICT;

      CREATE INDEX messages_session_idx ON messages(session_id, sequence);

      CREATE TABLE domain_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        world_id TEXT REFERENCES worlds(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        actor_kind TEXT NOT NULL CHECK (actor_kind IN ('owner', 'employee', 'system')),
        session_id TEXT,
        causation_id TEXT,
        correlation_id TEXT,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX domain_events_workspace_idx
        ON domain_events(workspace_id, sequence);
      CREATE INDEX domain_events_world_idx
        ON domain_events(world_id, sequence) WHERE world_id IS NOT NULL;
      CREATE INDEX domain_events_session_idx
        ON domain_events(session_id, sequence) WHERE session_id IS NOT NULL;

      CREATE TABLE sync_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE REFERENCES domain_events(event_id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        available_at TEXT NOT NULL,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX sync_outbox_pending_idx
        ON sync_outbox(status, available_at, id);
    `,
  },
  {
    version: 2,
    name: 'transactional-package-runtime',
    sql: `
      CREATE TABLE installed_packages (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        package_id TEXT NOT NULL,
        version TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'disabled')),
        installed_path TEXT NOT NULL,
        capabilities_json TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        installed_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, package_id, version)
      ) STRICT;

      CREATE UNIQUE INDEX installed_packages_active_idx
        ON installed_packages(workspace_id, package_id) WHERE status = 'active';

      CREATE TABLE package_install_transactions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        package_id TEXT NOT NULL,
        version TEXT NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN ('approved', 'staged', 'activated', 'rolled-back', 'failed')
        ),
        previous_version TEXT,
        approved_capabilities_json TEXT NOT NULL,
        error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX package_install_transactions_workspace_idx
        ON package_install_transactions(workspace_id, created_at DESC);
    `,
  },
  {
    version: 3,
    name: 'employee-growth-dossiers',
    sql: `
      CREATE TABLE employee_profile_revisions (
        employee_id TEXT NOT NULL REFERENCES employee_instances(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL CHECK (revision > 0),
        birthday TEXT,
        background TEXT NOT NULL,
        personality_traits_json TEXT NOT NULL,
        appearance_json TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (employee_id, revision)
      ) STRICT;

      CREATE TABLE skill_evidence (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
        employee_id TEXT NOT NULL REFERENCES employee_instances(id) ON DELETE CASCADE,
        skill_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('task', 'test', 'review', 'artifact', 'training')),
        outcome TEXT NOT NULL CHECK (outcome IN ('observed', 'passed', 'failed')),
        summary TEXT NOT NULL,
        source_event_ids_json TEXT NOT NULL,
        source_message_ids_json TEXT NOT NULL,
        artifact_refs_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX skill_evidence_employee_idx
        ON skill_evidence(employee_id, skill_id, created_at DESC);

      CREATE TABLE employee_skill_revisions (
        employee_id TEXT NOT NULL REFERENCES employee_instances(id) ON DELETE CASCADE,
        skill_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision > 0),
        status TEXT NOT NULL CHECK (status IN ('learning', 'verified', 'suspended')),
        evidence_ids_json TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (employee_id, skill_id, revision)
      ) STRICT;

      CREATE INDEX employee_skill_revisions_employee_idx
        ON employee_skill_revisions(employee_id, skill_id, revision DESC);

      CREATE TABLE employee_milestones (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
        employee_id TEXT NOT NULL REFERENCES employee_instances(id) ON DELETE CASCADE,
        category TEXT NOT NULL CHECK (
          category IN (
            'joined', 'task', 'delivery', 'skill', 'review', 'promotion',
            'failure', 'recovery', 'celebration', 'birthday', 'reflection'
          )
        ),
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        source_event_ids_json TEXT NOT NULL,
        source_message_ids_json TEXT NOT NULL,
        artifact_refs_json TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX employee_milestones_employee_idx
        ON employee_milestones(employee_id, occurred_at DESC, id);

      CREATE TABLE employee_daily_journals (
        employee_id TEXT NOT NULL REFERENCES employee_instances(id) ON DELETE CASCADE,
        local_date TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision > 0),
        summary TEXT NOT NULL,
        highlights_json TEXT NOT NULL,
        source_event_ids_json TEXT NOT NULL,
        source_message_ids_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (employee_id, local_date, revision)
      ) STRICT;

      CREATE INDEX employee_daily_journals_employee_idx
        ON employee_daily_journals(employee_id, local_date DESC, revision DESC);

      CREATE TABLE employee_relationships (
        employee_id TEXT NOT NULL REFERENCES employee_instances(id) ON DELETE CASCADE,
        colleague_id TEXT NOT NULL REFERENCES employee_instances(id) ON DELETE CASCADE,
        collaboration_count INTEGER NOT NULL DEFAULT 0 CHECK (collaboration_count >= 0),
        review_count INTEGER NOT NULL DEFAULT 0 CHECK (review_count >= 0),
        handoff_count INTEGER NOT NULL DEFAULT 0 CHECK (handoff_count >= 0),
        last_interaction_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (employee_id, colleague_id),
        CHECK (employee_id <> colleague_id)
      ) STRICT;

      CREATE INDEX employee_relationships_colleague_idx
        ON employee_relationships(colleague_id, updated_at DESC);
    `,
  },
  {
    version: 4,
    name: 'workspace-personalization-and-model-profiles',
    sql: `
      CREATE TABLE workspace_preferences (
        workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
        color_scheme TEXT NOT NULL CHECK (color_scheme IN ('system', 'light', 'dark')),
        skin_id TEXT NOT NULL,
        background_asset_ref TEXT,
        background_fit TEXT NOT NULL CHECK (background_fit IN ('cover', 'contain', 'tile')),
        background_opacity REAL NOT NULL CHECK (background_opacity >= 0 AND background_opacity <= 1),
        interface_density TEXT NOT NULL CHECK (interface_density IN ('comfortable', 'compact')),
        motion TEXT NOT NULL CHECK (motion IN ('system', 'reduced', 'full')),
        left_pane_width INTEGER NOT NULL CHECK (left_pane_width >= 220 AND left_pane_width <= 520),
        right_pane_width INTEGER NOT NULL CHECK (right_pane_width >= 300 AND right_pane_width <= 760),
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE model_profiles (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        display_name TEXT NOT NULL,
        provider_kind TEXT NOT NULL CHECK (
          provider_kind IN ('deepseek', 'openai-compatible-local', 'openai-compatible-remote')
        ),
        base_url TEXT NOT NULL,
        model_id TEXT NOT NULL,
        api TEXT NOT NULL CHECK (
          api IN ('openai-completions', 'openai-responses', 'anthropic-messages')
        ),
        credential_env_name TEXT,
        is_default INTEGER NOT NULL CHECK (is_default IN (0, 1)),
        settings_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX model_profiles_workspace_idx
        ON model_profiles(workspace_id, is_default DESC, display_name, id);
      CREATE UNIQUE INDEX model_profiles_default_idx
        ON model_profiles(workspace_id) WHERE is_default = 1;
    `,
  },
  {
    version: 5,
    name: 'local-visual-assets',
    sql: `
      CREATE TABLE local_assets (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('background')),
        mime_type TEXT NOT NULL CHECK (mime_type IN ('image/png', 'image/jpeg', 'image/webp')),
        sha256 TEXT NOT NULL,
        relative_path TEXT NOT NULL UNIQUE,
        byte_length INTEGER NOT NULL CHECK (byte_length > 0),
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX local_assets_workspace_idx
        ON local_assets(workspace_id, kind, created_at DESC);
    `,
  },
  {
    version: 6,
    name: 'audited-runtime-updates',
    sql: `
      CREATE TABLE runtime_update_transactions (
        id TEXT PRIMARY KEY,
        candidate_root TEXT NOT NULL,
        version TEXT NOT NULL,
        contract_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN (
            'verified', 'contract-tested', 'canary-passed',
            'activated', 'rejected', 'rolled-back'
          )
        ),
        previous_runtime_root TEXT,
        report_json TEXT NOT NULL,
        error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX runtime_update_transactions_status_idx
        ON runtime_update_transactions(status, updated_at DESC, id);
    `,
  },
  {
    version: 7,
    name: 'conversation-attachments',
    sql: `
      DROP INDEX local_assets_workspace_idx;
      ALTER TABLE local_assets RENAME TO local_assets_v5;

      CREATE TABLE local_assets (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('background', 'attachment')),
        mime_type TEXT NOT NULL CHECK (
          mime_type IN (
            'image/png', 'image/jpeg', 'image/webp',
            'text/plain', 'text/markdown', 'application/json', 'application/pdf'
          )
        ),
        sha256 TEXT NOT NULL,
        relative_path TEXT NOT NULL UNIQUE,
        byte_length INTEGER NOT NULL CHECK (byte_length > 0),
        created_at TEXT NOT NULL
      ) STRICT;

      INSERT INTO local_assets (
        id, workspace_id, kind, mime_type, sha256, relative_path, byte_length, created_at
      )
      SELECT id, workspace_id, kind, mime_type, sha256, relative_path, byte_length, created_at
      FROM local_assets_v5;

      DROP TABLE local_assets_v5;
      CREATE INDEX local_assets_workspace_idx
        ON local_assets(workspace_id, kind, created_at DESC);
    `,
  },
  {
    version: 8,
    name: 'world-runtime-v2-projections',
    sql: `
      CREATE TABLE world_runtime_snapshots (
        world_id TEXT PRIMARY KEY REFERENCES worlds(id) ON DELETE CASCADE,
        theme_id TEXT NOT NULL,
        scene_id TEXT NOT NULL,
        sequence INTEGER NOT NULL CHECK (sequence >= 0),
        snapshot_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE world_entity_states (
        world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
        entity_id TEXT NOT NULL,
        scene_id TEXT NOT NULL,
        anchor_id TEXT,
        target_anchor_id TEXT,
        facing TEXT NOT NULL CHECK (facing IN ('north', 'east', 'south', 'west')),
        activity TEXT NOT NULL CHECK (
          activity IN (
            'idle', 'walking', 'thinking', 'working', 'talking',
            'meeting', 'blocked', 'celebrating'
          )
        ),
        activity_ref TEXT,
        target_entity_id TEXT,
        state_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (world_id, entity_id)
      ) STRICT;

      CREATE INDEX world_entity_states_scene_idx
        ON world_entity_states(world_id, scene_id, activity, updated_at DESC);

      CREATE TABLE world_object_states (
        world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
        entity_id TEXT NOT NULL,
        scene_id TEXT NOT NULL,
        state_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (world_id, entity_id)
      ) STRICT;

      CREATE TABLE world_theme_bindings (
        world_id TEXT PRIMARY KEY REFERENCES worlds(id) ON DELETE CASCADE,
        theme_id TEXT NOT NULL,
        theme_version TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
        manifest_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX world_theme_bindings_theme_idx
        ON world_theme_bindings(theme_id, theme_version, status);
    `,
  },
  {
    version: 9,
    name: 'hierarchical-model-assignments',
    sql: `
      CREATE TABLE model_assignments (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        scope TEXT NOT NULL CHECK (scope IN ('workspace', 'world', 'employee')),
        scope_id TEXT NOT NULL,
        model_profile_id TEXT NOT NULL REFERENCES model_profiles(id) ON DELETE CASCADE,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, scope, scope_id)
      ) STRICT;

      CREATE INDEX model_assignments_profile_idx
        ON model_assignments(workspace_id, model_profile_id, scope, scope_id);
    `,
  },
  {
    version: 10,
    name: 'immutable-world-theme-identities',
    sql: `
      ALTER TABLE world_theme_bindings ADD COLUMN package_id TEXT NOT NULL DEFAULT 'legacy-unbound';
      ALTER TABLE world_theme_bindings ADD COLUMN package_version TEXT NOT NULL DEFAULT '0.0.0';
      ALTER TABLE world_theme_bindings ADD COLUMN content_digest TEXT NOT NULL DEFAULT 'legacy-unverified';
      UPDATE world_theme_bindings SET status = 'disabled';
      DROP INDEX world_theme_bindings_theme_idx;
      CREATE INDEX world_theme_bindings_identity_idx
        ON world_theme_bindings(package_id, package_version, theme_id, theme_version, content_digest, status);
    `,
  },
  {
    version: 11,
    name: 'model-interaction-logs',
    sql: `
      CREATE TABLE model_interaction_logs (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        world_id TEXT REFERENCES worlds(id) ON DELETE CASCADE,
        session_id TEXT REFERENCES work_sessions(id) ON DELETE CASCADE,
        employee_id TEXT REFERENCES employee_instances(id) ON DELETE CASCADE,
        source TEXT NOT NULL CHECK (source IN ('turn', 'discovery')),
        model_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('success', 'failed')),
        error_code TEXT,
        error_message TEXT,
        prompt_message_count INTEGER NOT NULL CHECK (prompt_message_count >= 0),
        prompt_char_count INTEGER NOT NULL CHECK (prompt_char_count >= 0),
        response_char_count INTEGER CHECK (response_char_count >= 0),
        tool_call_count INTEGER CHECK (tool_call_count >= 0),
        duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
        tokens_prompt INTEGER CHECK (tokens_prompt >= 0),
        tokens_completion INTEGER CHECK (tokens_completion >= 0),
        tokens_total INTEGER CHECK (tokens_total >= 0),
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX model_interaction_logs_workspace_idx
        ON model_interaction_logs(workspace_id, created_at DESC, id);
      CREATE INDEX model_interaction_logs_status_idx
        ON model_interaction_logs(workspace_id, status, created_at DESC, id);
      CREATE INDEX model_interaction_logs_model_idx
        ON model_interaction_logs(workspace_id, model_id, created_at DESC, id);
    `,
  },
  {
    version: 12,
    name: 'model-interaction-http-status',
    sql: `
      ALTER TABLE model_interaction_logs
        ADD COLUMN http_status INTEGER CHECK (http_status BETWEEN 100 AND 599);
    `,
  },
  {
    version: 13,
    name: 'portable-blueprint-embodiment',
    sql: `
      ALTER TABLE employee_blueprints ADD COLUMN embodiment_json TEXT;
    `,
  },
  {
    version: 14,
    name: 'durable-task-schedules',
    sql: `
      CREATE TABLE task_schedules (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
        employee_id TEXT NOT NULL REFERENCES employee_instances(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        prompt TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('once', 'interval')),
        scheduled_at TEXT NOT NULL,
        every_seconds INTEGER CHECK (every_seconds IS NULL OR every_seconds >= 300),
        time_zone TEXT NOT NULL,
        permission_mode TEXT NOT NULL CHECK (permission_mode IN ('read-only', 'workspace-write')),
        status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'completed')),
        next_run_at TEXT,
        last_run_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK ((kind = 'once' AND every_seconds IS NULL) OR (kind = 'interval' AND every_seconds IS NOT NULL))
      ) STRICT;

      CREATE INDEX idx_task_schedules_due
        ON task_schedules(status, next_run_at, world_id);

      CREATE TABLE task_schedule_runs (
        id TEXT PRIMARY KEY,
        schedule_id TEXT NOT NULL REFERENCES task_schedules(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
        employee_id TEXT NOT NULL REFERENCES employee_instances(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'skipped')),
        scheduled_for TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        session_id TEXT,
        summary TEXT,
        error_code TEXT,
        UNIQUE(schedule_id, scheduled_for)
      ) STRICT;

      CREATE INDEX idx_task_schedule_runs_schedule
        ON task_schedule_runs(schedule_id, started_at DESC);
    `,
  },
]

export function migrate(database: DatabaseSync, now: () => string): void {
  const userVersion = readUserVersion(database)
  if (userVersion > CYBER_SCHEMA_VERSION) {
    throw new DatabaseSchemaError(
      `Database schema ${userVersion} is newer than supported schema ${CYBER_SCHEMA_VERSION}`,
    )
  }

  for (const migration of MIGRATIONS) {
    if (migration.version <= userVersion) continue

    database.exec('BEGIN IMMEDIATE')
    try {
      database.exec(migration.sql)
      database
        .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
        .run(migration.version, migration.name, now())
      database.exec(`PRAGMA user_version = ${migration.version}`)
      database.exec('COMMIT')
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }
}

export function readUserVersion(database: DatabaseSync): number {
  const row = database.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined
  return Number(row?.user_version ?? 0)
}

import type { DatabaseSync } from 'node:sqlite'

import { CYBER_SCHEMA_VERSION } from '@dsh-cyber/contracts'

import { DatabaseSchemaError } from './errors.js'

interface Migration {
  version: number
  name: string
  sql: string
  foreignKeysOff?: boolean
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
  {
    version: 15,
    name: 'conversation-runtime-lifecycle',
    sql: `
      CREATE TABLE work_turns (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES work_sessions(id) ON DELETE CASCADE,
        client_turn_id TEXT,
        interaction_kind TEXT NOT NULL CHECK (interaction_kind IN ('chat', 'task', 'meeting', 'peer')),
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'interrupted')),
        error_code TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT
      ) STRICT;

      CREATE INDEX work_turns_session_created_idx ON work_turns(session_id, created_at DESC, id);
      CREATE INDEX work_turns_world_status_created_idx ON work_turns(world_id, status, created_at DESC, id);
      CREATE INDEX work_turns_client_turn_idx ON work_turns(client_turn_id) WHERE client_turn_id IS NOT NULL;
      CREATE INDEX work_turns_session_client_turn_idx
        ON work_turns(session_id, client_turn_id) WHERE client_turn_id IS NOT NULL;

      CREATE TABLE agent_runs (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL REFERENCES work_turns(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES work_sessions(id) ON DELETE CASCADE,
        employee_id TEXT NOT NULL REFERENCES employee_instances(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK (ordinal > 0),
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'interrupted')),
        runtime_session_id TEXT,
        error_code TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        UNIQUE(turn_id, ordinal)
      ) STRICT;

      CREATE INDEX agent_runs_turn_ordinal_idx ON agent_runs(turn_id, ordinal);
      CREATE INDEX agent_runs_session_created_idx ON agent_runs(session_id, created_at DESC, id);
      CREATE INDEX agent_runs_employee_status_created_idx ON agent_runs(employee_id, status, created_at DESC, id);
    `,
  },
  {
    version: 16,
    name: 'approval-gate-v1',
    sql: `
      CREATE TABLE skill_actions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
        character_id TEXT NOT NULL REFERENCES employee_instances(id) ON DELETE CASCADE,
        skill_id TEXT NOT NULL,
        adapter_id TEXT NOT NULL,
        action TEXT NOT NULL,
        target TEXT NOT NULL,
        label TEXT NOT NULL,
        risk TEXT NOT NULL CHECK (risk IN ('read', 'write-local', 'external-side-effect')),
        authorization TEXT NOT NULL CHECK (authorization IN ('explicit-user-request', 'preapproved-policy')),
        parameters_json TEXT NOT NULL,
        scheduled_for TEXT,
        approval_request_id TEXT REFERENCES approval_requests(id) ON DELETE SET NULL,
        work_turn_id TEXT REFERENCES work_turns(id) ON DELETE SET NULL,
        agent_run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
        status TEXT NOT NULL CHECK (status IN ('scheduled', 'waiting-for-approval', 'executed', 'waiting-for-integration', 'failed', 'outcome-unknown', 'rejected')),
        detail TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX skill_actions_world_created_idx ON skill_actions(world_id, created_at DESC, id);
      CREATE INDEX skill_actions_due_idx ON skill_actions(status, scheduled_for) WHERE scheduled_for IS NOT NULL;
      CREATE INDEX skill_actions_subject_idx ON skill_actions(world_id, character_id, skill_id, action, target, created_at DESC);

      CREATE TABLE approval_requests (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
        session_id TEXT REFERENCES work_sessions(id) ON DELETE SET NULL,
        work_turn_id TEXT REFERENCES work_turns(id) ON DELETE SET NULL,
        agent_run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
        character_id TEXT REFERENCES employee_instances(id) ON DELETE SET NULL,
        subject_type TEXT NOT NULL CHECK (subject_type IN ('skill-action', 'tool-call', 'file-write', 'external-action')),
        subject_id TEXT NOT NULL,
        risk TEXT NOT NULL CHECK (risk IN ('read', 'write-local', 'external-side-effect', 'high-risk')),
        summary TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
        scope TEXT NOT NULL CHECK (scope IN ('once', 'character', 'world')),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        decided_at TEXT,
        decided_by TEXT,
        UNIQUE(subject_type, subject_id)
      ) STRICT;
      CREATE INDEX approval_requests_world_status_created_idx ON approval_requests(world_id, status, created_at DESC, id);
      CREATE INDEX approval_requests_turn_idx ON approval_requests(work_turn_id, created_at DESC) WHERE work_turn_id IS NOT NULL;

      CREATE TABLE approval_policies (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
        character_id TEXT REFERENCES employee_instances(id) ON DELETE CASCADE,
        subject_type TEXT NOT NULL CHECK (subject_type IN ('skill-action', 'tool-call', 'file-write', 'external-action')),
        skill_id TEXT,
        action TEXT NOT NULL,
        target TEXT NOT NULL,
        risk TEXT NOT NULL CHECK (risk IN ('read', 'write-local', 'external-side-effect', 'high-risk')),
        scope TEXT NOT NULL CHECK (scope IN ('character', 'world')),
        source_approval_id TEXT NOT NULL REFERENCES approval_requests(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        revoked_at TEXT,
        CHECK ((scope = 'character' AND character_id IS NOT NULL) OR (scope = 'world' AND character_id IS NULL))
      ) STRICT;
      CREATE INDEX approval_policies_match_idx ON approval_policies(world_id, subject_type, skill_id, action, target, risk, revoked_at);
    `,
  },
  {
    version: 17,
    name: 'trace-intelligence-v1',
    sql: `
      ALTER TABLE model_interaction_logs ADD COLUMN work_turn_id TEXT REFERENCES work_turns(id) ON DELETE SET NULL;
      ALTER TABLE model_interaction_logs ADD COLUMN agent_run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL;
      CREATE UNIQUE INDEX model_interaction_logs_agent_run_idx
        ON model_interaction_logs(agent_run_id) WHERE agent_run_id IS NOT NULL AND source = 'turn';
      CREATE INDEX model_interaction_logs_world_employee_created_idx
        ON model_interaction_logs(world_id, employee_id, created_at DESC, id);
    `,
  },
  {
    version: 18,
    name: 'world-package-instance-v1',
    sql: `
      CREATE TABLE world_package_instances (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
        package_id TEXT NOT NULL,
        package_version TEXT NOT NULL,
        package_kind TEXT NOT NULL,
        content_digest TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
        origin_path TEXT NOT NULL,
        overrides_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (workspace_id, package_id, package_version)
          REFERENCES installed_packages(workspace_id, package_id, version)
          ON DELETE RESTRICT
      ) STRICT;
      CREATE UNIQUE INDEX world_package_instances_active_idx
        ON world_package_instances(world_id, package_id) WHERE status = 'active';
      CREATE INDEX world_package_instances_world_idx
        ON world_package_instances(world_id, status, created_at, id);
    `,
  },
  {
    version: 19,
    name: 'world-default-administrator',
    sql: `
      ALTER TABLE worlds
        ADD COLUMN administrator_employee_id TEXT
        REFERENCES employee_instances(id) ON DELETE SET NULL;
      CREATE INDEX worlds_administrator_idx
        ON worlds(administrator_employee_id)
        WHERE administrator_employee_id IS NOT NULL;
      UPDATE worlds
      SET administrator_employee_id = (
        SELECT employee_instances.id
        FROM employee_instances
        WHERE employee_instances.world_id = worlds.id
          AND employee_instances.status <> 'archived'
        ORDER BY
          CASE WHEN employee_instances.blueprint_id = 'core.butler' THEN 0 ELSE 1 END,
          employee_instances.created_at,
          employee_instances.id
        LIMIT 1
      )
      WHERE administrator_employee_id IS NULL;
    `,
  },
  {
    version: 20,
    name: 'turn-aware-approval-continuation',
    foreignKeysOff: true,
    sql: `
      CREATE TABLE work_turns_v20 (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES work_sessions(id) ON DELETE CASCADE,
        client_turn_id TEXT,
        interaction_kind TEXT NOT NULL CHECK (interaction_kind IN ('chat', 'task', 'meeting', 'peer')),
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'waiting-approval', 'completed', 'failed', 'interrupted')),
        error_code TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT
      ) STRICT;
      INSERT INTO work_turns_v20
        (id, workspace_id, world_id, session_id, client_turn_id, interaction_kind, status,
         error_code, created_at, started_at, completed_at)
      SELECT id, workspace_id, world_id, session_id, client_turn_id, interaction_kind, status,
             error_code, created_at, started_at, completed_at
      FROM work_turns;
      DROP TABLE work_turns;
      ALTER TABLE work_turns_v20 RENAME TO work_turns;
      CREATE INDEX work_turns_session_created_idx ON work_turns(session_id, created_at DESC, id);
      CREATE INDEX work_turns_world_status_created_idx ON work_turns(world_id, status, created_at DESC, id);
      CREATE INDEX work_turns_client_turn_idx ON work_turns(client_turn_id) WHERE client_turn_id IS NOT NULL;
      CREATE INDEX work_turns_session_client_turn_idx
        ON work_turns(session_id, client_turn_id) WHERE client_turn_id IS NOT NULL;

      ALTER TABLE skill_actions ADD COLUMN execution_state TEXT
        CHECK (execution_state IN ('approved-ready', 'executing', 'settled'));
      ALTER TABLE skill_actions ADD COLUMN execution_attempt_id TEXT;
      ALTER TABLE skill_actions ADD COLUMN execution_started_at TEXT;
      ALTER TABLE skill_actions ADD COLUMN execution_completed_at TEXT;
      CREATE INDEX skill_actions_execution_state_idx
        ON skill_actions(execution_state, updated_at) WHERE execution_state IS NOT NULL;
    `,
  },
  {
    version: 21,
    name: 'world-character-authority-v1',
    sql: `
      CREATE TABLE IF NOT EXISTS world_character_authorities (
        world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
        employee_id TEXT NOT NULL REFERENCES employee_instances(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('member', 'administrator')),
        permissions_json TEXT NOT NULL CHECK (json_valid(permissions_json)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (world_id, employee_id)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS world_character_authorities_world_role_idx
        ON world_character_authorities(world_id, role, created_at, employee_id);
      CREATE INDEX IF NOT EXISTS world_character_authorities_employee_idx
        ON world_character_authorities(employee_id);

      CREATE TABLE IF NOT EXISTS world_authority_changes (
        id TEXT PRIMARY KEY,
        world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
        employee_id TEXT NOT NULL REFERENCES employee_instances(id) ON DELETE CASCADE,
        actor_kind TEXT NOT NULL CHECK (actor_kind IN ('owner', 'employee')),
        actor_id TEXT NOT NULL,
        previous_role TEXT CHECK (previous_role IS NULL OR previous_role IN ('member', 'administrator')),
        next_role TEXT NOT NULL CHECK (next_role IN ('member', 'administrator')),
        added_permissions_json TEXT NOT NULL CHECK (json_valid(added_permissions_json)),
        removed_permissions_json TEXT NOT NULL CHECK (json_valid(removed_permissions_json)),
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS world_authority_changes_world_created_idx
        ON world_authority_changes(world_id, created_at DESC, id);
      CREATE INDEX IF NOT EXISTS world_authority_changes_employee_created_idx
        ON world_authority_changes(employee_id, created_at DESC, id);

      CREATE TABLE IF NOT EXISTS world_permission_requests (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
        employee_id TEXT NOT NULL REFERENCES employee_instances(id) ON DELETE CASCADE,
        /* Authority decisions must never outlive the execution facts they
           authorize. Keep both edges as real SQLite foreign keys so orphaned
           WorkTurns/SkillActions cannot become security decisions. */
        work_turn_id TEXT NOT NULL REFERENCES work_turns(id) ON DELETE CASCADE,
        skill_action_id TEXT NOT NULL REFERENCES skill_actions(id) ON DELETE CASCADE,
        permission TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
        decision_scope TEXT CHECK (decision_scope IS NULL OR decision_scope IN ('once', 'persistent')),
        decided_by TEXT,
        decided_at TEXT,
        consumed_at TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        /* One missing-authority gate is bound to one exact SkillAction. */
        UNIQUE (skill_action_id)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS world_permission_requests_world_status_created_idx
        ON world_permission_requests(world_id, status, created_at DESC, id);
      CREATE INDEX IF NOT EXISTS world_permission_requests_turn_idx
        ON world_permission_requests(work_turn_id, status, created_at DESC, id);
      CREATE INDEX IF NOT EXISTS world_permission_requests_action_idx
        ON world_permission_requests(skill_action_id, status, id);
      CREATE UNIQUE INDEX IF NOT EXISTS world_permission_requests_skill_action_unique_idx
        ON world_permission_requests(skill_action_id);

      ALTER TABLE skill_actions ADD COLUMN authorization_source TEXT
        CHECK (authorization_source IS NULL OR authorization_source IN ('skill-grant', 'world-authority'));
      ALTER TABLE skill_actions ADD COLUMN required_world_permission TEXT;
      CREATE INDEX IF NOT EXISTS skill_actions_world_permission_idx
        ON skill_actions(world_id, character_id, required_world_permission, status)
        WHERE required_world_permission IS NOT NULL;

      /* The administratorEmployeeId column is retained as a compatibility
         pointer only. Existing worlds are promoted into the real authority
         table without losing their legacy administrator identity. */
      INSERT OR IGNORE INTO world_character_authorities (
        world_id, employee_id, role, permissions_json, created_at, updated_at
      )
      SELECT
        employee_instances.world_id,
        employee_instances.id,
        CASE WHEN worlds.administrator_employee_id = employee_instances.id
          THEN 'administrator' ELSE 'member' END,
        CASE WHEN worlds.administrator_employee_id = employee_instances.id
          THEN '["world.files.read","world.files.write","world.settings.read","world.settings.write","world.characters.read","world.characters.manage","world.permissions.read","world.permissions.manage","world.packages.read","world.packages.manage","world.integrations.read","world.model.read","world.model.assign","world.approvals.read","world.trace.read","world.conversations.read-metadata"]'
          ELSE '["world.files.read"]' END,
        employee_instances.created_at,
        employee_instances.updated_at
      FROM employee_instances
      INNER JOIN worlds ON worlds.id = employee_instances.world_id;
    `,
  },
  {
    version: 22,
    name: 'world-permission-audit-retention',
    foreignKeysOff: true,
    sql: `
      /* A permission decision is evidence of who allowed what, and it has to
         outlive the turn it authorized. work_turn_id was NOT NULL with
         ON DELETE CASCADE, so pruning settled telemetry destroyed the very
         audit trail the product promises to keep. The turn edge becomes
         nullable with ON DELETE SET NULL, and session_id is captured durably
         so the decision remains attributable after the turn is gone. */
      CREATE TABLE world_permission_requests_v22 (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
        employee_id TEXT NOT NULL REFERENCES employee_instances(id) ON DELETE CASCADE,
        session_id TEXT,
        work_turn_id TEXT REFERENCES work_turns(id) ON DELETE SET NULL,
        /* The action edge stays a hard CASCADE: a decision must never outlive
           the exact execution fact it authorized. Only the turn edge softens,
           because settled turns are prunable telemetry and the decision is
           not. */
        skill_action_id TEXT NOT NULL REFERENCES skill_actions(id) ON DELETE CASCADE,
        permission TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
        decision_scope TEXT CHECK (decision_scope IS NULL OR decision_scope IN ('once', 'persistent')),
        decided_by TEXT,
        decided_at TEXT,
        consumed_at TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        UNIQUE (skill_action_id)
      ) STRICT;

      INSERT INTO world_permission_requests_v22 (
        id, workspace_id, world_id, employee_id, session_id, work_turn_id, skill_action_id,
        permission, status, decision_scope, decided_by, decided_at, consumed_at, created_at, expires_at
      )
      SELECT
        request.id, request.workspace_id, request.world_id, request.employee_id,
        (SELECT session_id FROM work_turns WHERE work_turns.id = request.work_turn_id),
        request.work_turn_id, request.skill_action_id,
        request.permission, request.status, request.decision_scope, request.decided_by,
        request.decided_at, request.consumed_at, request.created_at, request.expires_at
      FROM world_permission_requests AS request;

      DROP TABLE world_permission_requests;
      ALTER TABLE world_permission_requests_v22 RENAME TO world_permission_requests;

      CREATE INDEX IF NOT EXISTS world_permission_requests_world_status_idx
        ON world_permission_requests(world_id, status, expires_at);
      CREATE INDEX IF NOT EXISTS world_permission_requests_pending_idx
        ON world_permission_requests(status, expires_at)
        WHERE status = 'pending';

      /* Recovery reads only what still needs recovering. Without these it
         scanned every settled action of every world at every startup. */
      CREATE INDEX IF NOT EXISTS skill_actions_recovery_idx
        ON skill_actions(execution_state, status, world_id);
      CREATE INDEX IF NOT EXISTS work_turns_status_idx
        ON work_turns(status, created_at);
    `,
  },
  {
    version: 23,
    name: 'world-artifact-registry',
    sql: `
      /* Pair the World id with its workspace so registry rows cannot combine
         a valid workspace and a valid World from different scopes. */
      CREATE UNIQUE INDEX IF NOT EXISTS worlds_workspace_id_unique_idx
        ON worlds(workspace_id, id);

      CREATE TABLE IF NOT EXISTS world_artifacts (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        description TEXT,
        kind TEXT NOT NULL CHECK (
          kind IN ('image', 'html', 'markdown', 'document', 'code', 'data', 'archive', 'project', 'other')
        ),
        status TEXT NOT NULL CHECK (status IN ('active', 'archived', 'missing')),
        current_version INTEGER NOT NULL CHECK (current_version > 0),
        created_by_kind TEXT NOT NULL CHECK (created_by_kind IN ('owner', 'employee')),
        created_by_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (workspace_id, world_id, id),
        FOREIGN KEY (workspace_id, world_id)
          REFERENCES worlds(workspace_id, id)
          ON DELETE CASCADE
      ) STRICT;

      CREATE INDEX IF NOT EXISTS world_artifacts_world_status_updated_idx
        ON world_artifacts(world_id, status, updated_at DESC, id);
      CREATE INDEX IF NOT EXISTS world_artifacts_world_kind_updated_idx
        ON world_artifacts(world_id, kind, updated_at DESC, id);
      CREATE INDEX IF NOT EXISTS world_artifacts_creator_idx
        ON world_artifacts(world_id, created_by_kind, created_by_id, created_at DESC, id);

      CREATE TABLE IF NOT EXISTS world_artifact_versions (
        artifact_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        world_id TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version > 0),
        relative_path TEXT NOT NULL,
        entrypoint TEXT,
        mime_type TEXT,
        byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
        sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
        source_relative_path TEXT,
        employee_id TEXT,
        session_id TEXT,
        work_turn_id TEXT,
        agent_run_id TEXT,
        idempotency_key TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (artifact_id, version),
        FOREIGN KEY (workspace_id, world_id, artifact_id)
          REFERENCES world_artifacts(workspace_id, world_id, id)
          ON DELETE CASCADE
      ) STRICT;

      CREATE INDEX IF NOT EXISTS world_artifact_versions_artifact_idx
        ON world_artifact_versions(artifact_id, version DESC);
      CREATE INDEX IF NOT EXISTS world_artifact_versions_world_created_idx
        ON world_artifact_versions(world_id, created_at DESC, artifact_id, version);
      CREATE INDEX IF NOT EXISTS world_artifact_versions_employee_idx
        ON world_artifact_versions(world_id, employee_id, created_at DESC)
        WHERE employee_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS world_artifact_versions_work_turn_idx
        ON world_artifact_versions(world_id, work_turn_id, created_at DESC)
        WHERE work_turn_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS world_artifact_versions_idempotency_idx
        ON world_artifact_versions(world_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL;
    `,
  },
  {
    version: 24,
    name: 'world-knowledge-library-v1',
    sql: `
      /* Knowledge source files live below WorldRoot/knowledge/library. These
         tables hold metadata and replaceable search projections only. */
      CREATE TABLE IF NOT EXISTS knowledge_collections (
        id TEXT PRIMARY KEY,
        world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT,
        origin TEXT NOT NULL CHECK (origin IN ('folder', 'zip', 'manual', 'web', 'artifact')),
        relative_root TEXT NOT NULL,
        document_count INTEGER NOT NULL DEFAULT 0 CHECK (document_count >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (world_id, id),
        UNIQUE (id, world_id)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS knowledge_collections_world_updated_idx
        ON knowledge_collections(world_id, updated_at DESC, id);

      CREATE TABLE IF NOT EXISTS knowledge_documents (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
        collection_id TEXT,
        relative_path TEXT NOT NULL,
        title TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
        sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
        origin TEXT NOT NULL CHECK (origin IN ('upload', 'paste', 'web', 'filesystem', 'artifact')),
        source_url TEXT,
        artifact_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('pending', 'indexed', 'failed', 'missing')),
        chunk_count INTEGER NOT NULL DEFAULT 0 CHECK (chunk_count >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        indexed_at TEXT,
        UNIQUE (world_id, id),
        UNIQUE (world_id, relative_path),
        FOREIGN KEY (workspace_id, world_id)
          REFERENCES worlds(workspace_id, id)
          ON DELETE CASCADE,
        FOREIGN KEY (collection_id, world_id)
          REFERENCES knowledge_collections(id, world_id)
          ON DELETE CASCADE,
        FOREIGN KEY (artifact_id)
          REFERENCES world_artifacts(id)
          ON DELETE SET NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS knowledge_documents_world_status_updated_idx
        ON knowledge_documents(world_id, status, updated_at DESC, id);
      CREATE INDEX IF NOT EXISTS knowledge_documents_collection_updated_idx
        ON knowledge_documents(world_id, collection_id, updated_at DESC, id)
        WHERE collection_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS knowledge_documents_world_origin_idx
        ON knowledge_documents(world_id, origin, updated_at DESC, id);
      CREATE INDEX IF NOT EXISTS knowledge_documents_sha256_idx
        ON knowledge_documents(world_id, sha256, id);
      CREATE INDEX IF NOT EXISTS knowledge_documents_artifact_idx
        ON knowledge_documents(world_id, artifact_id, id)
        WHERE artifact_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS knowledge_chunks (
        id TEXT PRIMARY KEY,
        world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
        document_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
        start_offset INTEGER CHECK (start_offset IS NULL OR start_offset >= 0),
        end_offset INTEGER CHECK (end_offset IS NULL OR end_offset >= 0),
        created_at TEXT NOT NULL,
        UNIQUE (world_id, id),
        UNIQUE (document_id, ordinal),
        CHECK (
          start_offset IS NULL OR end_offset IS NULL OR end_offset >= start_offset
        ),
        FOREIGN KEY (world_id, document_id)
          REFERENCES knowledge_documents(world_id, id)
          ON DELETE CASCADE
      ) STRICT;

      CREATE INDEX IF NOT EXISTS knowledge_chunks_world_document_ordinal_idx
        ON knowledge_chunks(world_id, document_id, ordinal);
      CREATE INDEX IF NOT EXISTS knowledge_chunks_world_created_idx
        ON knowledge_chunks(world_id, created_at DESC, id);
      CREATE INDEX IF NOT EXISTS knowledge_chunks_content_hash_idx
        ON knowledge_chunks(world_id, content_hash, document_id, ordinal);

      /* Keep denormalized collection counts correct while retaining a
         rebuildable projection: deleting/replacing documents never requires
         callers to hand-maintain this count. */
      CREATE TRIGGER IF NOT EXISTS knowledge_documents_collection_insert_count
      AFTER INSERT ON knowledge_documents
      WHEN NEW.collection_id IS NOT NULL
      BEGIN
        UPDATE knowledge_collections
        SET document_count = document_count + 1,
            updated_at = NEW.updated_at
        WHERE world_id = NEW.world_id AND id = NEW.collection_id;
      END;

      CREATE TRIGGER IF NOT EXISTS knowledge_documents_collection_delete_count
      AFTER DELETE ON knowledge_documents
      WHEN OLD.collection_id IS NOT NULL
      BEGIN
        UPDATE knowledge_collections
        SET document_count = MAX(0, document_count - 1),
            updated_at = OLD.updated_at
        WHERE world_id = OLD.world_id AND id = OLD.collection_id;
      END;

      CREATE TRIGGER IF NOT EXISTS knowledge_documents_collection_update_count
      AFTER UPDATE OF collection_id ON knowledge_documents
      WHEN COALESCE(OLD.collection_id, '') <> COALESCE(NEW.collection_id, '')
      BEGIN
        UPDATE knowledge_collections
        SET document_count = MAX(0, document_count - 1),
            updated_at = NEW.updated_at
        WHERE OLD.collection_id IS NOT NULL
          AND world_id = OLD.world_id
          AND id = OLD.collection_id;
        UPDATE knowledge_collections
        SET document_count = document_count + 1,
            updated_at = NEW.updated_at
        WHERE NEW.collection_id IS NOT NULL
          AND world_id = NEW.world_id
          AND id = NEW.collection_id;
      END;
    `,
  },
  {
    version: 25,
    name: 'world-knowledge-graph-v1',
    sql: `
      /* Extend the telemetry source vocabulary without losing an existing
         database. SQLite cannot alter a CHECK constraint in place, so rebuild
         this small append-only table and retain every column/row. */
      DROP INDEX IF EXISTS model_interaction_logs_workspace_idx;
      DROP INDEX IF EXISTS model_interaction_logs_status_idx;
      DROP INDEX IF EXISTS model_interaction_logs_model_idx;
      DROP INDEX IF EXISTS model_interaction_logs_agent_run_idx;
      DROP INDEX IF EXISTS model_interaction_logs_world_employee_created_idx;
      ALTER TABLE model_interaction_logs RENAME TO model_interaction_logs_v25;
      CREATE TABLE model_interaction_logs (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        world_id TEXT REFERENCES worlds(id) ON DELETE CASCADE,
        session_id TEXT REFERENCES work_sessions(id) ON DELETE CASCADE,
        employee_id TEXT REFERENCES employee_instances(id) ON DELETE CASCADE,
        source TEXT NOT NULL CHECK (source IN ('turn', 'discovery', 'knowledge')),
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
        created_at TEXT NOT NULL,
        http_status INTEGER CHECK (http_status BETWEEN 100 AND 599),
        work_turn_id TEXT REFERENCES work_turns(id) ON DELETE SET NULL,
        agent_run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL
      ) STRICT;
      INSERT INTO model_interaction_logs
        (id, workspace_id, world_id, session_id, employee_id, source, model_id, provider, status,
         error_code, error_message, prompt_message_count, prompt_char_count, response_char_count,
         tool_call_count, duration_ms, tokens_prompt, tokens_completion, tokens_total, created_at,
         http_status, work_turn_id, agent_run_id)
      SELECT id, workspace_id, world_id, session_id, employee_id, source, model_id, provider, status,
         error_code, error_message, prompt_message_count, prompt_char_count, response_char_count,
         tool_call_count, duration_ms, tokens_prompt, tokens_completion, tokens_total, created_at,
         http_status, work_turn_id, agent_run_id
      FROM model_interaction_logs_v25;
      DROP TABLE model_interaction_logs_v25;
      CREATE INDEX model_interaction_logs_workspace_idx
        ON model_interaction_logs(workspace_id, created_at DESC, id);
      CREATE INDEX model_interaction_logs_status_idx
        ON model_interaction_logs(workspace_id, status, created_at DESC, id);
      CREATE INDEX model_interaction_logs_model_idx
        ON model_interaction_logs(workspace_id, model_id, created_at DESC, id);
      CREATE UNIQUE INDEX model_interaction_logs_agent_run_idx
        ON model_interaction_logs(agent_run_id) WHERE agent_run_id IS NOT NULL AND source = 'turn';
      CREATE INDEX model_interaction_logs_world_employee_created_idx
        ON model_interaction_logs(world_id, employee_id, created_at DESC, id);

      /* The graph is a world-owned, evidence-backed projection. Every table
         carries workspace_id and world_id so repository checks and SQLite
         foreign keys enforce isolation together. */
      CREATE TABLE IF NOT EXISTS knowledge_entities (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        world_id TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('character', 'person', 'place', 'organization', 'project', 'artifact', 'technology', 'concept', 'tool', 'process', 'event', 'topic', 'object', 'other')),
        canonical_name TEXT NOT NULL,
        aliases_json TEXT NOT NULL DEFAULT '[]',
        summary TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT,
        UNIQUE (workspace_id, world_id, id),
        FOREIGN KEY (workspace_id, world_id)
          REFERENCES worlds(workspace_id, id)
          ON DELETE CASCADE
      ) STRICT;

      CREATE INDEX IF NOT EXISTS knowledge_entities_world_status_updated_idx
        ON knowledge_entities(world_id, status, updated_at DESC, id);
      CREATE INDEX IF NOT EXISTS knowledge_entities_world_name_idx
        ON knowledge_entities(world_id, canonical_name COLLATE NOCASE, id);

      CREATE TABLE IF NOT EXISTS knowledge_evidence (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        world_id TEXT NOT NULL,
        source_type TEXT NOT NULL CHECK (source_type IN ('conversation', 'document', 'artifact', 'manual')),
        session_id TEXT,
        message_id TEXT,
        sequence INTEGER CHECK (sequence IS NULL OR sequence >= 0),
        document_id TEXT,
        chunk_id TEXT,
        artifact_id TEXT,
        artifact_version INTEGER CHECK (artifact_version IS NULL OR artifact_version > 0),
        excerpt TEXT NOT NULL,
        note TEXT,
        source_weight REAL NOT NULL CHECK (source_weight >= 0 AND source_weight <= 1),
        created_by TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (workspace_id, world_id, id),
        FOREIGN KEY (workspace_id, world_id)
          REFERENCES worlds(workspace_id, id)
          ON DELETE CASCADE
      ) STRICT;

      CREATE INDEX IF NOT EXISTS knowledge_evidence_world_source_created_idx
        ON knowledge_evidence(world_id, source_type, created_at DESC, id);
      CREATE INDEX IF NOT EXISTS knowledge_evidence_session_sequence_idx
        ON knowledge_evidence(world_id, session_id, sequence, id)
        WHERE session_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS knowledge_evidence_document_idx
        ON knowledge_evidence(world_id, document_id, chunk_id, id)
        WHERE document_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS knowledge_evidence_artifact_idx
        ON knowledge_evidence(world_id, artifact_id, artifact_version, id)
        WHERE artifact_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS knowledge_claims (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        world_id TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('fact', 'decision', 'preference', 'rule', 'definition', 'procedure', 'constraint', 'insight', 'lore')),
        subject_entity_id TEXT NOT NULL,
        predicate TEXT NOT NULL,
        object_entity_id TEXT,
        object_text TEXT,
        confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
        status TEXT NOT NULL CHECK (status IN ('active', 'conflicted', 'superseded', 'archived')),
        source TEXT NOT NULL CHECK (source IN ('auto', 'manual')),
        evidence_ids_json TEXT NOT NULL DEFAULT '[]',
        conflict_group TEXT,
        superseded_by_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (workspace_id, world_id, id),
        CHECK ((object_entity_id IS NOT NULL AND object_text IS NULL) OR (object_entity_id IS NULL AND object_text IS NOT NULL)),
        FOREIGN KEY (workspace_id, world_id)
          REFERENCES worlds(workspace_id, id)
          ON DELETE CASCADE,
        FOREIGN KEY (workspace_id, world_id, subject_entity_id)
          REFERENCES knowledge_entities(workspace_id, world_id, id)
          ON DELETE RESTRICT,
        FOREIGN KEY (workspace_id, world_id, object_entity_id)
          REFERENCES knowledge_entities(workspace_id, world_id, id)
          ON DELETE RESTRICT
      ) STRICT;

      CREATE INDEX IF NOT EXISTS knowledge_claims_world_status_updated_idx
        ON knowledge_claims(world_id, status, updated_at DESC, id);
      CREATE INDEX IF NOT EXISTS knowledge_claims_subject_predicate_idx
        ON knowledge_claims(world_id, subject_entity_id, predicate, status, id);
      CREATE INDEX IF NOT EXISTS knowledge_claims_object_entity_idx
        ON knowledge_claims(world_id, object_entity_id, status, id)
        WHERE object_entity_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS knowledge_relations (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        world_id TEXT NOT NULL,
        from_entity_id TEXT NOT NULL,
        to_entity_id TEXT NOT NULL,
        predicate TEXT NOT NULL,
        confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
        status TEXT NOT NULL CHECK (status IN ('active', 'conflicted', 'superseded', 'archived')),
        source TEXT NOT NULL CHECK (source IN ('auto', 'manual')),
        evidence_ids_json TEXT NOT NULL DEFAULT '[]',
        conflict_group TEXT,
        superseded_by_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (workspace_id, world_id, id),
        FOREIGN KEY (workspace_id, world_id)
          REFERENCES worlds(workspace_id, id)
          ON DELETE CASCADE,
        FOREIGN KEY (workspace_id, world_id, from_entity_id)
          REFERENCES knowledge_entities(workspace_id, world_id, id)
          ON DELETE RESTRICT,
        FOREIGN KEY (workspace_id, world_id, to_entity_id)
          REFERENCES knowledge_entities(workspace_id, world_id, id)
          ON DELETE RESTRICT
      ) STRICT;

      CREATE INDEX IF NOT EXISTS knowledge_relations_world_status_updated_idx
        ON knowledge_relations(world_id, status, updated_at DESC, id);
      CREATE INDEX IF NOT EXISTS knowledge_relations_from_idx
        ON knowledge_relations(world_id, from_entity_id, status, id);
      CREATE INDEX IF NOT EXISTS knowledge_relations_to_idx
        ON knowledge_relations(world_id, to_entity_id, status, id);

      CREATE TABLE IF NOT EXISTS knowledge_conversation_cursors (
        workspace_id TEXT NOT NULL,
        world_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        processed_through_sequence INTEGER NOT NULL CHECK (processed_through_sequence >= 0),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (world_id, session_id),
        FOREIGN KEY (workspace_id, world_id)
          REFERENCES worlds(workspace_id, id)
          ON DELETE CASCADE
      ) STRICT;

      CREATE TABLE IF NOT EXISTS knowledge_consolidation_jobs (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        world_id TEXT NOT NULL,
        source_type TEXT NOT NULL CHECK (source_type IN ('conversation', 'document', 'artifact')),
        source_id TEXT NOT NULL,
        from_cursor INTEGER NOT NULL CHECK (from_cursor >= 0),
        to_cursor INTEGER NOT NULL CHECK (to_cursor >= from_cursor),
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
        attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
        error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        UNIQUE (world_id, source_type, source_id, from_cursor, to_cursor),
        FOREIGN KEY (workspace_id, world_id)
          REFERENCES worlds(workspace_id, id)
          ON DELETE CASCADE
      ) STRICT;

      CREATE INDEX IF NOT EXISTS knowledge_consolidation_jobs_world_status_updated_idx
        ON knowledge_consolidation_jobs(world_id, status, updated_at, id);

      CREATE TABLE IF NOT EXISTS world_knowledge_settings (
        workspace_id TEXT NOT NULL,
        world_id TEXT PRIMARY KEY,
        retrieval_enabled INTEGER NOT NULL DEFAULT 1 CHECK (retrieval_enabled IN (0, 1)),
        auto_consolidation_mode TEXT NOT NULL DEFAULT 'balanced' CHECK (auto_consolidation_mode IN ('off', 'balanced')),
        extraction_model_profile_id TEXT,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (workspace_id, world_id)
          REFERENCES worlds(workspace_id, id)
          ON DELETE CASCADE
      ) STRICT;

      CREATE TABLE IF NOT EXISTS knowledge_suppressions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        world_id TEXT NOT NULL,
        target_type TEXT NOT NULL CHECK (target_type IN ('entity', 'claim', 'relation')),
        fingerprint TEXT NOT NULL,
        evidence_ids_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        UNIQUE (world_id, target_type, fingerprint),
        FOREIGN KEY (workspace_id, world_id)
          REFERENCES worlds(workspace_id, id)
          ON DELETE CASCADE
      ) STRICT;

      CREATE INDEX IF NOT EXISTS knowledge_suppressions_world_fingerprint_idx
        ON knowledge_suppressions(world_id, fingerprint, target_type);
    `,
  },
  {
    version: 26,
    name: 'task-collaboration-plans-v1',
    sql: `
      ALTER TABLE work_sessions
        ADD COLUMN collaboration_mode TEXT NOT NULL DEFAULT 'discussion'
        CHECK (collaboration_mode IN ('discussion', 'task'));

      CREATE TABLE task_collaboration_plans (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        world_id TEXT NOT NULL,
        session_id TEXT NOT NULL REFERENCES work_sessions(id) ON DELETE RESTRICT,
        /* Deliberately no FK to work_turns: pruneHistory must not delete plans. */
        work_turn_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision > 0),
        status TEXT NOT NULL CHECK (
          status IN ('planned', 'running', 'completed', 'failed', 'interrupted', 'cancelled')
        ),
        error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (world_id, task_id),
        FOREIGN KEY (workspace_id, world_id)
          REFERENCES worlds(workspace_id, id)
          ON DELETE CASCADE
      ) STRICT;

      CREATE INDEX task_collaboration_plans_world_status_updated_idx
        ON task_collaboration_plans(world_id, status, updated_at DESC, id);
      CREATE INDEX task_collaboration_plans_session_idx
        ON task_collaboration_plans(session_id, created_at DESC, id);
      CREATE INDEX task_collaboration_plans_work_turn_idx
        ON task_collaboration_plans(work_turn_id, created_at DESC, id);

      CREATE TABLE task_collaboration_steps (
        id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL REFERENCES task_collaboration_plans(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK (ordinal > 0),
        required_skills_json TEXT NOT NULL CHECK (json_valid(required_skills_json)),
        assigned_employee_ids_json TEXT NOT NULL CHECK (json_valid(assigned_employee_ids_json)),
        depends_on_json TEXT NOT NULL CHECK (json_valid(depends_on_json)),
        execution_mode TEXT NOT NULL CHECK (execution_mode IN ('parallel', 'sequential')),
        status TEXT NOT NULL CHECK (
          status IN ('pending', 'ready', 'running', 'completed', 'failed', 'blocked', 'interrupted', 'cancelled')
        ),
        error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (plan_id, ordinal)
      ) STRICT;

      CREATE INDEX task_collaboration_steps_plan_status_idx
        ON task_collaboration_steps(plan_id, status, ordinal, id);
    `,
  },
  {
    version: 27,
    name: 'durable-conversation-queue-v1',
    sql: `
      CREATE TABLE conversation_queue_entries (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES work_sessions(id) ON DELETE CASCADE,
        work_turn_id TEXT NOT NULL UNIQUE REFERENCES work_turns(id) ON DELETE CASCADE,
        employee_ids_json TEXT NOT NULL CHECK (json_valid(employee_ids_json)),
        conversation_kind TEXT NOT NULL CHECK (conversation_kind IN ('direct', 'group', 'meeting', 'task')),
        collaboration_mode TEXT NOT NULL DEFAULT 'discussion'
          CHECK (collaboration_mode IN ('discussion', 'task')),
        reasoning_effort TEXT CHECK (
          reasoning_effort IS NULL OR reasoning_effort IN ('off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max')
        ),
        permission_mode TEXT CHECK (
          permission_mode IS NULL OR permission_mode IN ('read-only', 'workspace-write', 'danger-full-access')
        ),
        priority INTEGER NOT NULL DEFAULT 0,
        revision INTEGER NOT NULL CHECK (revision > 0),
        status TEXT NOT NULL CHECK (
          status IN ('queued', 'running', 'waiting-approval', 'completed', 'failed', 'interrupted', 'cancelled')
        ),
        error_code TEXT,
        enqueued_at TEXT NOT NULL,
        claimed_at TEXT,
        completed_at TEXT,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX conversation_queue_world_order_idx
        ON conversation_queue_entries(world_id, status, priority DESC, enqueued_at, id);
      CREATE INDEX conversation_queue_session_order_idx
        ON conversation_queue_entries(session_id, status, priority DESC, enqueued_at, id);
      CREATE INDEX conversation_queue_turn_idx
        ON conversation_queue_entries(work_turn_id, status, id);
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

    if (migration.foreignKeysOff === true) database.exec('PRAGMA foreign_keys = OFF')
    database.exec('BEGIN IMMEDIATE')
    try {
      database.exec(migration.sql)
      if (migration.foreignKeysOff === true) {
        const violation = database.prepare('PRAGMA foreign_key_check').get()
        if (violation !== undefined) throw new DatabaseSchemaError(`Migration ${migration.version} violates foreign keys`)
      }
      database
        .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
        .run(migration.version, migration.name, now())
      database.exec(`PRAGMA user_version = ${migration.version}`)
      database.exec('COMMIT')
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    } finally {
      if (migration.foreignKeysOff === true) database.exec('PRAGMA foreign_keys = ON')
    }
  }
}

export function readUserVersion(database: DatabaseSync): number {
  const row = database.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined
  return Number(row?.user_version ?? 0)
}

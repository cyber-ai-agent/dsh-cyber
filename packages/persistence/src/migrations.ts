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
  {
    version: 28,
    name: 'employee-presence-and-health',
    sql: `
      ALTER TABLE employee_instances
        ADD COLUMN health TEXT NOT NULL DEFAULT 'healthy'
        CHECK (health IN ('healthy', 'degraded', 'blocked'));
      ALTER TABLE employee_instances ADD COLUMN health_error_code TEXT;
      ALTER TABLE employee_instances ADD COLUMN health_detail TEXT;

      /* Legacy blocked values did not distinguish a one-turn failure from an
         actionable configuration problem. Preserve the signal as degraded,
         require an explicit new health decision for blocked, and make runtime
         presence entirely derivable from durable work facts. */
      UPDATE employee_instances
      SET health = CASE WHEN status = 'blocked' THEN 'degraded' ELSE 'healthy' END,
          health_error_code = CASE WHEN status = 'blocked' THEN 'legacy_employee_blocked' ELSE NULL END,
          health_detail = CASE WHEN status = 'blocked' THEN '需要重新检查角色运行配置' ELSE NULL END,
          status = CASE WHEN status = 'archived' THEN 'archived' ELSE 'available' END;

      CREATE INDEX employee_instances_world_health_idx
        ON employee_instances(world_id, health, created_at, id);
    `,
  },
  {
    version: 29,
    name: 'durable-completion-outbox',
    sql: `
      CREATE TABLE completion_jobs (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES work_sessions(id) ON DELETE CASCADE,
        work_turn_id TEXT NOT NULL REFERENCES work_turns(id) ON DELETE CASCADE,
        agent_run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        status TEXT NOT NULL CHECK (
          status IN ('pending', 'running', 'retrying', 'completed', 'failed', 'cancelled')
        ),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        available_at TEXT NOT NULL,
        lease_owner TEXT,
        lease_expires_at TEXT,
        last_error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (workspace_id, world_id) REFERENCES worlds(workspace_id, id) ON DELETE CASCADE
      ) STRICT;

      CREATE INDEX completion_jobs_claim_idx
        ON completion_jobs(status, available_at, lease_expires_at, created_at, id);
      CREATE INDEX completion_jobs_world_status_idx
        ON completion_jobs(world_id, status, updated_at DESC, id);
      CREATE INDEX completion_jobs_agent_run_idx
        ON completion_jobs(agent_run_id, created_at DESC, id);
    `,
  },
  {
    version: 30,
    name: 'sqlite-conversation-queue-lease',
    sql: `
      ALTER TABLE conversation_queue_entries ADD COLUMN lease_owner TEXT;
      ALTER TABLE conversation_queue_entries ADD COLUMN lease_expires_at TEXT;
      ALTER TABLE conversation_queue_entries
        ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0);
      ALTER TABLE conversation_queue_entries ADD COLUMN available_at TEXT;
      UPDATE conversation_queue_entries SET available_at = enqueued_at WHERE available_at IS NULL;

      DROP INDEX conversation_queue_world_order_idx;
      CREATE INDEX conversation_queue_claim_idx
        ON conversation_queue_entries(status, available_at, priority DESC, enqueued_at, id);
      CREATE INDEX conversation_queue_lease_idx
        ON conversation_queue_entries(status, lease_expires_at, id)
        WHERE status = 'running';
    `,
  },
  {
    version: 31,
    name: 'work-system-v1',
    sql: `
      CREATE TABLE work_tasks (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('draft','planning','ready','running','waiting-approval','waiting-review','changes-requested','completed','failed','cancelled','recovery-required')),
        priority TEXT NOT NULL CHECK (priority IN ('low','normal','high','urgent')),
        due_at TEXT,
        budget_json TEXT NOT NULL CHECK (json_valid(budget_json)),
        created_by TEXT NOT NULL,
        coordinator_employee_id TEXT REFERENCES employee_instances(id) ON DELETE SET NULL,
        current_plan_revision INTEGER NOT NULL DEFAULT 0 CHECK (current_plan_revision >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (workspace_id, world_id) REFERENCES worlds(workspace_id, id) ON DELETE CASCADE
      ) STRICT;
      CREATE INDEX work_tasks_world_status_idx ON work_tasks(world_id, status, updated_at DESC, id);

      CREATE TABLE task_plan_revisions (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES work_tasks(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL CHECK (revision > 0),
        status TEXT NOT NULL CHECK (status IN ('draft','active','superseded','completed','failed')),
        summary TEXT NOT NULL,
        execution_mode TEXT NOT NULL CHECK (execution_mode IN ('parallel','sequential','mixed')),
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (task_id, revision)
      ) STRICT;
      CREATE INDEX task_plan_revisions_task_idx ON task_plan_revisions(task_id, revision DESC);

      CREATE TABLE task_plan_steps (
        id TEXT PRIMARY KEY,
        plan_revision_id TEXT NOT NULL REFERENCES task_plan_revisions(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK (ordinal > 0),
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        required_skills_json TEXT NOT NULL CHECK (json_valid(required_skills_json)),
        assigned_employee_ids_json TEXT NOT NULL CHECK (json_valid(assigned_employee_ids_json)),
        depends_on_json TEXT NOT NULL CHECK (json_valid(depends_on_json)),
        execution_mode TEXT NOT NULL CHECK (execution_mode IN ('parallel','sequential')),
        expected_output TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending','ready','running','waiting','completed','failed','cancelled')),
        UNIQUE (plan_revision_id, ordinal)
      ) STRICT;

      CREATE TABLE task_assignments (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES work_tasks(id) ON DELETE CASCADE,
        plan_revision_id TEXT NOT NULL REFERENCES task_plan_revisions(id) ON DELETE CASCADE,
        step_id TEXT NOT NULL REFERENCES task_plan_steps(id) ON DELETE CASCADE,
        employee_id TEXT NOT NULL REFERENCES employee_instances(id) ON DELETE RESTRICT,
        assignment_reason_json TEXT NOT NULL CHECK (json_valid(assignment_reason_json)),
        required_skills_json TEXT NOT NULL CHECK (json_valid(required_skills_json)),
        status TEXT NOT NULL CHECK (status IN ('assigned','running','waiting','completed','failed','cancelled')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (plan_revision_id, step_id, employee_id)
      ) STRICT;
      CREATE INDEX task_assignments_employee_status_idx ON task_assignments(employee_id, status, updated_at DESC, id);

      CREATE TABLE task_runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES work_tasks(id) ON DELETE CASCADE,
        plan_revision_id TEXT NOT NULL REFERENCES task_plan_revisions(id) ON DELETE RESTRICT,
        attempt INTEGER NOT NULL CHECK (attempt > 0),
        work_turn_id TEXT NOT NULL REFERENCES work_turns(id) ON DELETE RESTRICT,
        agent_run_ids_json TEXT NOT NULL CHECK (json_valid(agent_run_ids_json)),
        status TEXT NOT NULL CHECK (status IN ('running','waiting-approval','completed','failed','cancelled','recovery-required')),
        cost REAL,
        latency REAL,
        error_code TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        UNIQUE (task_id, attempt)
      ) STRICT;
      CREATE INDEX task_runs_task_idx ON task_runs(task_id, attempt DESC);

      CREATE TABLE deliverables (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES work_tasks(id) ON DELETE CASCADE,
        task_run_id TEXT NOT NULL REFERENCES task_runs(id) ON DELETE RESTRICT,
        step_id TEXT REFERENCES task_plan_steps(id) ON DELETE SET NULL,
        submitted_by_employee_id TEXT NOT NULL REFERENCES employee_instances(id) ON DELETE RESTRICT,
        artifact_id TEXT NOT NULL,
        artifact_version_id INTEGER NOT NULL CHECK (artifact_version_id > 0),
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        evidence_refs_json TEXT NOT NULL CHECK (json_valid(evidence_refs_json)),
        version INTEGER NOT NULL CHECK (version > 0),
        status TEXT NOT NULL CHECK (status IN ('draft','submitted','accepted','changes-requested','rejected','superseded')),
        created_at TEXT NOT NULL,
        UNIQUE (task_id, version),
        UNIQUE (task_run_id, artifact_id, artifact_version_id),
        FOREIGN KEY (artifact_id, artifact_version_id) REFERENCES world_artifact_versions(artifact_id, version) ON DELETE RESTRICT
      ) STRICT;
      CREATE INDEX deliverables_task_idx ON deliverables(task_id, version DESC);

      CREATE TABLE reviews (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES work_tasks(id) ON DELETE CASCADE,
        deliverable_id TEXT NOT NULL REFERENCES deliverables(id) ON DELETE RESTRICT,
        reviewer_kind TEXT NOT NULL CHECK (reviewer_kind IN ('owner','employee','system')),
        reviewer_id TEXT NOT NULL,
        decision TEXT NOT NULL CHECK (decision IN ('accept','request-changes','reject')),
        feedback TEXT NOT NULL,
        rubric_json TEXT NOT NULL CHECK (json_valid(rubric_json)),
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX reviews_task_idx ON reviews(task_id, created_at DESC, id);

      CREATE TABLE growth_evidence (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL REFERENCES work_tasks(id) ON DELETE CASCADE,
        deliverable_id TEXT NOT NULL REFERENCES deliverables(id) ON DELETE RESTRICT,
        employee_id TEXT NOT NULL REFERENCES employee_instances(id) ON DELETE RESTRICT,
        skill_ids_json TEXT NOT NULL CHECK (json_valid(skill_ids_json)),
        outcome TEXT NOT NULL CHECK (outcome IN ('accepted','rejected')),
        summary TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (deliverable_id, employee_id, outcome)
      ) STRICT;
      CREATE INDEX growth_evidence_employee_idx ON growth_evidence(employee_id, created_at DESC, id);
    `,
  },
  {
    version: 32,
    name: 'persistent-owner-runtime-access',
    sql: `
      CREATE TABLE owner_runtime_access_grants (
        id TEXT PRIMARY KEY,
        world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES work_sessions(id) ON DELETE CASCADE,
        employee_ids_json TEXT NOT NULL CHECK (json_valid(employee_ids_json)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (world_id, session_id)
      ) STRICT;
      CREATE INDEX owner_runtime_access_grants_world_idx
        ON owner_runtime_access_grants(world_id, updated_at DESC, id);
    `,
  },
  {
    version: 33,
    name: 'employee-default-runtime-permission',
    sql: `
      ALTER TABLE employee_revisions
        ADD COLUMN runtime_permission_mode TEXT NOT NULL DEFAULT 'read-only'
        CHECK (runtime_permission_mode IN ('read-only','workspace-write','danger-full-access'));
    `,
  },
  {
    version: 34,
    name: 'workspace-ui-locale',
    sql: `
      ALTER TABLE workspace_preferences
        ADD COLUMN locale TEXT NOT NULL DEFAULT 'zh-CN'
        CHECK (locale IN ('zh-CN','zh-TW','en-US','ja-JP','ko-KR','es-ES','fr-FR','de-DE','pt-BR','ru-RU','ar-SA','hi-IN'));
    `,
  },
  {
    version: 35,
    name: 'character-avatar-assets',
    foreignKeysOff: true,
    sql: `
      DROP TABLE IF EXISTS character_avatar_assets;
      DROP INDEX local_assets_workspace_idx;
      ALTER TABLE local_assets RENAME TO local_assets_v34;

      CREATE TABLE local_assets (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('background', 'attachment', 'avatar')),
        mime_type TEXT NOT NULL CHECK (
          mime_type IN (
            'image/png', 'image/jpeg', 'image/webp', 'model/gltf-binary',
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
      FROM local_assets_v34;

      DROP TABLE local_assets_v34;
      CREATE INDEX local_assets_workspace_idx
        ON local_assets(workspace_id, kind, created_at DESC);

      CREATE TABLE character_avatar_assets (
        asset_id TEXT PRIMARY KEY REFERENCES local_assets(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
        employee_id TEXT NOT NULL REFERENCES employee_instances(id) ON DELETE CASCADE,
        renderer_kind TEXT NOT NULL CHECK (renderer_kind IN ('image-2d', 'vrm-3d', 'mesh-preview')),
        original_name TEXT NOT NULL,
        validation_json TEXT NOT NULL CHECK (json_valid(validation_json)),
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX character_avatar_assets_employee_idx
        ON character_avatar_assets(employee_id, created_at DESC, asset_id);
    `,
  },
  {
    version: 36,
    name: 'character-gender-and-voice-profile',
    sql: `
      ALTER TABLE employee_profile_revisions
        ADD COLUMN gender TEXT NOT NULL DEFAULT 'neutral'
        CHECK (gender IN ('female','male','neutral'));
      ALTER TABLE employee_profile_revisions
        ADD COLUMN voice_profile_json TEXT NOT NULL
        DEFAULT '{"provider":"auto","voiceId":"","speed":1.1,"pitch":1}'
        CHECK (json_valid(voice_profile_json));
    `,
  },
  {
    version: 37,
    name: 'employee-memory-index',
    sql: `
      CREATE TABLE employee_memory_index (
        memory_id TEXT PRIMARY KEY
          REFERENCES employee_milestones(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
        employee_id TEXT NOT NULL REFERENCES employee_instances(id) ON DELETE CASCADE,
        scope TEXT NOT NULL CHECK (scope IN ('private', 'group', 'task')),
        summary TEXT NOT NULL,
        keywords_json TEXT NOT NULL CHECK (json_valid(keywords_json)),
        entities_json TEXT NOT NULL CHECK (json_valid(entities_json)),
        source_message_ids_json TEXT NOT NULL CHECK (json_valid(source_message_ids_json)),
        artifact_refs_json TEXT NOT NULL CHECK (json_valid(artifact_refs_json)),
        importance REAL NOT NULL CHECK (importance >= 0 AND importance <= 1),
        occurred_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX employee_memory_index_employee_idx
        ON employee_memory_index(employee_id, scope, occurred_at DESC, memory_id);

      -- Forward-safe backfill: every existing milestone becomes an index row so
      -- retrieval never silently loses history recorded before this migration.
      -- The three automatic conversation titles are the ones that carry an
      -- isolation scope; anything else is an employee-owned public milestone.
      INSERT INTO employee_memory_index (
        memory_id, workspace_id, world_id, employee_id, scope, summary,
        keywords_json, entities_json, source_message_ids_json, artifact_refs_json,
        importance, occurred_at, updated_at
      )
      SELECT
        id, workspace_id, world_id, employee_id,
        CASE title
          WHEN '[private] 私聊记忆' THEN 'private'
          WHEN '[task] 任务经历' THEN 'task'
          ELSE 'group'
        END,
        summary, '[]', '[]', source_message_ids_json, artifact_refs_json,
        0.5, occurred_at, created_at
      FROM employee_milestones;
    `,
  },
  {
    version: 38,
    name: 'employee-milestone-origin',
    sql: `
      ALTER TABLE employee_milestones
        ADD COLUMN origin TEXT NOT NULL DEFAULT 'authored'
        CHECK (origin IN ('authored', 'activity-projection', 'legacy-conversation-projection'));

      -- Historical rows do not carry enough evidence to distinguish the retired
      -- projection from an owner-authored milestone with the same title. Keep
      -- every pre-migration row as authored: under-labelling leaves harmless
      -- legacy clutter, while guessing from display copy can destroy user data.
    `,
  },
  {
    version: 39,
    name: 'agent-run-context-snapshot',
    sql: `
      CREATE TABLE agent_run_context_snapshots (
        agent_run_id TEXT PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES work_sessions(id) ON DELETE CASCADE,
        employee_id TEXT NOT NULL REFERENCES employee_instances(id) ON DELETE CASCADE,
        snapshot_version INTEGER NOT NULL CHECK (snapshot_version > 0),
        envelope_version INTEGER NOT NULL CHECK (envelope_version > 0),
        stable_prefix_hash TEXT NOT NULL,
        structure_hash TEXT NOT NULL,
        total_token_estimate INTEGER NOT NULL CHECK (total_token_estimate >= 0),
        -- Structure and pointers only. There is deliberately no column a
        -- rendered prompt could be written into: a snapshot that stored text
        -- would be a second copy of user data with its own retention and its
        -- own leak surface, outliving the scope checks that produced it.
        layers_json TEXT NOT NULL CHECK (json_valid(layers_json)),
        cache_json TEXT NOT NULL CHECK (json_valid(cache_json)),
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX agent_run_context_snapshots_session_idx
        ON agent_run_context_snapshots(session_id, employee_id, created_at DESC, agent_run_id);
      CREATE INDEX agent_run_context_snapshots_prefix_idx
        ON agent_run_context_snapshots(stable_prefix_hash, created_at DESC);
    `,
  },
  {
    version: 40,
    name: 'model-hub-provider-connections',
    sql: `
      -- One row per provider connection: an endpoint, a transport and one
      -- credential. Model profiles (the assignable units) hang underneath via
      -- provider_id; every consumer — assignments, worker launch, knowledge —
      -- keeps reading profiles exactly as before.
      CREATE TABLE model_providers (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('builtin', 'custom', 'local')),
        catalog_ref TEXT,
        name TEXT NOT NULL,
        base_url TEXT NOT NULL,
        api TEXT NOT NULL CHECK (
          api IN ('openai-completions', 'openai-responses', 'anthropic-messages')
        ),
        provider_kind TEXT NOT NULL CHECK (
          provider_kind IN ('deepseek', 'openai-compatible-local', 'openai-compatible-remote')
        ),
        credential_env_name TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX model_providers_workspace_idx
        ON model_providers(workspace_id, name, id);

      ALTER TABLE model_profiles ADD COLUMN provider_id TEXT REFERENCES model_providers(id) ON DELETE RESTRICT;
      ALTER TABLE model_profiles ADD COLUMN origin TEXT NOT NULL DEFAULT 'manual'
        CHECK (origin IN ('manual', 'imported'));
      -- Capability probes write only verdicts, never request or response bodies.
      ALTER TABLE model_profiles ADD COLUMN capabilities_json TEXT
        CHECK (capabilities_json IS NULL OR json_valid(capabilities_json));
      ALTER TABLE model_profiles ADD COLUMN probed_at TEXT;

      -- Import is idempotent per provider+model; legacy unassigned profiles keep
      -- sharing the plain (workspace, model) semantics they always had.
      CREATE UNIQUE INDEX model_profiles_provider_model_idx
        ON model_profiles(workspace_id, provider_id, model_id) WHERE provider_id IS NOT NULL;

      -- Backfill: group the profiles that already exist by connection shape so
      -- the hub opens onto real providers instead of an empty list. Credentials
      -- are part of the connection shape: two profiles with different secret
      -- references must not be collapsed into one provider. The name is the
      -- group's display name; when a group held several, the alphabetically
      -- first — a label, never a behavior.
      INSERT INTO model_providers
        (id, workspace_id, kind, catalog_ref, name, base_url, api, provider_kind, credential_env_name, created_at, updated_at)
      SELECT
        'provider-' || lower(hex(randomblob(8))),
        g.workspace_id,
        CASE g.provider_kind WHEN 'openai-compatible-local' THEN 'local' ELSE 'custom' END,
        NULL,
        MIN(g.display_name),
        g.base_url,
        g.api,
        g.provider_kind,
        MIN(g.credential_env_name),
        MIN(g.created_at),
        MAX(g.updated_at)
      FROM (
        SELECT workspace_id, base_url, api, provider_kind,
               display_name, credential_env_name, created_at, updated_at
        FROM model_profiles
      ) g
      GROUP BY g.workspace_id, g.base_url, g.api, g.provider_kind, g.credential_env_name;

      UPDATE model_profiles
      SET provider_id = (
        SELECT mp.id FROM model_providers mp
        WHERE mp.workspace_id = model_profiles.workspace_id
          AND mp.base_url = model_profiles.base_url
          AND mp.api = model_profiles.api
          AND mp.provider_kind = model_profiles.provider_kind
          AND mp.credential_env_name IS model_profiles.credential_env_name
        ORDER BY mp.name, mp.id
        LIMIT 1
      )
      WHERE provider_id IS NULL
        -- Legacy storage allowed duplicate rows for one model. Link only the
        -- deterministic first row; leave the other manual rows unassigned so
        -- the new provider+model uniqueness index cannot make migration fail
        -- or silently discard user data.
        AND model_profiles.id = (
          SELECT MIN(duplicate.id)
          FROM model_profiles duplicate
          WHERE duplicate.workspace_id = model_profiles.workspace_id
            AND duplicate.base_url = model_profiles.base_url
            AND duplicate.api = model_profiles.api
            AND duplicate.provider_kind = model_profiles.provider_kind
            AND duplicate.model_id = model_profiles.model_id
            AND duplicate.credential_env_name IS model_profiles.credential_env_name
        );
    `,
  },
  {
    version: 41,
    name: 'work-task-source-link',
    sql: `
      -- A task that grew out of a conversation remembers the turn that asked
      -- for it and the owner message inside that turn. The turn id is the one
      -- identity a resend, a recovery pass and a retry all share, so "one task
      -- per turn" is a unique index the database enforces rather than a check
      -- a process has to remember. NULLs are distinct to SQLite: tasks created
      -- from the board or a schedule carry no source and are unaffected.
      --
      -- pruneHistory deletes settled turns. The link is released (SET NULL)
      -- and the task survives: the task is the durable work fact, the
      -- transcript is not. Messages are never pruned, so the message reference
      -- outlives the turn. No backfill: rows that predate this migration have
      -- no source and stay exactly as they are.
      ALTER TABLE work_tasks ADD COLUMN source_work_turn_id TEXT
        REFERENCES work_turns(id) ON DELETE SET NULL;
      ALTER TABLE work_tasks ADD COLUMN source_message_id TEXT
        REFERENCES messages(id) ON DELETE SET NULL;
      CREATE UNIQUE INDEX work_tasks_source_work_turn_idx
        ON work_tasks(source_work_turn_id);
      CREATE INDEX work_tasks_source_message_idx
        ON work_tasks(source_message_id) WHERE source_message_id IS NOT NULL;
    `,
  },
  {
    version: 42,
    name: 'knowledge-source-version-chunk-watermark',
    sql: `
      -- A document is loaded at most 40 chunks at a time and one extraction
      -- covers about 16,000 characters, but the only durable record of that
      -- work was "this job finished" — so a long document read as fully
      -- 已整理 after its first window. This table is the missing fact: one row
      -- per identifiable revision of a chunked source, carrying how far
      -- extraction has actually got through it.
      --
      -- content_hash is the version identity (a document's sha256, an
      -- artifact's version), so changed content becomes a new row instead of
      -- silently overwriting the old one's history. processed_chunks is both
      -- the resume cursor and the completion watermark: a version is complete
      -- only when it equals chunk_total, which the CHECK on completed_at makes
      -- impossible to fake. A failed window simply leaves it where it was.
      --
      -- superseded_at / superseded_by_hash mark a version whose content has
      -- since changed. Marking is all this migration does: the claims that
      -- were extracted from that content are NOT deleted, because deciding
      -- whether to downgrade, re-verify or keep a user's organised knowledge
      -- is an explicit later pass that reads exactly these rows.
      --
      -- No backfill. How much of any existing document the pre-42 runs really
      -- covered is unknown, and writing a completed watermark from a guess
      -- would be the same lie this table exists to remove. Sources with no row
      -- are simply walked from chunk 0; applying an extraction is idempotent
      -- on evidence and statement fingerprints, so a re-walk restates the same
      -- graph rows rather than duplicating them.
      CREATE TABLE knowledge_source_versions (
        workspace_id TEXT NOT NULL,
        world_id TEXT NOT NULL,
        source_type TEXT NOT NULL CHECK (source_type IN ('document', 'artifact')),
        source_id TEXT NOT NULL,
        content_hash TEXT NOT NULL CHECK (length(content_hash) BETWEEN 1 AND 128),
        chunk_total INTEGER NOT NULL CHECK (chunk_total >= 0),
        processed_chunks INTEGER NOT NULL DEFAULT 0
          CHECK (processed_chunks >= 0 AND processed_chunks <= chunk_total),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        superseded_at TEXT,
        superseded_by_hash TEXT,
        PRIMARY KEY (world_id, source_type, source_id, content_hash),
        CHECK (completed_at IS NULL OR processed_chunks = chunk_total),
        CHECK (superseded_by_hash IS NULL OR superseded_at IS NOT NULL),
        FOREIGN KEY (workspace_id, world_id)
          REFERENCES worlds(workspace_id, id)
          ON DELETE CASCADE
      ) STRICT;

      -- At most one current version per source is a database rule, not
      -- something a process has to remember while two scans overlap.
      CREATE UNIQUE INDEX knowledge_source_versions_current_idx
        ON knowledge_source_versions(world_id, source_type, source_id)
        WHERE superseded_at IS NULL;

      -- The read side of the invalidation seam: what a later evidence
      -- downgrade pass has to look at, oldest first.
      CREATE INDEX knowledge_source_versions_superseded_idx
        ON knowledge_source_versions(world_id, superseded_at, source_type, source_id)
        WHERE superseded_at IS NOT NULL;
    `,
  },
  {
    version: 43,
    name: 'knowledge-evidence-invalidation',
    sql: `
      -- Migration 42 marked a source revision as superseded and deliberately
      -- stopped there: what should happen to the claims extracted from content
      -- the world no longer holds was left as an explicit decision. This is
      -- that decision, written into the schema.
      --
      -- A claim whose every supporting evidence belongs to a superseded
      -- revision becomes NOT CURRENT: it keeps its row, its status, its
      -- evidence and its place in the graph the owner is looking at, and it
      -- stops being handed to a model as if it were still true. Deleting it
      -- would destroy organised knowledge over a file edit; leaving it in
      -- retrieval would let the product assert something it can no longer
      -- support. Neither is acceptable, so the mark is a separate nullable
      -- fact rather than a fifth status value: a claim can be conflicted and
      -- not-current at the same time, and clearing the mark restores exactly
      -- the state the claim already had.
      --
      -- not_current_source_type/id/hash name the revision the statement was
      -- last supported by, which is what lets the library row say "N 条主张待
      -- 重新核对" for one source without scanning the whole graph, and what the
      -- pass compares against when a version becomes current again.
      ALTER TABLE knowledge_claims ADD COLUMN not_current_since TEXT;
      ALTER TABLE knowledge_claims ADD COLUMN not_current_source_type TEXT
        CHECK (not_current_source_type IS NULL OR not_current_source_type IN ('document', 'artifact'));
      ALTER TABLE knowledge_claims ADD COLUMN not_current_source_id TEXT;
      ALTER TABLE knowledge_claims ADD COLUMN not_current_source_hash TEXT;

      ALTER TABLE knowledge_relations ADD COLUMN not_current_since TEXT;
      ALTER TABLE knowledge_relations ADD COLUMN not_current_source_type TEXT
        CHECK (not_current_source_type IS NULL OR not_current_source_type IN ('document', 'artifact'));
      ALTER TABLE knowledge_relations ADD COLUMN not_current_source_id TEXT;
      ALTER TABLE knowledge_relations ADD COLUMN not_current_source_hash TEXT;

      CREATE INDEX IF NOT EXISTS knowledge_claims_not_current_idx
        ON knowledge_claims(world_id, not_current_source_type, not_current_source_id, id)
        WHERE not_current_since IS NOT NULL;
      CREATE INDEX IF NOT EXISTS knowledge_relations_not_current_idx
        ON knowledge_relations(world_id, not_current_source_type, not_current_source_id, id)
        WHERE not_current_since IS NOT NULL;

      -- The pass's own resume marker. It is a timestamp, not a flag, because a
      -- version can be superseded, become current again (a restored artifact,
      -- a re-imported file) and be superseded once more; comparing it with
      -- superseded_at re-opens exactly that row instead of skipping it.
      ALTER TABLE knowledge_source_versions ADD COLUMN invalidated_at TEXT;

      -- No backfill. Every existing claim stays current: which of them lost
      -- their evidence is decided by reading the source versions, and writing
      -- a downgrade from a guess would be the same lie the version table was
      -- added to remove. The pass walks the superseded rows on its own.
      CREATE INDEX IF NOT EXISTS knowledge_source_versions_pending_invalidation_idx
        ON knowledge_source_versions(world_id, superseded_at, source_type, source_id)
        WHERE superseded_at IS NOT NULL AND invalidated_at IS NULL;
    `,
  },
]

/**
 * How many migrations this build actually ships.
 *
 * It is not the same as `CYBER_SCHEMA_VERSION`, because version numbers are
 * claimed by whichever branch opens a PR first and one of them (38) is not on
 * this branch. A fully migrated database therefore holds `MIGRATION_COUNT`
 * rows in `schema_migrations` while `PRAGMA user_version` reads the highest
 * version. Health checks must compare against this, not against the version.
 */
export const MIGRATION_COUNT = MIGRATIONS.length

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

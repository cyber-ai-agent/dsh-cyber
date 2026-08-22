import type { DatabaseSync } from 'node:sqlite'

import type {
  CharacterActionPlan,
  CharacterActionStep,
  CharacterPresence,
  SharedWorldEpisode,
  WorldSlotReservation,
} from '@dsh-cyber/contracts/world-simulation'

import { PersistenceError } from './errors.js'
import type { SqliteStore } from './sqlite-store.js'

const SIMULATION_SCHEMA_VERSION = 1

export class WorldSimulationStore {
  readonly #database: DatabaseSync

  constructor(store: SqliteStore) {
    this.#database = store.database
    this.#ensureSchema()
  }

  listPresences(worldId: string): CharacterPresence[] {
    return this.#database
      .prepare('SELECT * FROM world_character_presence WHERE world_id = ? ORDER BY character_id')
      .all(worldId)
      .map(mapPresence)
  }

  getPresence(characterId: string): CharacterPresence | undefined {
    const row = this.#database
      .prepare('SELECT * FROM world_character_presence WHERE character_id = ?')
      .get(characterId)
    return row === undefined ? undefined : mapPresence(row)
  }

  savePresence(presence: CharacterPresence): CharacterPresence {
    this.#database
      .prepare(
        `INSERT INTO world_character_presence (
           character_id, world_id, scene_id, zone_id, home_slot_id, current_slot_id,
           reserved_slot_id, facing, physical_state, status, active_plan_id, active_session_id, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(character_id) DO UPDATE SET
           world_id = excluded.world_id,
           scene_id = excluded.scene_id,
           zone_id = excluded.zone_id,
           home_slot_id = excluded.home_slot_id,
           current_slot_id = excluded.current_slot_id,
           reserved_slot_id = excluded.reserved_slot_id,
           facing = excluded.facing,
           physical_state = excluded.physical_state,
           status = excluded.status,
           active_plan_id = excluded.active_plan_id,
           active_session_id = excluded.active_session_id,
           updated_at = excluded.updated_at`,
      )
      .run(
        presence.characterId,
        presence.worldId,
        presence.sceneId,
        presence.zoneId,
        presence.homeSlotId,
        presence.currentSlotId,
        presence.reservedSlotId ?? null,
        presence.facing,
        presence.physicalState,
        presence.status ?? null,
        presence.activePlanId ?? null,
        presence.activeSessionId ?? null,
        presence.updatedAt,
      )
    return { ...presence }
  }

  savePresences(presences: readonly CharacterPresence[]): void {
    this.#transaction(() => {
      for (const presence of presences) this.savePresence(presence)
    })
  }

  removePresence(characterId: string): boolean {
    return this.#database
      .prepare('DELETE FROM world_character_presence WHERE character_id = ?')
      .run(characterId).changes > 0
  }

  listReservations(worldId: string): WorldSlotReservation[] {
    return this.#database
      .prepare('SELECT * FROM world_slot_reservations WHERE world_id = ? ORDER BY slot_id, character_id')
      .all(worldId)
      .map(mapReservation)
  }

  saveReservations(reservations: readonly WorldSlotReservation[]): void {
    this.#transaction(() => {
      for (const reservation of reservations) {
        this.#database
          .prepare(
            `INSERT INTO world_slot_reservations (
               id, world_id, slot_id, character_id, plan_id, status, priority,
               reserved_at, expires_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               status = excluded.status,
               priority = excluded.priority,
               expires_at = excluded.expires_at,
               updated_at = excluded.updated_at`,
          )
          .run(
            reservation.id,
            reservation.worldId,
            reservation.slotId,
            reservation.characterId,
            reservation.planId,
            reservation.status,
            reservation.priority,
            reservation.reservedAt,
            reservation.expiresAt,
            reservation.updatedAt,
          )
      }
    })
  }

  releasePlanReservations(planId: string): number {
    return Number(this.#database
      .prepare('DELETE FROM world_slot_reservations WHERE plan_id = ?')
      .run(planId).changes)
  }

  cleanupExpiredReservations(now: string): number {
    return Number(this.#database
      .prepare('DELETE FROM world_slot_reservations WHERE expires_at <= ?')
      .run(now).changes)
  }

  getActionPlan(planId: string): CharacterActionPlan | undefined {
    const row = this.#database.prepare('SELECT * FROM world_action_plans WHERE id = ?').get(planId)
    if (row === undefined) return undefined
    const steps = this.#database
      .prepare('SELECT * FROM world_action_steps WHERE plan_id = ? ORDER BY sequence')
      .all(planId)
      .map(mapActionStep)
    return mapActionPlan(row, steps)
  }

  listActionPlans(worldId: string, characterId?: string): CharacterActionPlan[] {
    const rows = characterId === undefined
      ? this.#database
          .prepare('SELECT * FROM world_action_plans WHERE world_id = ? ORDER BY created_at, id')
          .all(worldId)
      : this.#database
          .prepare('SELECT * FROM world_action_plans WHERE world_id = ? AND character_id = ? ORDER BY created_at, id')
          .all(worldId, characterId)
    return rows.map((row) => {
      const id = stringColumn(row, 'id')
      const steps = this.#database
        .prepare('SELECT * FROM world_action_steps WHERE plan_id = ? ORDER BY sequence')
        .all(id)
        .map(mapActionStep)
      return mapActionPlan(row, steps)
    })
  }

  saveActionPlan(plan: CharacterActionPlan): CharacterActionPlan {
    this.#transaction(() => {
      this.#database
        .prepare(
          `INSERT INTO world_action_plans (
             id, world_id, character_id, source, reason, priority, interruptible, status,
             causation_id, correlation_id, created_at, started_at, completed_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             status = excluded.status,
             started_at = excluded.started_at,
             completed_at = excluded.completed_at`,
        )
        .run(
          plan.id,
          plan.worldId,
          plan.characterId,
          plan.source,
          plan.reason,
          plan.priority,
          plan.interruptible ? 1 : 0,
          plan.status,
          plan.causationId ?? null,
          plan.correlationId ?? null,
          plan.createdAt,
          plan.startedAt ?? null,
          plan.completedAt ?? null,
        )
      for (const step of plan.steps) this.#saveActionStep(step)
    })
    return structuredClone(plan)
  }

  recordSharedEpisode(episode: SharedWorldEpisode): SharedWorldEpisode {
    if (episode.importance < 0 || episode.importance > 100) {
      throw new PersistenceError('Shared world episode importance must be between 0 and 100')
    }
    this.#database
      .prepare(
        `INSERT INTO world_shared_episodes (
           id, world_id, participant_ids_json, session_id, task_id, kind, title, summary,
           outcome, source_event_ids_json, source_message_ids_json, importance, occurred_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        episode.id,
        episode.worldId,
        JSON.stringify(episode.participantIds),
        episode.sessionId ?? null,
        episode.taskId ?? null,
        episode.kind,
        episode.title,
        episode.summary,
        episode.outcome,
        JSON.stringify(episode.sourceEventIds),
        JSON.stringify(episode.sourceMessageIds),
        episode.importance,
        episode.occurredAt,
        episode.createdAt,
      )
    return structuredClone(episode)
  }

  listSharedEpisodes(worldId: string, characterId?: string): SharedWorldEpisode[] {
    const rows = this.#database
      .prepare('SELECT * FROM world_shared_episodes WHERE world_id = ? ORDER BY occurred_at DESC, id')
      .all(worldId)
      .map(mapSharedEpisode)
    return characterId === undefined
      ? rows
      : rows.filter((episode) => episode.participantIds.includes(characterId))
  }

  #saveActionStep(step: CharacterActionStep): void {
    this.#database
      .prepare(
        `INSERT INTO world_action_steps (
           id, plan_id, sequence, kind, payload_json, status, started_at, due_at, completed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           payload_json = excluded.payload_json,
           status = excluded.status,
           started_at = excluded.started_at,
           due_at = excluded.due_at,
           completed_at = excluded.completed_at`,
      )
      .run(
        step.id,
        step.planId,
        step.sequence,
        step.kind,
        JSON.stringify(step.payload),
        step.status,
        step.startedAt ?? null,
        step.dueAt ?? null,
        step.completedAt ?? null,
      )
  }

  #ensureSchema(): void {
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      this.#database.exec(`
        CREATE TABLE IF NOT EXISTS world_simulation_schema (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE IF NOT EXISTS world_character_presence (
          character_id TEXT PRIMARY KEY REFERENCES employee_instances(id) ON DELETE CASCADE,
          world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
          scene_id TEXT NOT NULL,
          zone_id TEXT NOT NULL,
          home_slot_id TEXT NOT NULL,
          current_slot_id TEXT NOT NULL,
          reserved_slot_id TEXT,
          facing TEXT NOT NULL CHECK (facing IN ('north', 'east', 'south', 'west')),
          physical_state TEXT NOT NULL CHECK (
            physical_state IN (
              'at-home', 'navigating', 'positioning', 'thinking', 'speaking', 'listening',
              'working', 'using-object', 'meeting', 'waiting', 'blocked'
            )
          ),
          status TEXT CHECK (status IN ('available', 'working', 'waiting', 'blocked', 'archived')),
          active_plan_id TEXT,
          active_session_id TEXT,
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE INDEX IF NOT EXISTS world_character_presence_world_idx
          ON world_character_presence(world_id, zone_id, current_slot_id, character_id);

        CREATE TABLE IF NOT EXISTS world_action_plans (
          id TEXT PRIMARY KEY,
          world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
          character_id TEXT NOT NULL REFERENCES employee_instances(id) ON DELETE CASCADE,
          source TEXT NOT NULL CHECK (source IN ('user', 'task', 'conversation', 'role-routine', 'ambient', 'system')),
          reason TEXT NOT NULL,
          priority INTEGER NOT NULL,
          interruptible INTEGER NOT NULL CHECK (interruptible IN (0, 1)),
          status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'cancelled', 'failed')),
          causation_id TEXT,
          correlation_id TEXT,
          created_at TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT
        ) STRICT;

        CREATE INDEX IF NOT EXISTS world_action_plans_character_idx
          ON world_action_plans(world_id, character_id, status, created_at DESC);

        CREATE TABLE IF NOT EXISTS world_action_steps (
          id TEXT PRIMARY KEY,
          plan_id TEXT NOT NULL REFERENCES world_action_plans(id) ON DELETE CASCADE,
          sequence INTEGER NOT NULL CHECK (sequence > 0),
          kind TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'cancelled', 'failed')),
          started_at TEXT,
          due_at TEXT,
          completed_at TEXT,
          UNIQUE(plan_id, sequence)
        ) STRICT;

        CREATE TABLE IF NOT EXISTS world_slot_reservations (
          id TEXT PRIMARY KEY,
          world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
          slot_id TEXT NOT NULL,
          character_id TEXT NOT NULL REFERENCES employee_instances(id) ON DELETE CASCADE,
          plan_id TEXT NOT NULL REFERENCES world_action_plans(id) ON DELETE CASCADE,
          status TEXT NOT NULL CHECK (status IN ('reserved', 'occupied')),
          priority INTEGER NOT NULL,
          reserved_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE UNIQUE INDEX IF NOT EXISTS world_slot_reservations_slot_idx
          ON world_slot_reservations(world_id, slot_id);

        CREATE TABLE IF NOT EXISTS world_shared_episodes (
          id TEXT PRIMARY KEY,
          world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
          participant_ids_json TEXT NOT NULL,
          session_id TEXT REFERENCES work_sessions(id) ON DELETE SET NULL,
          task_id TEXT,
          kind TEXT NOT NULL CHECK (kind IN ('conversation', 'collaboration', 'conflict', 'handoff', 'celebration')),
          title TEXT NOT NULL,
          summary TEXT NOT NULL,
          outcome TEXT NOT NULL,
          source_event_ids_json TEXT NOT NULL,
          source_message_ids_json TEXT NOT NULL,
          importance INTEGER NOT NULL CHECK (importance BETWEEN 0 AND 100),
          occurred_at TEXT NOT NULL,
          created_at TEXT NOT NULL
        ) STRICT;

        CREATE INDEX IF NOT EXISTS world_shared_episodes_world_idx
          ON world_shared_episodes(world_id, occurred_at DESC, id);
      `)
      this.#database
        .prepare('INSERT OR IGNORE INTO world_simulation_schema (version, applied_at) VALUES (?, ?)')
        .run(SIMULATION_SCHEMA_VERSION, new Date().toISOString())
      this.#database.exec('COMMIT')
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
  }

  #transaction<T>(operation: () => T): T {
    this.#database.exec('SAVEPOINT world_simulation_store')
    try {
      const result = operation()
      this.#database.exec('RELEASE world_simulation_store')
      return result
    } catch (error) {
      this.#database.exec('ROLLBACK TO world_simulation_store')
      this.#database.exec('RELEASE world_simulation_store')
      throw error
    }
  }
}

function mapPresence(row: unknown): CharacterPresence {
  const value = record(row)
  return {
    worldId: stringColumn(value, 'world_id'),
    characterId: stringColumn(value, 'character_id'),
    sceneId: stringColumn(value, 'scene_id'),
    zoneId: stringColumn(value, 'zone_id'),
    homeSlotId: stringColumn(value, 'home_slot_id'),
    currentSlotId: stringColumn(value, 'current_slot_id'),
    ...optionalString(value, 'reserved_slot_id', 'reservedSlotId'),
    facing: stringColumn(value, 'facing') as CharacterPresence['facing'],
    physicalState: stringColumn(value, 'physical_state') as CharacterPresence['physicalState'],
    ...optionalString(value, 'status', 'status'),
    ...optionalString(value, 'active_plan_id', 'activePlanId'),
    ...optionalString(value, 'active_session_id', 'activeSessionId'),
    updatedAt: stringColumn(value, 'updated_at'),
  } as CharacterPresence
}

function mapReservation(row: unknown): WorldSlotReservation {
  const value = record(row)
  return {
    id: stringColumn(value, 'id'),
    worldId: stringColumn(value, 'world_id'),
    slotId: stringColumn(value, 'slot_id'),
    characterId: stringColumn(value, 'character_id'),
    planId: stringColumn(value, 'plan_id'),
    status: stringColumn(value, 'status') as WorldSlotReservation['status'],
    priority: numberColumn(value, 'priority'),
    reservedAt: stringColumn(value, 'reserved_at'),
    expiresAt: stringColumn(value, 'expires_at'),
    updatedAt: stringColumn(value, 'updated_at'),
  }
}

function mapActionPlan(row: unknown, steps: CharacterActionStep[]): CharacterActionPlan {
  const value = record(row)
  return {
    id: stringColumn(value, 'id'),
    worldId: stringColumn(value, 'world_id'),
    characterId: stringColumn(value, 'character_id'),
    source: stringColumn(value, 'source') as CharacterActionPlan['source'],
    reason: stringColumn(value, 'reason'),
    priority: numberColumn(value, 'priority'),
    interruptible: numberColumn(value, 'interruptible') === 1,
    status: stringColumn(value, 'status') as CharacterActionPlan['status'],
    steps,
    ...optionalString(value, 'causation_id', 'causationId'),
    ...optionalString(value, 'correlation_id', 'correlationId'),
    createdAt: stringColumn(value, 'created_at'),
    ...optionalString(value, 'started_at', 'startedAt'),
    ...optionalString(value, 'completed_at', 'completedAt'),
  }
}

function mapActionStep(row: unknown): CharacterActionStep {
  const value = record(row)
  return {
    id: stringColumn(value, 'id'),
    planId: stringColumn(value, 'plan_id'),
    sequence: numberColumn(value, 'sequence'),
    kind: stringColumn(value, 'kind') as CharacterActionStep['kind'],
    payload: JSON.parse(stringColumn(value, 'payload_json')) as CharacterActionStep['payload'],
    status: stringColumn(value, 'status') as CharacterActionStep['status'],
    ...optionalString(value, 'started_at', 'startedAt'),
    ...optionalString(value, 'due_at', 'dueAt'),
    ...optionalString(value, 'completed_at', 'completedAt'),
  }
}

function mapSharedEpisode(row: unknown): SharedWorldEpisode {
  const value = record(row)
  return {
    id: stringColumn(value, 'id'),
    worldId: stringColumn(value, 'world_id'),
    participantIds: JSON.parse(stringColumn(value, 'participant_ids_json')) as string[],
    ...optionalString(value, 'session_id', 'sessionId'),
    ...optionalString(value, 'task_id', 'taskId'),
    kind: stringColumn(value, 'kind') as SharedWorldEpisode['kind'],
    title: stringColumn(value, 'title'),
    summary: stringColumn(value, 'summary'),
    outcome: stringColumn(value, 'outcome'),
    sourceEventIds: JSON.parse(stringColumn(value, 'source_event_ids_json')) as string[],
    sourceMessageIds: JSON.parse(stringColumn(value, 'source_message_ids_json')) as string[],
    importance: numberColumn(value, 'importance'),
    occurredAt: stringColumn(value, 'occurred_at'),
    createdAt: stringColumn(value, 'created_at'),
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) throw new PersistenceError('Invalid world simulation row')
  return value as Record<string, unknown>
}

function stringColumn(value: Record<string, unknown>, key: string): string {
  const entry = value[key]
  if (typeof entry !== 'string') throw new PersistenceError(`Invalid world simulation column: ${key}`)
  return entry
}

function numberColumn(value: Record<string, unknown>, key: string): number {
  const entry = value[key]
  if (typeof entry !== 'number') throw new PersistenceError(`Invalid world simulation column: ${key}`)
  return entry
}

function optionalString<K extends string>(
  value: Record<string, unknown>,
  databaseKey: string,
  outputKey: K,
): Partial<Record<K, string>> {
  const entry = value[databaseKey]
  return typeof entry === 'string' ? { [outputKey]: entry } as Partial<Record<K, string>> : {}
}

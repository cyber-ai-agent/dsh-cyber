import type { DatabaseSync } from 'node:sqlite'

import type { SqliteStore } from '@dsh-cyber/persistence'
import type { AmbientWorldPolicy } from '@dsh-cyber/world-simulation'

import { ServiceError } from './service-error.js'

export interface WorldAmbientLifeSettings extends Required<AmbientWorldPolicy> {
  worldId: string
  updatedAt: string
}

export interface UpdateWorldAmbientLifeSettings {
  enabled?: boolean
  minimumIdleMs?: number
  minimumAmbientIntervalMs?: number
  socialCooldownMs?: number
  breakAfterMs?: number
  timeBucketMs?: number
  maximumPlansPerTick?: number
}

const DEFAULT_SETTINGS: Omit<WorldAmbientLifeSettings, 'worldId' | 'updatedAt'> = {
  enabled: false,
  minimumIdleMs: 45_000,
  minimumAmbientIntervalMs: 180_000,
  socialCooldownMs: 900_000,
  breakAfterMs: 1_800_000,
  timeBucketMs: 300_000,
  maximumPlansPerTick: 3,
}

export class AmbientLifeSettingsService {
  readonly #store: SqliteStore
  readonly #database: DatabaseSync
  readonly #clock: () => string

  constructor(store: SqliteStore, clock: () => string = () => new Date().toISOString()) {
    this.#store = store
    this.#database = store.database
    this.#clock = clock
    this.#ensureSchema()
  }

  get(worldId: string): WorldAmbientLifeSettings {
    const world = this.#requireWorld(worldId)
    const row = this.#database
      .prepare('SELECT * FROM world_ambient_life_settings WHERE world_id = ?')
      .get(world.id) as Record<string, unknown> | undefined
    if (row === undefined) {
      return { worldId: world.id, ...DEFAULT_SETTINGS, updatedAt: world.updatedAt }
    }
    return mapSettings(row)
  }

  update(worldId: string, input: UpdateWorldAmbientLifeSettings): WorldAmbientLifeSettings {
    const previous = this.get(worldId)
    const next: WorldAmbientLifeSettings = {
      worldId: previous.worldId,
      enabled: input.enabled ?? previous.enabled,
      minimumIdleMs: input.minimumIdleMs ?? previous.minimumIdleMs,
      minimumAmbientIntervalMs: input.minimumAmbientIntervalMs ?? previous.minimumAmbientIntervalMs,
      socialCooldownMs: input.socialCooldownMs ?? previous.socialCooldownMs,
      breakAfterMs: input.breakAfterMs ?? previous.breakAfterMs,
      timeBucketMs: input.timeBucketMs ?? previous.timeBucketMs,
      maximumPlansPerTick: input.maximumPlansPerTick ?? previous.maximumPlansPerTick,
      updatedAt: this.#clock(),
    }
    validateSettings(next)
    this.#database
      .prepare(
        `INSERT INTO world_ambient_life_settings (
           world_id, enabled, minimum_idle_ms, minimum_ambient_interval_ms,
           social_cooldown_ms, break_after_ms, time_bucket_ms,
           maximum_plans_per_tick, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(world_id) DO UPDATE SET
           enabled = excluded.enabled,
           minimum_idle_ms = excluded.minimum_idle_ms,
           minimum_ambient_interval_ms = excluded.minimum_ambient_interval_ms,
           social_cooldown_ms = excluded.social_cooldown_ms,
           break_after_ms = excluded.break_after_ms,
           time_bucket_ms = excluded.time_bucket_ms,
           maximum_plans_per_tick = excluded.maximum_plans_per_tick,
           updated_at = excluded.updated_at`,
      )
      .run(
        next.worldId,
        next.enabled ? 1 : 0,
        next.minimumIdleMs,
        next.minimumAmbientIntervalMs,
        next.socialCooldownMs,
        next.breakAfterMs,
        next.timeBucketMs,
        next.maximumPlansPerTick,
        next.updatedAt,
      )
    return next
  }

  listEnabled(): WorldAmbientLifeSettings[] {
    return (this.#database
      .prepare('SELECT * FROM world_ambient_life_settings WHERE enabled = 1 ORDER BY world_id')
      .all() as Record<string, unknown>[]).map(mapSettings)
  }

  #requireWorld(worldId: string) {
    const normalized = worldId.trim()
    const world = normalized ? this.#store.getWorld(normalized) : undefined
    if (world === undefined || world.status === 'archived') {
      throw new ServiceError('not-found', 'world_not_found', '世界不存在或已归档', 404)
    }
    return world
  }

  #ensureSchema(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS world_ambient_life_settings (
        world_id TEXT PRIMARY KEY REFERENCES worlds(id) ON DELETE CASCADE,
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        minimum_idle_ms INTEGER NOT NULL,
        minimum_ambient_interval_ms INTEGER NOT NULL,
        social_cooldown_ms INTEGER NOT NULL,
        break_after_ms INTEGER NOT NULL,
        time_bucket_ms INTEGER NOT NULL,
        maximum_plans_per_tick INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
    `)
  }
}

function validateSettings(value: WorldAmbientLifeSettings): void {
  boundedInteger('最短空闲时间', value.minimumIdleMs, 5_000, 3_600_000)
  boundedInteger('日常行为间隔', value.minimumAmbientIntervalMs, 30_000, 86_400_000)
  boundedInteger('角色社交冷却', value.socialCooldownMs, 60_000, 604_800_000)
  boundedInteger('休息触发时间', value.breakAfterMs, 300_000, 86_400_000)
  boundedInteger('确定性时间桶', value.timeBucketMs, 60_000, 3_600_000)
  boundedInteger('单次最大行为数', value.maximumPlansPerTick, 1, 16)
}

function boundedInteger(label: string, value: number | undefined, minimum: number, maximum: number): void {
  if (value === undefined || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new ServiceError('invalid', 'invalid_ambient_setting', `${label}必须在 ${minimum} 到 ${maximum} 之间`, 422)
  }
}

function mapSettings(row: Record<string, unknown>): WorldAmbientLifeSettings {
  return {
    worldId: stringColumn(row, 'world_id'),
    enabled: numberColumn(row, 'enabled') === 1,
    minimumIdleMs: numberColumn(row, 'minimum_idle_ms'),
    minimumAmbientIntervalMs: numberColumn(row, 'minimum_ambient_interval_ms'),
    socialCooldownMs: numberColumn(row, 'social_cooldown_ms'),
    breakAfterMs: numberColumn(row, 'break_after_ms'),
    timeBucketMs: numberColumn(row, 'time_bucket_ms'),
    maximumPlansPerTick: numberColumn(row, 'maximum_plans_per_tick'),
    updatedAt: stringColumn(row, 'updated_at'),
  }
}

function stringColumn(row: Record<string, unknown>, key: string): string {
  const value = row[key]
  if (typeof value !== 'string') throw new Error(`Invalid ambient setting column: ${key}`)
  return value
}

function numberColumn(row: Record<string, unknown>, key: string): number {
  const value = row[key]
  if (typeof value !== 'number') throw new Error(`Invalid ambient setting column: ${key}`)
  return value
}

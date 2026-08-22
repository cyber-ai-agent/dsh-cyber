import type { Router } from '../http/router.js'
import { HttpError } from '../http/errors.js'
import { readJson } from '../http/request.js'
import { writeJson } from '../http/response.js'
import type {
  AmbientLifeSettingsService,
  UpdateWorldAmbientLifeSettings,
} from '../services/ambient-life-settings-service.js'
import type { WorldAccessService } from '../services/world-access-service.js'
import type { SqliteStore } from '@dsh-cyber/persistence'

export interface AmbientLifeRoutesDependencies {
  store: SqliteStore
  settings: AmbientLifeSettingsService
  access: WorldAccessService
}

export function registerAmbientLifeRoutes(
  router: Router,
  dependencies: AmbientLifeRoutesDependencies,
): void {
  const { store, settings, access } = dependencies

  router.get(/^\/api\/worlds\/([^/]+)\/ambient-life$/, async ({ request, response, params }) => {
    const worldId = params[0]!
    if (store.getWorld(worldId) === undefined) {
      throw new HttpError(404, 'world_not_found', 'World not found')
    }
    await access.assertUnlocked(worldId, request)
    writeJson(response, 200, { settings: settings.get(worldId) })
  })

  router.put(/^\/api\/worlds\/([^/]+)\/ambient-life$/, async ({ request, response, params }) => {
    const worldId = params[0]!
    if (store.getWorld(worldId) === undefined) {
      throw new HttpError(404, 'world_not_found', 'World not found')
    }
    await access.assertUnlocked(worldId, request)
    const body = await readJson(request)
    assertOnlyKeys(body, [
      'enabled',
      'minimumIdleMs',
      'minimumAmbientIntervalMs',
      'socialCooldownMs',
      'breakAfterMs',
      'timeBucketMs',
      'maximumPlansPerTick',
    ])
    const input: UpdateWorldAmbientLifeSettings = {}
    if (body.enabled !== undefined) input.enabled = booleanValue(body.enabled, 'enabled')
    copyInteger(body, input, 'minimumIdleMs')
    copyInteger(body, input, 'minimumAmbientIntervalMs')
    copyInteger(body, input, 'socialCooldownMs')
    copyInteger(body, input, 'breakAfterMs')
    copyInteger(body, input, 'timeBucketMs')
    copyInteger(body, input, 'maximumPlansPerTick')
    writeJson(response, 200, { settings: settings.update(worldId, input) })
  })
}

function copyInteger(
  source: Record<string, unknown>,
  target: UpdateWorldAmbientLifeSettings,
  key: Exclude<keyof UpdateWorldAmbientLifeSettings, 'enabled'>,
): void {
  const value = source[key]
  if (value === undefined) return
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new HttpError(422, 'invalid_ambient_setting', `${key} must be an integer`)
  }
  target[key] = value
}

function booleanValue(value: unknown, key: string): boolean {
  if (typeof value !== 'boolean') {
    throw new HttpError(422, 'invalid_ambient_setting', `${key} must be a boolean`)
  }
  return value
}

function assertOnlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): void {
  const allowed = new Set(allowedKeys)
  const unknown = Object.keys(value).find((key) => !allowed.has(key))
  if (unknown !== undefined) {
    throw new HttpError(422, 'invalid_ambient_setting', `Unknown ambient setting: ${unknown}`)
  }
}

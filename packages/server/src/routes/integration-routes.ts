import type { IntegrationConnection, JsonObject } from '@dsh-cyber/contracts'
import type { SqliteStore } from '@dsh-cyber/persistence'

import { HttpError } from '../http/errors.js'
import { optionalString, readJson, record, requiredString } from '../http/request.js'
import { writeJson } from '../http/response.js'
import type { Router } from '../http/router.js'
import type { IntegrationService } from '../integrations/integration-service.js'
import { FIRECRAWL_INTEGRATION_ID } from '../integrations/firecrawl-provider.js'
import { WEB_SEARCH_DEFAULT_MARKER, WEB_SEARCH_INTEGRATION_ID } from '../integrations/web-search-provider.js'
import { sshEnvironmentDeviceTarget } from '../composition/compose-environment.js'
import type { EnvironmentService } from '../environments/environment-service.js'
import type { EnvironmentProbeTier } from '../environments/environment-probe.js'

function parseSecretWrites(body: Record<string, unknown>): { secrets?: Record<string, string>; clearSecretFields?: string[] } {
  const rawSecrets = record(body.secrets)
  if (rawSecrets !== undefined) {
    for (const [field, value] of Object.entries(rawSecrets)) {
      if (field.trim() === '' || typeof value !== 'string') throw new HttpError(422, 'integration_secret_invalid', 'secrets must map field ids to strings')
    }
    const secrets = Object.fromEntries(Object.entries(rawSecrets).map(([field, value]) => [field, String(value)]))
    return { secrets, ...parseClearSecretFields(body) }
  }
  return parseClearSecretFields(body)
}

function parseClearSecretFields(body: Record<string, unknown>): { clearSecretFields?: string[] } {
  const clear = body.clearSecretFields
  if (clear === undefined) return {}
  if (!Array.isArray(clear) || clear.some((field) => typeof field !== 'string' || field.trim() === '')) {
    throw new HttpError(422, 'integration_clear_secret_invalid', 'clearSecretFields must be an array of non-empty strings')
  }
  return { clearSecretFields: clear as string[] }
}

export function registerIntegrationRoutes(router: Router, dependencies: { store: SqliteStore; integrations: IntegrationService; environments?: EnvironmentService; onChanged?: (integrationId: string) => Promise<void> }): void {
  const { store, integrations, environments, onChanged } = dependencies

  router.get(/^\/api\/workspaces\/([^/]+)\/integrations$/, ({ response, params }) => {
    const workspaceId = requireWorkspace(store, params[0]!)
    const descriptors = visibleDescriptors(store, integrations, workspaceId)
    // The 联网搜索 cards take over the legacy Firecrawl item: its descriptor is
    // no longer a rail entry, but its connections must still flow to the panel.
    const allowed = new Set([...descriptors.map((descriptor) => descriptor.id), FIRECRAWL_INTEGRATION_ID])
    writeJson(response, 200, { descriptors, items: integrations.list(workspaceId).filter((item) => allowed.has(item.integrationId)) })
  })

  // Device machine profile. Reading is free; probing costs a real SSH round
  // trip, so it only happens on the owner's explicit refresh.
  router.get(/^\/api\/workspaces\/([^/]+)\/integrations\/([^/]+)\/connections\/([^/]+)\/environment$/, ({ response, params }) => {
    const workspaceId = requireWorkspace(store, params[0]!); const integrationId = params[1]!; const connectionId = params[2]!
    assertConnection(store, integrations, workspaceId, integrationId, connectionId)
    writeJson(response, 200, { profile: environments?.profile(`ssh:${connectionId}`) ?? null })
  })

  router.post(/^\/api\/workspaces\/([^/]+)\/integrations\/([^/]+)\/connections\/([^/]+)\/environment\/refresh$/, async ({ request, response, params }) => {
    const workspaceId = requireWorkspace(store, params[0]!); const integrationId = params[1]!; const connectionId = params[2]!
    assertConnection(store, integrations, workspaceId, integrationId, connectionId)
    if (environments === undefined) throw new HttpError(503, 'environment_unavailable', '本机环境档案服务未启用')
    const target = sshEnvironmentDeviceTarget({ integrations, workspaceId, connectionId })
    if (target === undefined) throw new HttpError(422, 'environment_device_unavailable', '设备未启用或缺少私钥/密码凭据')
    const body = record(await readJson(request)) ?? {}
    const tier = body.tier === undefined ? 'full' : body.tier === 'fast' || body.tier === 'full' ? body.tier : undefined
    if (tier === undefined) throw new HttpError(422, 'environment_tier_invalid', '刷新层级无效')
    const profile = await environments.refreshDevice(target, tier as EnvironmentProbeTier)
    if (profile === undefined) throw new HttpError(502, 'environment_device_unprobeable', '该设备没有返回可识别的系统信息')
    writeJson(response, 200, { profile })
  })

  router.put(/^\/api\/workspaces\/([^/]+)\/integrations\/([^/]+)\/connections\/([^/]+)$/, async ({ request, response, params }) => {
    // Connection-scoped write: edits one exact device/endpoint connection.
    const workspaceId = requireWorkspace(store, params[0]!); const integrationId = params[1]!; const connectionId = params[2]!
    assertIntegrationAvailable(store, workspaceId, integrationId)
    const body = await readJson(request); const config = record(body.config) ?? {}
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw new HttpError(422, 'integration_enabled_invalid', 'enabled must be boolean')
    if (body.clearCredential !== undefined && typeof body.clearCredential !== 'boolean') throw new HttpError(422, 'integration_clear_credential_invalid', 'clearCredential must be boolean')
    const existing = integrations.getById(workspaceId, connectionId)
    if (existing === undefined || existing.integrationId !== integrationId) throw new HttpError(404, 'integration_connection_not_found', '外部连接不存在')
    let connection
    try {
      connection = await integrations.save({
        workspaceId, integrationId, connectionId, config: config as JsonObject, enabled: body.enabled !== false,
        ...(body.displayName === undefined ? {} : { displayName: requiredString(body, 'displayName') }),
        ...(body.credential === undefined ? {} : { credential: requiredString(body, 'credential') }),
        ...parseSecretWrites(body),
        ...(body.clearCredential === true ? { clearCredential: true } : {}),
      })
    } catch (error) {
      throw new HttpError(422, 'integration_config_invalid', error instanceof Error ? error.message : 'Integration configuration is invalid')
    }
    await normalizeWebSearchDefault(integrations, workspaceId, connection)
    await onChanged?.(integrationId)
    writeJson(response, 200, { connection })
  })

  router.put(/^\/api\/workspaces\/([^/]+)\/integrations\/([^/]+)$/, async ({ request, response, params }) => {
    const workspaceId = requireWorkspace(store, params[0]!); const integrationId = params[1]!
    assertIntegrationAvailable(store, workspaceId, integrationId)
    const body = await readJson(request); const config = record(body.config) ?? {}
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw new HttpError(422, 'integration_enabled_invalid', 'enabled must be boolean')
    if (body.clearCredential !== undefined && typeof body.clearCredential !== 'boolean') throw new HttpError(422, 'integration_clear_credential_invalid', 'clearCredential must be boolean')
    let connection
    try {
      connection = await integrations.save({
        workspaceId, integrationId, config: config as JsonObject, enabled: body.enabled !== false,
        ...(body.displayName === undefined ? {} : { displayName: requiredString(body, 'displayName') }),
        ...(body.credential === undefined ? {} : { credential: requiredString(body, 'credential') }),
        ...parseSecretWrites(body),
        ...(body.clearCredential === true ? { clearCredential: true } : {}),
      })
    } catch (error) {
      throw new HttpError(422, 'integration_config_invalid', error instanceof Error ? error.message : 'Integration configuration is invalid')
    }
    await normalizeWebSearchDefault(integrations, workspaceId, connection)
    await onChanged?.(integrationId)
    writeJson(response, 200, { connection })
  })

  router.post(/^\/api\/workspaces\/([^/]+)\/integrations\/([^/]+)\/test$/, async ({ request, response, params, url }) => {
    const workspaceId = requireWorkspace(store, params[0]!)
    const integrationId = params[1]!
    assertIntegrationAvailable(store, workspaceId, integrationId)
    const connectionId = optionalString(url.searchParams.get('connectionId'))
    // Test with the form's current values (the user may edit host/port and
    // click 测试连接 before saving). Without a body the stored connection is
    // tested, preserving the legacy single-request behaviour.
    const body = await readJson(request)
    const config = record(body.config)
    const draftSecrets = record(body.secrets)
    let health
    try {
      health = config === undefined && draftSecrets === undefined
        ? await integrations.test(workspaceId, integrationId, connectionId)
        : await integrations.testDraft(workspaceId, integrationId, {
            ...(connectionId === undefined ? {} : { connectionId }),
            ...(config === undefined ? {} : { config: config as JsonObject }),
            ...(draftSecrets === undefined ? {} : { secrets: Object.fromEntries(Object.entries(draftSecrets).map(([field, value]) => [field, String(value)])) }),
          })
    } catch (error) {
      throw new HttpError(422, 'integration_config_invalid', error instanceof Error ? error.message : 'Integration configuration is invalid')
    }
    if (health.status === 'ready') await onChanged?.(integrationId)
    writeJson(response, 200, { health })
  })

  router.delete(/^\/api\/workspaces\/([^/]+)\/integrations\/([^/]+)\/connections\/([^/]+)$/, async ({ response, params }) => {
    const workspaceId = requireWorkspace(store, params[0]!); const integrationId = params[1]!; const connectionId = params[2]!
    assertIntegrationAvailable(store, workspaceId, integrationId)
    const removed = await integrations.delete(workspaceId, integrationId, connectionId)
    if (removed) await onChanged?.(integrationId)
    writeJson(response, 200, { removed })
  })

  router.delete(/^\/api\/workspaces\/([^/]+)\/integrations\/([^/]+)$/, async ({ response, params }) => {
    const workspaceId = requireWorkspace(store, params[0]!)
    const integrationId = params[1]!
    assertIntegrationAvailable(store, workspaceId, integrationId)
    const removed = await integrations.delete(workspaceId, integrationId)
    if (removed) await onChanged?.(integrationId)
    writeJson(response, 200, { removed })
  })
}

function requireWorkspace(store: SqliteStore, workspaceId: string): string {
  if (store.getWorkspace(workspaceId) === undefined) throw new HttpError(404, 'workspace_not_found', 'Workspace not found')
  return workspaceId
}

// The 联网搜索 main item took over the Firecrawl settings: the legacy
// `builtin.firecrawl` type is no longer a rail item of its own. Its skill
// (web.search.firecrawl) stays package-gated upstream; the credential home is
// freely editable through the 联网搜索 card, with or without the recipe.
function visibleDescriptors(store: SqliteStore, integrations: IntegrationService, workspaceId: string) {
  return integrations.descriptors().filter((descriptor) => descriptor.id !== FIRECRAWL_INTEGRATION_ID)
}

function assertIntegrationAvailable(_store: SqliteStore, _workspaceId: string, _integrationId: string): void {
  // No package gate on connection CRUD anymore (see visibleDescriptors).
}

/** The connection must exist and belong to the integration the path names. */
function assertConnection(store: SqliteStore, integrations: IntegrationService, workspaceId: string, integrationId: string, connectionId: string): void {
  assertIntegrationAvailable(store, workspaceId, integrationId)
  const connection = integrations.getById(workspaceId, connectionId)
  if (connection === undefined || connection.integrationId !== integrationId) {
    throw new HttpError(404, 'integration_connection_not_found', '外部连接不存在')
  }
}

/**
 * 联网搜索 cards (one per catalog provider, plus the legacy Firecrawl
 * connection they took over) share a single default marker. Marking one card
 * default clears the marker on every sibling card so the built-in `web_search`
 * selection stays unambiguous.
 */
async function normalizeWebSearchDefault(integrations: IntegrationService, workspaceId: string, saved: IntegrationConnection): Promise<void> {
  if (saved.integrationId !== WEB_SEARCH_INTEGRATION_ID && saved.integrationId !== FIRECRAWL_INTEGRATION_ID) return
  if (saved.config[WEB_SEARCH_DEFAULT_MARKER] !== true) return
  for (const sibling of integrations.listByType(workspaceId, WEB_SEARCH_INTEGRATION_ID)) {
    if (sibling.id === saved.id || sibling.config[WEB_SEARCH_DEFAULT_MARKER] !== true) continue
    await integrations.save({
      workspaceId,
      integrationId: WEB_SEARCH_INTEGRATION_ID,
      connectionId: sibling.id,
      displayName: sibling.displayName,
      config: { ...sibling.config, [WEB_SEARCH_DEFAULT_MARKER]: false },
      enabled: sibling.enabled,
    })
  }
  if (saved.integrationId === WEB_SEARCH_INTEGRATION_ID) {
    const legacy = integrations.get(workspaceId, FIRECRAWL_INTEGRATION_ID)
    if (legacy !== undefined && legacy.config[WEB_SEARCH_DEFAULT_MARKER] === true) {
      await integrations.save({
        workspaceId,
        integrationId: FIRECRAWL_INTEGRATION_ID,
        connectionId: legacy.id,
        displayName: legacy.displayName,
        config: { ...legacy.config, [WEB_SEARCH_DEFAULT_MARKER]: false },
        enabled: legacy.enabled,
      })
    }
  }
}

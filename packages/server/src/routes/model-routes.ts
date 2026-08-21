import { randomUUID } from 'node:crypto'

import type { JsonObject } from '@dsh-cyber/contracts'
import type { SqliteStore } from '@dsh-cyber/persistence'

import type { Router } from '../http/router.js'
import { HttpError } from '../http/errors.js'
import {
  nullableString,
  readJson,
  record,
  requiredEnum,
  requiredString,
} from '../http/request.js'
import { writeJson } from '../http/response.js'
import {
  isManagedModelCredentialName,
  type ModelCredentialService,
} from '../services/model-credential-service.js'
import type { ModelCatalogService } from '../services/model-catalog-service.js'
import type { ModelInteractionService } from '../services/model-interaction-service.js'
import { ServiceError } from '../services/service-error.js'

export interface ModelRoutesDependencies {
  store: SqliteStore
  credentials: ModelCredentialService
  modelCatalog: ModelCatalogService
  interactions: ModelInteractionService
}

export function registerModelRoutes(router: Router, dependencies: ModelRoutesDependencies): void {
  const { store, credentials, modelCatalog, interactions } = dependencies

  router.get(/^\/api\/workspaces\/([^/]+)\/model-profiles$/, ({ response, params }) => {
    const workspaceId = params[0]!
    writeJson(response, 200, {
      items: store.listModelProfiles(workspaceId).map((profile) => ({
        ...profile,
        credentialConfigured: isManagedModelCredentialName(profile.credentialEnvName)
          ? credentials.has(profile.id)
          : profile.credentialEnvName === undefined
          ? profile.providerKind === 'openai-compatible-local'
          : Boolean(process.env[profile.credentialEnvName]),
      })),
      assignments: store.listModelAssignments(workspaceId),
    })
  })

  router.post(/^\/api\/workspaces\/([^/]+)\/model-profiles$/, async ({ request, response, params }) => {
    const body = await readJson(request)
    const profileId = body.id === undefined ? randomUUID() : requiredString(body, 'id')
    const existing = store.getModelProfile(profileId)
    const apiKey = body.apiKey === undefined ? undefined : requiredString(body, 'apiKey')
    const clearCredential = body.clearCredential === true
    if (existing !== undefined && existing.workspaceId !== params[0]) {
      throw new HttpError(409, 'model_profile_workspace_mismatch', 'Model profile cannot move between workspaces')
    }
    if (apiKey !== undefined && body.credentialEnvName !== undefined) {
      throw new HttpError(422, 'credential_source_conflict', 'Choose either an API key or an environment variable')
    }
    const displayName = requiredString(body, 'displayName')
    const providerKind = requiredEnum(body, 'providerKind', [
      'deepseek',
      'openai-compatible-local',
      'openai-compatible-remote',
    ])
    const baseUrl = requiredString(body, 'baseUrl')
    validateModelBaseUrl(baseUrl, providerKind)
    const modelId = requiredString(body, 'modelId')
    const api = requiredEnum(body, 'api', [
      'openai-completions',
      'openai-responses',
      'anthropic-messages',
    ])
    const settings = record(body.settings)
    const previousManagedSecret = isManagedModelCredentialName(existing?.credentialEnvName)
      ? credentials.resolve(profileId)
      : undefined
    let credentialEnvName = existing?.credentialEnvName
    if (apiKey !== undefined) {
      credentialEnvName = await credentials.set(profileId, apiKey)
    } else if (body.credentialEnvName !== undefined) {
      credentialEnvName = nullableString(body.credentialEnvName) ?? undefined
    } else if (clearCredential) {
      credentialEnvName = undefined
    }
    let profile
    try {
      profile = store.saveModelProfile({
        id: profileId,
        workspaceId: params[0]!,
        displayName,
        providerKind,
        baseUrl,
        modelId,
        api,
        ...(credentialEnvName === undefined ? {} : { credentialEnvName }),
        ...(typeof body.isDefault === 'boolean' ? { isDefault: body.isDefault } : {}),
        ...(settings === undefined ? {} : { settings: settings as JsonObject }),
      })
    } catch (error) {
      if (apiKey !== undefined) {
        if (previousManagedSecret === undefined) await credentials.delete(profileId)
        else await credentials.set(profileId, previousManagedSecret)
      }
      throw error
    }
    if (apiKey === undefined && (body.credentialEnvName !== undefined || clearCredential)) {
      await credentials.delete(profileId)
    }
    writeJson(response, 201, { profile })
  })

  router.post(/^\/api\/workspaces\/([^/]+)\/model-profiles\/discover$/, async ({ request, response, params }) => {
    const body = await readJson(request)
    const profileId = body.profileId === undefined ? undefined : requiredString(body, 'profileId')
    const profile = profileId === undefined ? undefined : store.getModelProfile(profileId)
    if (profile !== undefined && profile.workspaceId !== params[0]) {
      throw new HttpError(404, 'model_profile_not_found', 'Model profile not found')
    }
    const apiKey = body.apiKey === undefined ? undefined : requiredString(body, 'apiKey')
    const credentialEnvName = profile?.credentialEnvName
      ?? (body.credentialEnvName === undefined ? undefined : requiredString(body, 'credentialEnvName'))
    if (credentialEnvName !== undefined
      && !isManagedModelCredentialName(credentialEnvName)
      && !/^[A-Z_][A-Z0-9_]*_API_KEY$/.test(credentialEnvName)) {
      throw new HttpError(422, 'credential_env_name_invalid', 'Credential environment variable must end with _API_KEY')
    }
    const workspaceId = params[0]!
    const startedAt = Date.now()
    const modelId = profile?.modelId ?? '-'
    const provider = profile?.displayName ?? requiredString(body, 'baseUrl')
    let items
    try {
      items = await modelCatalog.discover({
        baseUrl: requiredString(body, 'baseUrl'),
        api: requiredEnum(body, 'api', [
          'openai-completions',
          'openai-responses',
          'anthropic-messages',
        ]),
        ...(profileId === undefined ? {} : { profileId }),
        ...(apiKey === undefined ? {} : { apiKey }),
        ...(credentialEnvName === undefined ? {} : { credentialEnvName }),
      })
      interactions.recordDiscovery({
        workspaceId,
        modelId,
        provider,
        status: 'success',
        httpStatus: 200,
        durationMs: Date.now() - startedAt,
      })
    } catch (error) {
      const httpStatus = serviceErrorHttpStatus(error)
      interactions.recordDiscovery({
        workspaceId,
        modelId,
        provider,
        status: 'failed',
        errorCode: error instanceof ServiceError ? error.code : 'model_catalog_failed',
        errorMessage: error instanceof Error ? error.message : '模型列表获取失败',
        ...(httpStatus === undefined ? {} : { httpStatus }),
        durationMs: Date.now() - startedAt,
      })
      throw error
    }
    writeJson(response, 200, { items })
  })

  router.delete(/^\/api\/workspaces\/([^/]+)\/model-profiles\/([^/]+)$/, async ({ response, params }) => {
    const workspaceId = params[0]!
    const profile = store.getModelProfile(params[1]!)
    if (profile?.workspaceId === workspaceId) await credentials.delete(profile.id)
    const removed = store.deleteModelProfile(workspaceId, params[1]!)
    writeJson(response, 200, {
      removed,
      items: store.listModelProfiles(workspaceId),
      assignments: store.listModelAssignments(workspaceId),
    })
  })

  const assignmentPattern = /^\/api\/workspaces\/([^/]+)\/model-assignments\/(workspace|world|employee)\/([^/]+)$/
  router.put(assignmentPattern, async ({ request, response, params }) => {
    const body = await readJson(request)
    const assignment = store.saveModelAssignment({
      workspaceId: params[0]!,
      scope: params[1] as 'workspace' | 'world' | 'employee',
      scopeId: params[2]!,
      modelProfileId: requiredString(body, 'modelProfileId'),
    })
    writeJson(response, 200, { assignment })
  })

  router.delete(assignmentPattern, ({ response, params }) => {
    const removed = store.clearModelAssignment(
      params[0]!,
      params[1] as 'workspace' | 'world' | 'employee',
      params[2]!,
    )
    writeJson(response, 200, { removed })
  })
}

function validateModelBaseUrl(
  value: string,
  providerKind: 'deepseek' | 'openai-compatible-local' | 'openai-compatible-remote',
): void {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new HttpError(422, 'model_base_url_invalid', '模型接口地址格式不正确。')
  }
  if (providerKind === 'openai-compatible-local') {
    if (!['http:', 'https:'].includes(url.protocol) || !isPrivateModelHostname(url.hostname)) {
      throw new HttpError(422, 'model_base_url_invalid', '本机或局域网模型必须使用回环地址或私有网络 HTTP(S) 地址。')
    }
    return
  }
  if (url.protocol !== 'https:') {
    throw new HttpError(422, 'model_base_url_insecure', '公网模型服务必须使用 HTTPS 地址。')
  }
}

function isPrivateModelHostname(value: string): boolean {
  const hostname = value.toLowerCase().replace(/^\[|\]$/g, '')
  if (hostname === 'localhost' || hostname === '::1' || hostname === 'host.docker.internal'
    || hostname === 'host.containers.internal' || hostname.endsWith('.local')) return true
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname)
  if (ipv4 !== null) {
    const octets = ipv4.slice(1).map(Number)
    if (octets.some((octet) => octet > 255)) return false
    const [first, second] = octets
    return first === 10 || first === 127
      || (first === 172 && second !== undefined && second >= 16 && second <= 31)
      || (first === 192 && second === 168)
      || (first === 169 && second === 254)
      || (first === 100 && second !== undefined && second >= 64 && second <= 127)
  }
  return hostname.includes(':') && (hostname.startsWith('fc') || hostname.startsWith('fd') || hostname.startsWith('fe80:'))
}

const SERVICE_ERROR_HTTP_STATUS: Record<ServiceError['kind'], number> = {
  conflict: 409,
  forbidden: 403,
  invalid: 422,
  'not-found': 404,
  'rate-limited': 429,
  'too-large': 413,
  unavailable: 502,
  unsupported: 415,
}

function serviceErrorHttpStatus(error: unknown): number | undefined {
  if (!(error instanceof ServiceError)) return undefined
  return error.httpStatus ?? SERVICE_ERROR_HTTP_STATUS[error.kind]
}

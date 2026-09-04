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
import {
  assertModelBaseUrl,
  inferModelProviderKind,
  modelBaseUrlIdentity,
  ModelUrlPolicyError,
} from '../services/model-url-policy.js'
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
    // Attach the connection's name so the composer's model picker can group by
    // the providers the owner actually added, instead of a generic local/remote
    // kind. Display-only: never stored on the profile row.
    const providerNames = new Map(store.listModelProviders(workspaceId).map((provider) => [provider.id, provider.name]))
    writeJson(response, 200, {
      items: store.listModelProfiles(workspaceId).map((profile) => ({
        ...profile,
        ...(profile.providerId === undefined ? {} : { providerName: providerNames.get(profile.providerId) ?? profile.providerName }),
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
    validateSavedModelBaseUrl(baseUrl, providerKind)
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
    } else if (credentialEnvName === undefined) {
      const sameUrlProfile = store.listModelProfiles(params[0]!).find(
        (p) => p.id !== profileId && p.baseUrl === baseUrl && p.credentialEnvName !== undefined
      )
      if (sameUrlProfile && sameUrlProfile.credentialEnvName) {
        if (isManagedModelCredentialName(sameUrlProfile.credentialEnvName)) {
          const secret = credentials.resolve(sameUrlProfile.id)
          if (secret) {
            credentialEnvName = await credentials.set(profileId, secret)
          }
        } else {
          credentialEnvName = sameUrlProfile.credentialEnvName
        }
      }
    }
    let profile
    try {
      validateWebSearchSettings(settings, credentialEnvName)
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
    if (profileId !== undefined && profile === undefined) {
      throw new HttpError(404, 'model_profile_not_found', 'Model profile not found')
    }
    if (profile !== undefined && profile.workspaceId !== params[0]) {
      throw new HttpError(404, 'model_profile_not_found', 'Model profile not found')
    }
    const baseUrl = requiredString(body, 'baseUrl')
    if (profile !== undefined) {
      const submittedIdentity = modelBaseUrlIdentity(baseUrl)
      const profileIdentity = modelBaseUrlIdentity(profile.baseUrl)
      if (submittedIdentity === undefined || profileIdentity === undefined || submittedIdentity !== profileIdentity) {
        throw new HttpError(409, 'model_profile_url_mismatch', '模型发现地址必须与已选模型配置一致。')
      }
    }
    const providerKind = profile?.providerKind ?? inferModelProviderKind(baseUrl)
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
    const provider = profile?.displayName ?? baseUrl
    let items
    try {
      items = await modelCatalog.discover({
        baseUrl,
        providerKind,
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

function validateWebSearchSettings(
  settings: Record<string, unknown> | undefined,
  credentialEnvName: string | undefined,
): void {
  if (settings?.webSearchEnabled !== true) return
  if (credentialEnvName === undefined) {
    throw new HttpError(422, 'web_search_credential_missing', '启用联网搜索前，请先配置 API 密钥或凭据环境变量。')
  }
  const value = settings.webSearchBaseUrl
  if (typeof value !== 'string' || !value.trim()) {
    throw new HttpError(422, 'web_search_base_url_missing', '启用联网搜索后，需要填写搜索服务地址。')
  }
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new HttpError(422, 'web_search_base_url_invalid', '联网搜索服务地址格式不正确。')
  }
  if (url.protocol !== 'https:') {
    throw new HttpError(422, 'web_search_base_url_insecure', '联网搜索服务必须使用 HTTPS 地址。')
  }
}

function validateSavedModelBaseUrl(
  value: string,
  providerKind: 'deepseek' | 'openai-compatible-local' | 'openai-compatible-remote',
): void {
  try {
    assertModelBaseUrl(value, providerKind)
  } catch (error) {
    if (error instanceof ModelUrlPolicyError) {
      throw new HttpError(422, error.code, error.message)
    }
    throw error
  }
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

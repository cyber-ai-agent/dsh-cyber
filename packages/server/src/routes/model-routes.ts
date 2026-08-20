import type { JsonObject } from '@dsh-cyber/contracts'
import type { SqliteStore } from '@dsh-cyber/persistence'

import type { Router } from '../http/router.js'
import {
  nullableString,
  readJson,
  record,
  requiredEnum,
  requiredString,
} from '../http/request.js'
import { writeJson } from '../http/response.js'

export interface ModelRoutesDependencies {
  store: SqliteStore
}

export function registerModelRoutes(router: Router, dependencies: ModelRoutesDependencies): void {
  const { store } = dependencies

  router.get(/^\/api\/workspaces\/([^/]+)\/model-profiles$/, ({ response, params }) => {
    const workspaceId = params[0]!
    writeJson(response, 200, {
      items: store.listModelProfiles(workspaceId).map((profile) => ({
        ...profile,
        credentialConfigured: profile.credentialEnvName === undefined
          ? profile.providerKind === 'openai-compatible-local'
          : Boolean(process.env[profile.credentialEnvName]),
      })),
      assignments: store.listModelAssignments(workspaceId),
    })
  })

  router.post(/^\/api\/workspaces\/([^/]+)\/model-profiles$/, async ({ request, response, params }) => {
    const body = await readJson(request)
    const profile = store.saveModelProfile({
      ...(body.id === undefined ? {} : { id: requiredString(body, 'id') }),
      workspaceId: params[0]!,
      displayName: requiredString(body, 'displayName'),
      providerKind: requiredEnum(body, 'providerKind', [
        'deepseek',
        'openai-compatible-local',
        'openai-compatible-remote',
      ]),
      baseUrl: requiredString(body, 'baseUrl'),
      modelId: requiredString(body, 'modelId'),
      api: requiredEnum(body, 'api', [
        'openai-completions',
        'openai-responses',
        'anthropic-messages',
      ]),
      ...(body.credentialEnvName === undefined
        ? {}
        : { credentialEnvName: nullableString(body.credentialEnvName) }),
      ...(typeof body.isDefault === 'boolean' ? { isDefault: body.isDefault } : {}),
      ...(record(body.settings) === undefined ? {} : { settings: record(body.settings) as JsonObject }),
    })
    writeJson(response, 201, { profile })
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

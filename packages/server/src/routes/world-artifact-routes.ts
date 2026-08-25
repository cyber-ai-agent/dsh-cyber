import type { WorldArtifactFilter, WorldArtifactKind, WorldArtifactStatus } from '@dsh-cyber/contracts'
import type { SqliteStore } from '@dsh-cyber/persistence'

import { HttpError } from '../http/errors.js'
import type { Router } from '../http/router.js'
import { optionalString, readJson, record, requiredString } from '../http/request.js'
import { writeArtifactPreview, writeJson } from '../http/response.js'
import type { WorldAccessService } from '../services/world-access-service.js'
import type {
  PublishImportedArtifactInput,
  PublishWorkspaceArtifactInput,
  WorldArtifactService,
} from '../services/world-artifact-service.js'
import type { WorldCharacterAuthorityService } from '../services/world-character-authority-service.js'

const ARTIFACT_KINDS: readonly WorldArtifactKind[] = ['image', 'html', 'markdown', 'document', 'code', 'data', 'archive', 'project', 'other']
const ARTIFACT_STATUSES: readonly WorldArtifactStatus[] = ['active', 'archived', 'missing']

export interface WorldArtifactRoutesDependencies {
  store: SqliteStore
  artifacts: WorldArtifactService
  access: WorldAccessService
  authority: WorldCharacterAuthorityService
}

export function registerWorldArtifactRoutes(router: Router, dependencies: WorldArtifactRoutesDependencies): void {
  const { store, artifacts, access, authority } = dependencies

  router.get(/^\/api\/worlds\/([^/]+)\/artifacts$/, async ({ request, response, params, url }) => {
    const worldId = params[0]!
    assertWorld(store, worldId)
    await access.assertUnlocked(worldId, request)
    writeJson(response, 200, { artifacts: artifacts.list(worldId, listFilter(url)) })
  })

  router.get(/^\/api\/worlds\/([^/]+)\/artifacts\/([^/]+)$/, async ({ request, response, params }) => {
    const worldId = params[0]!
    assertWorld(store, worldId)
    await access.assertUnlocked(worldId, request)
    writeJson(response, 200, artifacts.get(worldId, params[1]!))
  })

  router.post(/^\/api\/worlds\/([^/]+)\/artifacts\/publish$/, async ({ request, response, params }) => {
    const worldId = params[0]!
    assertWorld(store, worldId)
    await access.assertUnlocked(worldId, request)
    const body = await readJson(request)
    const input = workspaceInput(body, worldId)
    const publication = await artifacts.publishFromWorkspace(input)
    writeJson(response, publication.created ? 201 : 200, { ...publication, publication })
  })

  router.post(/^\/api\/worlds\/([^/]+)\/artifacts\/import$/, async ({ request, response, params }) => {
    const worldId = params[0]!
    assertWorld(store, worldId)
    await access.assertUnlocked(worldId, request)
    const body = await readJson(request)
    const input = importedInput(body, worldId)
    const publication = await artifacts.publishImportedFile(input)
    writeJson(response, publication.created ? 201 : 200, { ...publication, publication })
  })

  router.patch(/^\/api\/worlds\/([^/]+)\/artifacts\/([^/]+)$/, async ({ request, response, params }) => {
    const worldId = params[0]!
    assertWorld(store, worldId)
    await access.assertUnlocked(worldId, request)
    const body = await readJson(request)
    assertManage(authority, worldId, optionalString(body.actorEmployeeId))
    const title = requiredString(body, 'title')
    const description = body.description === null ? undefined : optionalString(body.description)
    writeJson(response, 200, { artifact: artifacts.rename(worldId, params[1]!, title, description) })
  })

  router.post(/^\/api\/worlds\/([^/]+)\/artifacts\/([^/]+)\/archive$/, async ({ request, response, params }) => {
    const worldId = params[0]!
    assertWorld(store, worldId)
    await access.assertUnlocked(worldId, request)
    const body = await readJson(request)
    assertManage(authority, worldId, optionalString(body.actorEmployeeId))
    writeJson(response, 200, { artifact: artifacts.archive(worldId, params[1]!) })
  })

  router.post(/^\/api\/worlds\/([^/]+)\/artifacts\/([^/]+)\/restore$/, async ({ request, response, params }) => {
    const worldId = params[0]!
    assertWorld(store, worldId)
    await access.assertUnlocked(worldId, request)
    const body = await readJson(request)
    assertManage(authority, worldId, optionalString(body.actorEmployeeId))
    writeJson(response, 200, { artifact: artifacts.restore(worldId, params[1]!) })
  })

  router.delete(/^\/api\/worlds\/([^/]+)\/artifacts\/([^/]+)$/, async ({ request, response, params }) => {
    const worldId = params[0]!
    assertWorld(store, worldId)
    await access.assertUnlocked(worldId, request)
    await artifacts.remove(worldId, params[1]!)
    writeJson(response, 200, { removed: true })
  })

  router.get(/^\/api\/worlds\/([^/]+)\/artifacts\/([^/]+)\/preview(?:\/([^/]+))?$/, async ({ request, response, params, url }) => {
    const worldId = params[0]!
    assertWorld(store, worldId)
    await access.assertUnlocked(worldId, request)
    const pathVersion = params[2] === undefined ? undefined : parseVersion(params[2]!)
    const queryVersion = url.searchParams.get('version')
    const version = pathVersion ?? (queryVersion === null ? undefined : parseVersion(queryVersion))
    const selectedPath = optionalString(url.searchParams.get('path')) ?? optionalString(url.searchParams.get('entryPath'))
    const preview = await artifacts.preview(worldId, params[1]!, version, selectedPath)
    writeArtifactPreview(response, preview.body, preview.contentType, preview.isHtml)
  })
}

function listFilter(url: URL): WorldArtifactFilter {
  const query = optionalString(url.searchParams.get('search'))
  const kind = optionalEnum(url.searchParams.get('kind'), ARTIFACT_KINDS, 'invalid_artifact_kind')
  const status = optionalEnum(url.searchParams.get('status'), ARTIFACT_STATUSES, 'invalid_artifact_status')
  const createdByKind = optionalEnum(url.searchParams.get('createdByKind'), ['owner', 'employee'] as const, 'invalid_artifact_creator')
  const createdById = optionalString(url.searchParams.get('createdById'))
  const employeeId = optionalString(url.searchParams.get('employeeId'))
  const page = parseOptionalPositive(url.searchParams.get('page'), 'invalid_artifact_page')
  const pageSize = parseOptionalPositive(url.searchParams.get('pageSize'), 'invalid_artifact_page_size')
  return {
    ...(query === undefined ? {} : { query }),
    ...(kind === undefined ? {} : { kind }),
    ...(status === undefined ? {} : { status }),
    ...(createdByKind === undefined ? {} : { createdByKind }),
    ...(createdById === undefined ? {} : { createdById }),
    ...(employeeId === undefined ? {} : { employeeId }),
    ...(page === undefined ? {} : { page }),
    ...(pageSize === undefined ? {} : { pageSize }),
  }
}

function workspaceInput(body: Record<string, unknown>, worldId: string): PublishWorkspaceArtifactInput {
  const kind = requiredEnum(body, 'kind', ARTIFACT_KINDS)
  assertBrowserPublication(body)
  const input: PublishWorkspaceArtifactInput = {
    workspaceId: requiredString(body, 'workspaceId'),
    worldId,
    sourceRelativePath: requiredString(body, 'sourceRelativePath'),
    title: requiredString(body, 'title'),
    kind,
    createdByKind: 'owner',
    createdById: 'local-user',
  }
  assignOptional(input, 'description', optionalString(body.description))
  assignOptional(input, 'entrypoint', optionalString(body.entrypoint))
  assignOptional(input, 'mimeType', optionalString(body.mimeType))
  assignOptional(input, 'artifactId', optionalString(body.artifactId))
  assignOptional(input, 'idempotencyKey', optionalString(body.idempotencyKey))
  return input
}

function importedInput(body: Record<string, unknown>, worldId: string): PublishImportedArtifactInput {
  const workspace = workspaceInput({ ...body, sourceRelativePath: body.sourcePath }, worldId)
  return { ...workspace, sourcePath: requiredString(body, 'sourcePath') }
}

function assertBrowserPublication(body: Record<string, unknown>): void {
  if (body.createdByKind !== undefined && body.createdByKind !== 'owner') {
    throw new HttpError(403, 'artifact_run_scope_denied', '角色产物必须由当前 AgentRun completion hook 发布')
  }
  for (const key of ['createdById', 'employeeId', 'sessionId', 'workTurnId', 'agentRunId', 'actorEmployeeId']) {
    if (body[key] !== undefined) throw new HttpError(403, 'artifact_run_scope_denied', '不能从浏览器伪造 AgentRun 产物 provenance')
  }
}

function assignOptional<K extends 'description' | 'entrypoint' | 'mimeType' | 'artifactId' | 'idempotencyKey'>(
  input: PublishWorkspaceArtifactInput,
  key: K,
  value: string | undefined,
): void {
  if (value !== undefined) input[key] = value
}

function assertManage(authority: WorldCharacterAuthorityService, worldId: string, actorEmployeeId: string | undefined): void {
  if (actorEmployeeId === undefined) return
  authority.assertPermission(worldId, actorEmployeeId, 'world.artifacts.manage')
}

function assertWorld(store: SqliteStore, worldId: string): void {
  if (store.getWorld(worldId) === undefined) throw new HttpError(404, 'world_not_found', 'World not found')
}

function parseVersion(value: string): number {
  const version = Number(value)
  if (!Number.isSafeInteger(version) || version < 1) throw new HttpError(422, 'invalid_artifact_version', '产物版本无效')
  return version
}

function parseOptionalPositive(value: string | null, code: string): number | undefined {
  if (value === null || value.trim() === '') return undefined
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 1) throw new HttpError(422, code, '分页参数无效')
  return number
}

function optionalEnum<T extends string>(value: string | null, values: readonly T[], code: string): T | undefined {
  if (value === null || value.trim() === '') return undefined
  if (!values.includes(value as T)) throw new HttpError(422, code, '不支持的产物筛选条件')
  return value as T
}

function optionalEnumValue<T extends string>(value: unknown, values: readonly T[]): T | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !values.includes(value as T)) throw new HttpError(422, 'invalid_enum', '字段值无效')
  return value as T
}

function requiredEnum<T extends string>(body: Record<string, unknown>, key: string, values: readonly T[]): T {
  const value = requiredString(body, key)
  if (!values.includes(value as T)) throw new HttpError(422, 'invalid_enum', `${key} has an unsupported value`)
  return value as T
}

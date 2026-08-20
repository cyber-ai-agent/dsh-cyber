import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, realpath, rename, stat, unlink } from 'node:fs/promises'
import { extname, join, relative, resolve, sep } from 'node:path'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'

import { BUILTIN_BLUEPRINTS, BUILTIN_WORLD_TEMPLATES, worldTemplate } from '@dsh-cyber/catalog'
import type {
  AgentRuntimePort,
  ChatAttachment,
  CyberMarketKind,
  JsonObject,
  LocalAssetMimeType,
  ModelProfile,
  WorldInteractionAction,
  WorldInteractionRequest,
} from '@dsh-cyber/contracts'
import {
  clearActiveHarnessRuntime,
  HarnessModelRouter,
  inspectHarnessCandidate,
  inspectHarnessCandidateContract,
  inspectHarnessCompatibility,
  readActiveHarnessRuntime,
  resolveCandidateDshBin,
  runHarnessCandidateCanary,
  writeActiveHarnessRuntime,
  type HarnessModelRoute,
} from '@dsh-cyber/harness-adapter'
import {
  ConversationOrchestrator,
  type DirectConversationInput,
} from '@dsh-cyber/orchestration'
import {
  LocalPackageCatalog,
  LocalPackageRuntime,
  PackageManager,
  type PackageRuntimePort,
} from '@dsh-cyber/package-runtime'
import { SqliteStore } from '@dsh-cyber/persistence'
import { HttpError, writeError } from './http/errors.js'
import { match } from './http/router.js'
import {
  nonNegativeInteger,
  nullableString,
  optionalPositiveInteger,
  optionalString,
  optionalStringArray,
  packageManifest,
  readJson,
  record,
  requiredBoolean,
  requiredEnum,
  requiredNumber,
  requiredString,
} from './http/request.js'
import { writeBinary, writeHtml, writeJson, writeWorkspaceFile } from './http/response.js'
import { assertLocalRequest, isLoopbackHost } from './http/security.js'
import { serveWebAsset, isMissingFile } from './http/static-files.js'
import { applyInstalledPromptTransforms, loadInstalledBlueprints } from './installed-package-runtime.js'
import { RuntimeStreamHub } from './streams/runtime-stream-hub.js'
import { WorldStreamHub } from './streams/world-stream-hub.js'
import { WorldRuntimeService } from './world-runtime-service.js'

const MAX_BACKGROUND_BYTES = 5 * 1024 * 1024
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024
const MAX_WORKSPACE_PREVIEW_BYTES = 2 * 1024 * 1024
const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 43123

export interface CyberServerOptions {
  stateRoot: string
  workspacePath: string
  webRoot?: string
  host?: string
  port?: number
  runtime?: AgentRuntimePort
  packageRuntime?: PackageRuntimePort
  marketplaceRoot?: string
}

export interface CyberServerAddress {
  host: string
  port: number
  origin: string
}

export interface CyberServer {
  readonly store: SqliteStore
  readonly orchestrator: ConversationOrchestrator
  readonly packageManager: PackageManager
  start(): Promise<CyberServerAddress>
  address(): CyberServerAddress | undefined
  close(): Promise<void>
}

export async function createCyberServer(options: CyberServerOptions): Promise<CyberServer> {
  const host = options.host ?? DEFAULT_HOST
  if (!isLoopbackHost(host)) {
    throw new Error('Phase 1 server only supports loopback hosts')
  }
  const port = options.port ?? DEFAULT_PORT
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid port: ${port}`)
  }
  const stateRoot = resolve(options.stateRoot)
  const workspaceRoot = await realpath(resolve(options.workspacePath))
  const webRoot = resolve(options.webRoot ?? fileURLToPath(new URL('../../web/dist', import.meta.url)))
  await mkdir(join(stateRoot, 'data'), { recursive: true })
  const compatibility = await inspectHarnessCompatibility(join(stateRoot, 'runtime', 'harness-home'))
  if (!compatibility.ok) {
    throw new Error(`Harness compatibility check failed: ${compatibility.errors.join('; ')}`)
  }
  const store = await SqliteStore.open(join(stateRoot, 'data', 'dsh-cyber.sqlite'))
  for (const blueprint of BUILTIN_BLUEPRINTS) store.saveBlueprint(blueprint)

  const runtimeStateRoot = join(stateRoot, 'runtime')
  const activeRuntime = await readActiveHarnessRuntime(runtimeStateRoot)
  let activeDshBinPath: string | undefined
  if (activeRuntime !== undefined) {
    const activeReport = await inspectHarnessCandidate({
      candidateRoot: activeRuntime.candidateRoot,
      stateRoot: runtimeStateRoot,
    })
    if (!activeReport.ok || activeReport.version !== activeRuntime.version) {
      store.close()
      throw new Error(
        `Activated Harness runtime is unavailable or incompatible. Run "dsh-cyber runtime-rollback --data-dir ${stateRoot}" to recover.`,
      )
    }
    activeDshBinPath = await resolveCandidateDshBin(activeRuntime.candidateRoot)
  }

  const runtime =
    options.runtime ??
    new HarnessModelRouter({
      stateRoot: runtimeStateRoot,
      ...(activeDshBinPath === undefined ? {} : { dshBinPath: activeDshBinPath }),
      resolveRoute(request) {
        const selectedProfileId = request.revision.modelPolicy.modelProfileId
        const selectedProfile = typeof selectedProfileId === 'string'
          ? store.getModelProfile(selectedProfileId)
          : undefined
        const profile = selectedProfile?.workspaceId === request.agent.workspaceId
          ? selectedProfile
          : store.resolveModelProfile(request.agent.workspaceId, request.agent.worldId, request.agent.id)
        return profile === undefined ? undefined : harnessModelRoute(profile)
      },
    })
  const orchestrator = new ConversationOrchestrator({
    store,
    runtime,
    workspacePath: workspaceRoot,
  })
  const packageManager = new PackageManager({
    store,
    runtime: options.packageRuntime ?? new LocalPackageRuntime(join(stateRoot, 'packages')),
  })
  const packageCatalog = new LocalPackageCatalog(
    options.marketplaceRoot ?? fileURLToPath(new URL('../../../marketplace', import.meta.url)),
  )
  const runtimeStreamHub = new RuntimeStreamHub()
  const worldStreamHub = new WorldStreamHub()
  const worldRuntime = new WorldRuntimeService({
    store,
    publish(event) {
      worldStreamHub.publish(event)
    },
  })
  let startedAddress: CyberServerAddress | undefined
  let closed = false

  const httpServer = createServer((request, response) => {
    void handleRequest({
      request,
      response,
      store,
      orchestrator,
      packageManager,
      packageCatalog,
      stateRoot,
      workspaceRoot,
      webRoot,
      runtimeStreamHub,
      worldStreamHub,
      worldRuntime,
    }).catch((error: unknown) => writeError(response, error))
  })
  httpServer.requestTimeout = 0
  httpServer.headersTimeout = 10_000
  httpServer.keepAliveTimeout = 5_000

  const unsubscribe = orchestrator.subscribe((event) => {
    runtimeStreamHub.publish(event)
    worldRuntime.publishRuntime(event.worldId, event.event, event.agentId)
  })

  return {
    store,
    orchestrator,
    packageManager,
    async start() {
      if (closed) throw new Error('Server is closed')
      if (startedAddress !== undefined) return startedAddress
      await listen(httpServer, port, host)
      const address = httpServer.address()
      if (address === null || typeof address === 'string') {
        throw new Error('Server did not expose a TCP address')
      }
      startedAddress = {
        host,
        port: address.port,
        origin: `http://${host}:${address.port}`,
      }
      return startedAddress
    },
    address() {
      return startedAddress
    },
    async close() {
      if (closed) return
      closed = true
      unsubscribe()
      runtimeStreamHub.close()
      worldStreamHub.close()
      if (httpServer.listening) await closeServer(httpServer)
      await orchestrator.close()
      store.close()
    },
  }
}

async function handleRequest(context: {
  request: IncomingMessage
  response: ServerResponse
  store: SqliteStore
  orchestrator: ConversationOrchestrator
  packageManager: PackageManager
  packageCatalog: LocalPackageCatalog
  stateRoot: string
  workspaceRoot: string
  webRoot: string
  runtimeStreamHub: RuntimeStreamHub
  worldStreamHub: WorldStreamHub
  worldRuntime: WorldRuntimeService
}): Promise<void> {
  const {
    request,
    response,
    store,
    orchestrator,
    packageManager,
    packageCatalog,
    stateRoot,
    workspaceRoot,
    webRoot,
    runtimeStreamHub,
    worldStreamHub,
    worldRuntime,
  } = context
  assertLocalRequest(request)
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  const method = request.method ?? 'GET'

  if (method === 'GET' && !url.pathname.startsWith('/api/')) {
    if (await serveWebAsset(response, webRoot, url.pathname)) return
  }
  if (method === 'GET' && url.pathname === '/api/health') {
    writeJson(response, 200, { ok: true, database: store.doctor() })
    return
  }
  if (method === 'GET' && url.pathname === '/api/system/compatibility') {
    const compatibility = await inspectHarnessCompatibility(join(stateRoot, 'runtime', 'harness-home'))
    writeJson(response, compatibility.ok ? 200 : 503, compatibility)
    return
  }
  if (method === 'GET' && url.pathname === '/api/system/status') {
    const compatibility = await inspectHarnessCompatibility(join(stateRoot, 'runtime', 'harness-home'))
    const database = store.doctor()
    writeJson(response, 200, {
      ok: compatibility.ok && database.ok,
      checkedAt: new Date().toISOString(),
      stateRoot,
      database,
      compatibility,
      activeRuntime: await readActiveHarnessRuntime(join(stateRoot, 'runtime')),
      runtimeUpdates: store.listRuntimeUpdateTransactions().slice(0, 10),
    })
    return
  }
  if (method === 'POST' && url.pathname === '/api/system/doctor') {
    const database = store.doctor()
    writeJson(response, 200, { ok: database.ok, checkedAt: new Date().toISOString(), database })
    return
  }
  if (method === 'POST' && url.pathname === '/api/system/backup') {
    const destination = join(stateRoot, 'backups', `dsh-cyber-${artifactTimestamp()}.sqlite`)
    const output = await store.backup(destination)
    writeJson(response, 201, { ok: true, kind: 'backup', output, createdAt: new Date().toISOString() })
    return
  }
  if (method === 'POST' && url.pathname === '/api/system/export') {
    const destination = join(stateRoot, 'backups', `dsh-cyber-${artifactTimestamp()}.json`)
    const output = await store.exportJson(destination)
    writeJson(response, 201, { ok: true, kind: 'export', output, createdAt: new Date().toISOString() })
    return
  }
  if (method === 'POST' && url.pathname === '/api/system/update/verify') {
    const body = await readJson(request)
    const report = await inspectHarnessCandidate({
      candidateRoot: requiredString(body, 'candidateRoot'),
      stateRoot: join(stateRoot, 'runtime'),
    })
    if (!report.ok || report.version === undefined || report.contractId === undefined) {
      writeJson(response, 200, report)
      return
    }
    const activeRuntime = await readActiveHarnessRuntime(join(stateRoot, 'runtime'))
    const transaction = store.beginRuntimeUpdate({
      candidateRoot: report.candidateRoot,
      version: report.version,
      contractId: report.contractId,
      ...(activeRuntime === undefined ? {} : { previousRuntimeRoot: activeRuntime.candidateRoot }),
      report: report as unknown as JsonObject,
    })
    writeJson(response, 201, { ...report, transaction })
    return
  }
  if (method === 'GET' && url.pathname === '/api/system/updates') {
    writeJson(response, 200, {
      items: store.listRuntimeUpdateTransactions(),
      activeRuntime: await readActiveHarnessRuntime(join(stateRoot, 'runtime')),
    })
    return
  }
  const contractTestUpdate = match(url.pathname, /^\/api\/system\/update\/([^/]+)\/contract-test$/)
  if (method === 'POST' && contractTestUpdate !== undefined) {
    const transaction = store.getRuntimeUpdateTransaction(contractTestUpdate[0])
    if (transaction === undefined) throw new HttpError(404, 'runtime_update_not_found', 'Runtime update transaction not found')
    try {
      const report = await inspectHarnessCandidateContract({
        candidateRoot: transaction.candidateRoot,
        stateRoot: join(stateRoot, 'runtime'),
      })
      const updated = store.transitionRuntimeUpdate({
        transactionId: transaction.id,
        status: 'contract-tested',
        report,
      })
      writeJson(response, 200, { ok: true, transaction: updated })
    } catch (error) {
      const updated = store.transitionRuntimeUpdate({
        transactionId: transaction.id,
        status: 'rejected',
        errorCode: 'runtime_contract_failed',
        report: { ok: false, message: errorMessage(error) },
      })
      writeJson(response, 422, { ok: false, transaction: updated, errors: [errorMessage(error)] })
    }
    return
  }
  const canaryUpdate = match(url.pathname, /^\/api\/system\/update\/([^/]+)\/canary$/)
  if (method === 'POST' && canaryUpdate !== undefined) {
    const transaction = store.getRuntimeUpdateTransaction(canaryUpdate[0])
    if (transaction === undefined) throw new HttpError(404, 'runtime_update_not_found', 'Runtime update transaction not found')
    const body = await readJson(request)
    const modelProfile = store.getModelProfile(requiredString(body, 'modelProfileId'))
    if (modelProfile === undefined) throw new HttpError(404, 'model_profile_not_found', 'Model profile not found')
    try {
      const report = await runHarnessCandidateCanary({
        candidateRoot: transaction.candidateRoot,
        stateRoot: join(stateRoot, 'runtime', 'updates', transaction.id),
        workspacePath: workspaceRoot,
        route: harnessModelRoute(modelProfile),
        inheritedEnvironment: process.env,
      })
      const updated = store.transitionRuntimeUpdate({
        transactionId: transaction.id,
        status: 'canary-passed',
        report,
      })
      writeJson(response, 200, { ok: true, transaction: updated })
    } catch (error) {
      const updated = store.transitionRuntimeUpdate({
        transactionId: transaction.id,
        status: 'rejected',
        errorCode: 'runtime_canary_failed',
        report: { ok: false, message: errorMessage(error) },
      })
      writeJson(response, 422, { ok: false, transaction: updated, errors: [errorMessage(error)] })
    }
    return
  }
  const activateUpdate = match(url.pathname, /^\/api\/system\/update\/([^/]+)\/activate$/)
  if (method === 'POST' && activateUpdate !== undefined) {
    const body = await readJson(request)
    if (!requiredBoolean(body, 'approved')) throw new HttpError(409, 'runtime_activation_approval_required', 'Explicit activation approval is required')
    const transaction = store.getRuntimeUpdateTransaction(activateUpdate[0])
    if (transaction === undefined) throw new HttpError(404, 'runtime_update_not_found', 'Runtime update transaction not found')
    if (transaction.status !== 'canary-passed') throw new HttpError(409, 'runtime_update_not_ready', 'Runtime must pass the canary before activation')
    const verification = await inspectHarnessCandidate({
      candidateRoot: transaction.candidateRoot,
      stateRoot: join(stateRoot, 'runtime'),
    })
    if (!verification.ok || verification.version !== transaction.version) {
      throw new HttpError(409, 'runtime_candidate_changed', 'Candidate changed after canary verification')
    }
    const backup = await store.backup(join(stateRoot, 'backups', `pre-runtime-${artifactTimestamp()}.sqlite`))
    const previousPointer = await readActiveHarnessRuntime(join(stateRoot, 'runtime'))
    try {
      await writeActiveHarnessRuntime(join(stateRoot, 'runtime'), {
        schemaVersion: 1,
        transactionId: transaction.id,
        candidateRoot: transaction.candidateRoot,
        version: transaction.version,
        activatedAt: new Date().toISOString(),
      })
      const updated = store.transitionRuntimeUpdate({
        transactionId: transaction.id,
        status: 'activated',
        report: { ok: true, backup, restartRequired: true },
      })
      writeJson(response, 200, { ok: true, transaction: updated, backup, restartRequired: true })
    } catch (error) {
      if (previousPointer === undefined) await clearActiveHarnessRuntime(join(stateRoot, 'runtime'))
      else await writeActiveHarnessRuntime(join(stateRoot, 'runtime'), previousPointer)
      throw error
    }
    return
  }
  const rollbackUpdate = match(url.pathname, /^\/api\/system\/update\/([^/]+)\/rollback$/)
  if (method === 'POST' && rollbackUpdate !== undefined) {
    const body = await readJson(request)
    if (!requiredBoolean(body, 'approved')) throw new HttpError(409, 'runtime_rollback_approval_required', 'Explicit rollback approval is required')
    const transaction = store.getRuntimeUpdateTransaction(rollbackUpdate[0])
    if (transaction === undefined) throw new HttpError(404, 'runtime_update_not_found', 'Runtime update transaction not found')
    if (transaction.status !== 'activated') throw new HttpError(409, 'runtime_update_not_active', 'Only an activated runtime can be rolled back')
    const backup = await store.backup(join(stateRoot, 'backups', `pre-rollback-${artifactTimestamp()}.sqlite`))
    if (transaction.previousRuntimeRoot === undefined) {
      await clearActiveHarnessRuntime(join(stateRoot, 'runtime'))
    } else {
      const previous = await inspectHarnessCandidate({
        candidateRoot: transaction.previousRuntimeRoot,
        stateRoot: join(stateRoot, 'runtime'),
      })
      if (!previous.ok || previous.version === undefined) {
        throw new HttpError(409, 'previous_runtime_unavailable', 'Previous runtime is unavailable; use the CLI recovery command to return to bundled DSH')
      }
      await writeActiveHarnessRuntime(join(stateRoot, 'runtime'), {
        schemaVersion: 1,
        transactionId: `rollback-${transaction.id}`,
        candidateRoot: previous.candidateRoot,
        version: previous.version,
        activatedAt: new Date().toISOString(),
      })
    }
    const updated = store.transitionRuntimeUpdate({
      transactionId: transaction.id,
      status: 'rolled-back',
      report: { ok: true, backup, restartRequired: true },
    })
    writeJson(response, 200, { ok: true, transaction: updated, backup, restartRequired: true })
    return
  }
  if (method === 'GET' && url.pathname === '/api/workspace/files') {
    const directory = await resolveWorkspaceEntry(workspaceRoot, url.searchParams.get('path') ?? '')
    const directoryInfo = await stat(directory.absolutePath)
    if (!directoryInfo.isDirectory()) {
      throw new HttpError(422, 'workspace_directory_required', 'Workspace path is not a directory')
    }
    const items = await Promise.all((await readdir(directory.absolutePath, { withFileTypes: true }))
      .filter((entry) => !entry.isSymbolicLink())
      .map(async (entry) => {
        const entryPath = directory.relativePath ? `${directory.relativePath}/${entry.name}` : entry.name
        if (workspaceEntryIsHidden(entryPath)) return undefined
        const entryInfo = await stat(join(directory.absolutePath, entry.name))
        return {
          name: entry.name,
          path: entryPath,
          kind: entryInfo.isDirectory() ? 'directory' : 'file',
          size: entryInfo.isFile() ? entryInfo.size : 0,
          updatedAt: entryInfo.mtime.toISOString(),
          previewKind: entryInfo.isFile() ? workspacePreviewKind(entry.name)?.kind : undefined,
        }
      }))
    writeJson(response, 200, {
      path: directory.relativePath,
      parentPath: directory.relativePath.includes('/')
        ? directory.relativePath.slice(0, directory.relativePath.lastIndexOf('/'))
        : directory.relativePath ? '' : undefined,
      items: items
        .filter((entry) => entry !== undefined)
        .sort((left, right) => left.kind === right.kind
          ? left.name.localeCompare(right.name)
          : left.kind === 'directory' ? -1 : 1),
    })
    return
  }
  if (method === 'GET' && url.pathname === '/api/workspace/file') {
    const file = await resolveWorkspaceEntry(workspaceRoot, url.searchParams.get('path') ?? '')
    const fileInfo = await stat(file.absolutePath)
    if (!fileInfo.isFile()) throw new HttpError(422, 'workspace_file_required', 'Workspace path is not a file')
    if (fileInfo.size > MAX_WORKSPACE_PREVIEW_BYTES) {
      throw new HttpError(413, 'workspace_file_too_large', 'Workspace preview is limited to 2 MiB')
    }
    const preview = workspacePreviewKind(file.relativePath)
    if (preview === undefined) throw new HttpError(415, 'workspace_file_unsupported', 'File type cannot be previewed')
    writeWorkspaceFile(response, await readFile(file.absolutePath), preview.contentType)
    return
  }
  if (method === 'GET' && url.pathname === '/api/catalog/world-templates') {
    writeJson(response, 200, { items: BUILTIN_WORLD_TEMPLATES })
    return
  }
  if (method === 'GET' && url.pathname === '/api/catalog/blueprints') {
    const templateId = url.searchParams.get('templateId')
    const workspaceId = url.searchParams.get('workspaceId')
    const installed = workspaceId === null ? [] : store.listInstalledPackages(workspaceId)
    const packageBlueprints = await loadInstalledBlueprints(installed)
    for (const blueprint of packageBlueprints) store.saveBlueprint(blueprint)
    const available = [...BUILTIN_BLUEPRINTS, ...packageBlueprints]
    const items = templateId
      ? available.filter((item) => item.worldTemplateId === templateId)
      : available
    writeJson(response, 200, { items })
    return
  }
  if (method === 'GET' && url.pathname === '/api/marketplace') {
    const market = url.searchParams.get('market')
    if (market !== null && !['theme', 'plugin', 'talent'].includes(market)) {
      throw new HttpError(422, 'invalid_market', 'Unknown marketplace')
    }
    const workspaceId = url.searchParams.get('workspaceId')
    const installed = workspaceId === null ? [] : store.listInstalledPackages(workspaceId)
    const items = await packageCatalog.list({
      ...(market === null ? {} : { market: market as CyberMarketKind }),
      ...(url.searchParams.get('q') === null ? {} : { query: url.searchParams.get('q')! }),
      installed,
    })
    writeJson(response, 200, { items })
    return
  }
  if (method === 'GET' && url.pathname === '/api/workspaces') {
    writeJson(response, 200, { items: store.listWorkspaces() })
    return
  }
  if (method === 'POST' && url.pathname === '/api/workspaces') {
    const body = await readJson(request)
    const workspace = store.createWorkspace({ name: requiredString(body, 'name') })
    writeJson(response, 201, { workspace })
    return
  }

  const workspaceSnapshot = match(url.pathname, /^\/api\/workspaces\/([^/]+)\/snapshot$/)
  if (method === 'GET' && workspaceSnapshot !== undefined) {
    writeJson(response, 200, store.getWorkspaceSnapshot(workspaceSnapshot[0]))
    return
  }
  const workspacePreferences = match(url.pathname, /^\/api\/workspaces\/([^/]+)\/preferences$/)
  if (workspacePreferences !== undefined && method === 'GET') {
    writeJson(response, 200, { preferences: store.getWorkspacePreferences(workspacePreferences[0]) })
    return
  }
  if (workspacePreferences !== undefined && method === 'PUT') {
    const body = await readJson(request)
    const preferences = store.updateWorkspacePreferences({
      workspaceId: workspacePreferences[0],
      ...(body.colorScheme === undefined
        ? {}
        : { colorScheme: requiredEnum(body, 'colorScheme', ['system', 'light', 'dark']) }),
      ...(body.skinId === undefined ? {} : { skinId: requiredString(body, 'skinId') }),
      ...(body.backgroundAssetRef === undefined
        ? {}
        : { backgroundAssetRef: nullableString(body.backgroundAssetRef) }),
      ...(body.backgroundFit === undefined
        ? {}
        : { backgroundFit: requiredEnum(body, 'backgroundFit', ['cover', 'contain', 'tile']) }),
      ...(body.backgroundOpacity === undefined
        ? {}
        : { backgroundOpacity: requiredNumber(body, 'backgroundOpacity') }),
      ...(body.interfaceDensity === undefined
        ? {}
        : { interfaceDensity: requiredEnum(body, 'interfaceDensity', ['comfortable', 'compact']) }),
      ...(body.motion === undefined
        ? {}
        : { motion: requiredEnum(body, 'motion', ['system', 'reduced', 'full']) }),
      ...(body.leftPaneWidth === undefined
        ? {}
        : { leftPaneWidth: requiredNumber(body, 'leftPaneWidth') }),
      ...(body.rightPaneWidth === undefined
        ? {}
        : { rightPaneWidth: requiredNumber(body, 'rightPaneWidth') }),
    })
    writeJson(response, 200, { preferences })
    return
  }
  const workspaceModels = match(url.pathname, /^\/api\/workspaces\/([^/]+)\/model-profiles$/)
  if (workspaceModels !== undefined && method === 'GET') {
    writeJson(response, 200, {
      items: store.listModelProfiles(workspaceModels[0]).map((profile) => ({
        ...profile,
        credentialConfigured: profile.credentialEnvName === undefined
          ? profile.providerKind === 'openai-compatible-local'
          : Boolean(process.env[profile.credentialEnvName]),
      })),
      assignments: store.listModelAssignments(workspaceModels[0]),
    })
    return
  }
  const workspaceAssets = match(url.pathname, /^\/api\/workspaces\/([^/]+)\/assets$/)
  if (workspaceAssets !== undefined && method === 'GET') {
    writeJson(response, 200, { items: store.listLocalAssets(workspaceAssets[0]) })
    return
  }
  const workspaceBackground = match(
    url.pathname,
    /^\/api\/workspaces\/([^/]+)\/assets\/background$/,
  )
  if (workspaceBackground !== undefined && method === 'POST') {
    if (store.getWorkspace(workspaceBackground[0]) === undefined) {
      throw new HttpError(404, 'workspace_not_found', 'Workspace not found')
    }
    const body = await readJson(request)
    const mimeType = requiredEnum(body, 'mimeType', ['image/png', 'image/jpeg', 'image/webp'])
    const encoded = requiredString(body, 'dataBase64')
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
      throw new HttpError(422, 'invalid_base64', 'Background data must be base64')
    }
    const bytes = Buffer.from(encoded, 'base64')
    if (bytes.length < 1 || bytes.length > MAX_BACKGROUND_BYTES) {
      throw new HttpError(422, 'asset_size_rejected', 'Background image must be between 1 byte and 5 MiB')
    }
    if (!matchesImageSignature(bytes, mimeType)) {
      throw new HttpError(422, 'asset_signature_rejected', 'Background image signature does not match its MIME type')
    }
    const id = randomUUID()
    const extension = mimeType === 'image/png' ? 'png' : mimeType === 'image/jpeg' ? 'jpg' : 'webp'
    const relativePath = `${workspaceBackground[0]}/${id}.${extension}`
    const assetRoot = join(stateRoot, 'assets')
    const destination = join(assetRoot, relativePath)
    const temporary = `${destination}.tmp-${randomUUID()}`
    await mkdir(join(assetRoot, workspaceBackground[0]), { recursive: true })
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, destination)
    try {
      const asset = store.saveLocalAsset({
        id,
        workspaceId: workspaceBackground[0],
        kind: 'background',
        mimeType,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        relativePath,
        byteLength: bytes.length,
      })
      writeJson(response, 201, { asset, url: `/api/assets/${asset.id}` })
    } catch (error) {
      await unlink(destination).catch(() => undefined)
      throw error
    }
    return
  }
  const workspaceAttachment = match(
    url.pathname,
    /^\/api\/workspaces\/([^/]+)\/assets\/attachment$/,
  )
  if (workspaceAttachment !== undefined && method === 'POST') {
    if (store.getWorkspace(workspaceAttachment[0]) === undefined) {
      throw new HttpError(404, 'workspace_not_found', 'Workspace not found')
    }
    const body = await readJson(request)
    const name = requiredString(body, 'name').slice(0, 180)
    const mimeType = requiredEnum(body, 'mimeType', [
      'image/png', 'image/jpeg', 'image/webp',
      'text/plain', 'text/markdown', 'application/json', 'application/pdf',
    ])
    const encoded = requiredString(body, 'dataBase64')
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
      throw new HttpError(422, 'invalid_base64', 'Attachment data must be base64')
    }
    const bytes = Buffer.from(encoded, 'base64')
    if (bytes.length < 1 || bytes.length > MAX_ATTACHMENT_BYTES) {
      throw new HttpError(422, 'asset_size_rejected', 'Attachment must be between 1 byte and 5 MiB')
    }
    if (!matchesAttachmentSignature(bytes, mimeType)) {
      throw new HttpError(422, 'asset_signature_rejected', 'Attachment content does not match its MIME type')
    }
    const id = randomUUID()
    const relativePath = `${workspaceAttachment[0]}/attachments/${id}.${attachmentExtension(mimeType)}`
    const assetRoot = join(stateRoot, 'assets')
    const destination = join(assetRoot, relativePath)
    const temporary = `${destination}.tmp-${randomUUID()}`
    await mkdir(join(assetRoot, workspaceAttachment[0], 'attachments'), { recursive: true })
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, destination)
    try {
      const asset = store.saveLocalAsset({
        id,
        workspaceId: workspaceAttachment[0],
        kind: 'attachment',
        mimeType,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        relativePath,
        byteLength: bytes.length,
      })
      writeJson(response, 201, {
        asset,
        attachment: { assetId: asset.id, name, mimeType, byteLength: bytes.length, url: `/api/assets/${asset.id}` },
      })
    } catch (error) {
      await unlink(destination).catch(() => undefined)
      throw error
    }
    return
  }
  if (workspaceModels !== undefined && method === 'POST') {
    const body = await readJson(request)
    const profile = store.saveModelProfile({
      ...(body.id === undefined ? {} : { id: requiredString(body, 'id') }),
      workspaceId: workspaceModels[0],
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
    return
  }
  const modelAssignment = match(
    url.pathname,
    /^\/api\/workspaces\/([^/]+)\/model-assignments\/(workspace|world|employee)\/([^/]+)$/,
  )
  if (modelAssignment !== undefined && method === 'PUT') {
    const body = await readJson(request)
    const assignment = store.saveModelAssignment({
      workspaceId: modelAssignment[0],
      scope: modelAssignment[1] as 'workspace' | 'world' | 'employee',
      scopeId: modelAssignment[2]!,
      modelProfileId: requiredString(body, 'modelProfileId'),
    })
    writeJson(response, 200, { assignment })
    return
  }
  if (modelAssignment !== undefined && method === 'DELETE') {
    const removed = store.clearModelAssignment(
      modelAssignment[0],
      modelAssignment[1] as 'workspace' | 'world' | 'employee',
      modelAssignment[2]!,
    )
    writeJson(response, 200, { removed })
    return
  }
  const workspaceWorlds = match(url.pathname, /^\/api\/workspaces\/([^/]+)\/worlds$/)
  if (workspaceWorlds !== undefined && method === 'GET') {
    writeJson(response, 200, { items: store.listWorlds(workspaceWorlds[0]) })
    return
  }
  if (workspaceWorlds !== undefined && method === 'POST') {
    const body = await readJson(request)
    const templateId = requiredString(body, 'templateId')
    if (worldTemplate(templateId) === undefined) {
      throw new HttpError(422, 'unknown_world_template', 'Unknown world template')
    }
    const world = store.createWorld({
      workspaceId: workspaceWorlds[0],
      name: requiredString(body, 'name'),
      templateId,
    })
    writeJson(response, 201, { world })
    return
  }

  const workspacePackages = match(url.pathname, /^\/api\/workspaces\/([^/]+)\/packages$/)
  if (workspacePackages !== undefined && method === 'GET') {
    if (store.getWorkspace(workspacePackages[0]) === undefined) {
      throw new HttpError(404, 'workspace_not_found', 'Workspace not found')
    }
    writeJson(response, 200, {
      items: store.listInstalledPackages(workspacePackages[0]),
      transactions: store.listPackageInstallTransactions(workspacePackages[0]),
    })
    return
  }
  const packagePreview = match(
    url.pathname,
    /^\/api\/workspaces\/([^/]+)\/packages\/preview$/,
  )
  if (packagePreview !== undefined && method === 'POST') {
    if (store.getWorkspace(packagePreview[0]) === undefined) {
      throw new HttpError(404, 'workspace_not_found', 'Workspace not found')
    }
    const body = await readJson(request)
    const preview = packageManager.preview(packagePreview[0], packageManifest(body.manifest))
    writeJson(response, 200, preview)
    return
  }
  const packageInstall = match(
    url.pathname,
    /^\/api\/workspaces\/([^/]+)\/packages\/install$/,
  )
  if (packageInstall !== undefined && method === 'POST') {
    if (store.getWorkspace(packageInstall[0]) === undefined) {
      throw new HttpError(404, 'workspace_not_found', 'Workspace not found')
    }
    const body = await readJson(request)
    const installed = await packageManager.install({
      workspaceId: packageInstall[0],
      manifest: packageManifest(body.manifest),
      sourceDirectory: requiredString(body, 'sourceDirectory'),
      approvalToken: requiredString(body, 'approvalToken'),
      actorId: 'owner',
    })
    writeJson(response, 201, { installed })
    return
  }
  const marketplacePreview = match(
    url.pathname,
    /^\/api\/workspaces\/([^/]+)\/marketplace\/preview$/,
  )
  if (marketplacePreview !== undefined && method === 'POST') {
    const body = await readJson(request)
    const item = await packageCatalog.find(requiredString(body, 'packageId'), optionalString(body.version))
    if (item === undefined) throw new HttpError(404, 'market_package_not_found', 'Marketplace package not found')
    writeJson(response, 200, {
      item,
      preview: packageManager.preview(marketplacePreview[0], item.manifest),
    })
    return
  }
  const marketplaceInstall = match(
    url.pathname,
    /^\/api\/workspaces\/([^/]+)\/marketplace\/install$/,
  )
  if (marketplaceInstall !== undefined && method === 'POST') {
    const body = await readJson(request)
    const item = await packageCatalog.find(requiredString(body, 'packageId'), optionalString(body.version))
    if (item === undefined) throw new HttpError(404, 'market_package_not_found', 'Marketplace package not found')
    const installed = await packageManager.install({
      workspaceId: marketplaceInstall[0],
      manifest: item.manifest,
      sourceDirectory: item.sourceDirectory,
      approvalToken: requiredString(body, 'approvalToken'),
      actorId: 'owner',
    })
    if (installed.kind === 'employee-blueprint') {
      for (const blueprint of await loadInstalledBlueprints([installed])) store.saveBlueprint(blueprint)
    }
    writeJson(response, 201, { installed })
    return
  }

  const worldSnapshot = match(url.pathname, /^\/api\/worlds\/([^/]+)\/snapshot$/)
  if (method === 'GET' && worldSnapshot !== undefined) {
    writeJson(response, 200, store.getWorldSnapshot(worldSnapshot[0]))
    return
  }
  const worldRuntimeSnapshot = match(url.pathname, /^\/api\/worlds\/([^/]+)\/runtime-snapshot$/)
  if (method === 'GET' && worldRuntimeSnapshot !== undefined) {
    writeJson(response, 200, worldRuntime.getSnapshot(worldRuntimeSnapshot[0]))
    return
  }
  const worldRuntimeCapability = match(url.pathname, /^\/api\/worlds\/([^/]+)\/runtime-capability$/)
  if (method === 'GET' && worldRuntimeCapability !== undefined) {
    const worldId = worldRuntimeCapability[0]
    const supported = worldRuntime.supports(worldId)
    writeJson(response, 200, {
      supported,
      ...(supported ? { renderer: worldRuntime.getThemeManifest(worldId).renderer } : {}),
    })
    return
  }
  const worldThemeManifest = match(url.pathname, /^\/api\/worlds\/([^/]+)\/theme-manifest$/)
  if (method === 'GET' && worldThemeManifest !== undefined) {
    writeJson(response, 200, worldRuntime.getThemeManifest(worldThemeManifest[0]))
    return
  }
  const worldThemes = match(url.pathname, /^\/api\/worlds\/([^/]+)\/themes$/)
  if (method === 'GET' && worldThemes !== undefined) {
    writeJson(response, 200, await worldRuntime.listThemes(worldThemes[0]))
    return
  }
  const worldThemeBinding = match(url.pathname, /^\/api\/worlds\/([^/]+)\/theme-binding$/)
  if (method === 'PUT' && worldThemeBinding !== undefined) {
    const body = await readJson(request)
    const action = requiredEnum(body, 'action', ['bind', 'disable', 'fallback'])
    const snapshot = action === 'bind'
      ? await worldRuntime.bindInstalledTheme(worldThemeBinding[0], requiredString(body, 'packageId'))
      : worldRuntime.useBuiltInTheme(worldThemeBinding[0])
    writeJson(response, 200, { action, snapshot, binding: store.getWorldThemeBinding(worldThemeBinding[0]) })
    return
  }
  const worldThemeAsset = match(url.pathname, /^\/api\/worlds\/([^/]+)\/theme-assets\/([^/]+)$/)
  if (method === 'GET' && worldThemeAsset !== undefined) {
    const asset = await worldRuntime.getThemeAsset(worldThemeAsset[0], worldThemeAsset[1]!)
    writeBinary(response, 200, asset.body, asset.contentType)
    return
  }
  const worldInteractions = match(url.pathname, /^\/api\/worlds\/([^/]+)\/interactions$/)
  if (method === 'POST' && worldInteractions !== undefined) {
    const body = await readJson(request)
    const action = requiredEnum<WorldInteractionAction>(body, 'action', [
      'focus',
      'talk',
      'assign-task',
      'inspect',
      'use-object',
      'start-meeting',
      'toggle-lights',
      'fit-camera',
    ])
    const interaction: WorldInteractionRequest = {
      action,
      actorId: optionalString(body.actorId) ?? 'owner',
      ...(optionalString(body.entityId) === undefined ? {} : { entityId: optionalString(body.entityId)! }),
      ...(optionalString(body.objectId) === undefined ? {} : { objectId: optionalString(body.objectId)! }),
      ...(body.participantIds === undefined ? {} : { participantIds: optionalStringArray(body.participantIds) }),
      ...(optionalString(body.prompt) === undefined ? {} : { prompt: optionalString(body.prompt)! }),
      ...(record(body.metadata) === undefined ? {} : { metadata: record(body.metadata) as JsonObject }),
    }
    writeJson(response, 202, worldRuntime.interact(worldInteractions[0], interaction))
    return
  }
  const worldStream = match(url.pathname, /^\/api\/worlds\/([^/]+)\/stream$/)
  if (method === 'GET' && worldStream !== undefined) {
    const worldId = worldStream[0]
    const world = store.getWorld(worldId)
    if (world === undefined) throw new HttpError(404, 'world_not_found', 'World not found')
    const snapshot = worldRuntime.getSnapshot(worldId)
    worldStreamHub.connect(worldId, request, response, snapshot, url.searchParams.get('after'))
    return
  }
  const worldEvents = match(url.pathname, /^\/api\/worlds\/([^/]+)\/events$/)
  if (method === 'GET' && worldEvents !== undefined) {
    writeJson(response, 200, {
      items: store.listWorldDomainEvents(worldEvents[0], nonNegativeInteger(url.searchParams.get('after'))),
    })
    return
  }
  const worldSessions = match(url.pathname, /^\/api\/worlds\/([^/]+)\/sessions$/)
  if (method === 'GET' && worldSessions !== undefined) {
    if (store.getWorld(worldSessions[0]) === undefined) {
      throw new HttpError(404, 'world_not_found', 'World not found')
    }
    writeJson(response, 200, { items: store.listSessions(worldSessions[0]) })
    return
  }
  const worldRecruit = match(url.pathname, /^\/api\/worlds\/([^/]+)\/recruit$/)
  if (method === 'POST' && worldRecruit !== undefined) {
    const world = store.getWorld(worldRecruit[0])
    if (world === undefined) throw new HttpError(404, 'world_not_found', 'World not found')
    const body = await readJson(request)
    const recruitInput: Parameters<SqliteStore['recruitEmployee']>[0] = {
      workspaceId: world.workspaceId,
      worldId: world.id,
      blueprintId: requiredString(body, 'blueprintId'),
      blueprintVersion: optionalPositiveInteger(body.blueprintVersion) ?? 1,
    }
    const displayName = optionalString(body.displayName)
    if (displayName !== undefined) recruitInput.displayName = displayName
    const employee = store.recruitEmployee(recruitInput)
    writeJson(response, 201, { employee })
    return
  }
  const worldChat = match(url.pathname, /^\/api\/worlds\/([^/]+)\/chat$/)
  if (method === 'POST' && worldChat !== undefined) {
    const world = store.getWorld(worldChat[0])
    if (world === undefined) throw new HttpError(404, 'world_not_found', 'World not found')
    const body = await readJson(request)
    const prompt = requiredString(body, 'prompt')
    const attachments = validatedChatAttachments(body.attachments, store, world.workspaceId)
    const metadata: JsonObject | undefined = attachments.length === 0
      ? undefined
      : { attachments: attachments.map(chatAttachmentJson) }
    const attachmentPrompt = attachments.length === 0 ? prompt : attachmentAwarePrompt(prompt, attachments)
    const transformedPrompt = await applyInstalledPromptTransforms(
      store.listInstalledPackages(world.workspaceId),
      attachmentPrompt,
    )
    const runtimePrompt = transformedPrompt === prompt && attachments.length === 0
      ? undefined
      : transformedPrompt
    const explicitIds = optionalStringArray(body.employeeIds)
    const employeeIds = explicitIds.length > 0
      ? explicitIds
      : mentionedEmployeeIds(prompt, store.listEmployees(world.id))
    if (employeeIds.length === 0) {
      throw new HttpError(422, 'agent_required', 'Mention or select at least one agent')
    }
    const title = optionalString(body.title)
    let result
    if (employeeIds.length === 1) {
      const directInput: DirectConversationInput = {
          workspaceId: world.workspaceId,
          worldId: world.id,
          employeeId: employeeIds[0]!,
          prompt,
          ...(metadata === undefined ? {} : { metadata }),
          ...(runtimePrompt === undefined ? {} : { runtimePrompt }),
      }
      const sessionId = optionalString(body.sessionId)
      if (sessionId !== undefined) directInput.sessionId = sessionId
      if (title !== undefined) directInput.title = title
      result = await orchestrator.direct(directInput)
    } else {
      result = await orchestrator.group({
          workspaceId: world.workspaceId,
          worldId: world.id,
          employeeIds,
          prompt,
          ...(metadata === undefined ? {} : { metadata }),
          ...(runtimePrompt === undefined ? {} : { runtimePrompt }),
          ...(title === undefined ? {} : { title }),
        })
    }
    worldRuntime.publishCurrent(world.id)
    writeJson(response, 200, result)
    return
  }
  const worldLive = match(url.pathname, /^\/api\/worlds\/([^/]+)\/live$/)
  if (method === 'GET' && worldLive !== undefined) {
    if (store.getWorld(worldLive[0]) === undefined) {
      throw new HttpError(404, 'world_not_found', 'World not found')
    }
    runtimeStreamHub.connect(worldLive[0], request, response)
    return
  }

  const sessionMessages = match(url.pathname, /^\/api\/sessions\/([^/]+)\/messages$/)
  if (method === 'GET' && sessionMessages !== undefined) {
    writeJson(response, 200, {
      items: store.listMessages(
        sessionMessages[0],
        nonNegativeInteger(url.searchParams.get('after')),
      ),
    })
    return
  }
  const localAsset = match(url.pathname, /^\/api\/assets\/([^/]+)$/)
  if (method === 'GET' && localAsset !== undefined) {
    const asset = store.getLocalAsset(localAsset[0])
    if (asset === undefined) throw new HttpError(404, 'asset_not_found', 'Asset not found')
    const bytes = await readFile(join(stateRoot, 'assets', asset.relativePath))
    if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256) {
      throw new HttpError(409, 'asset_integrity_failed', 'Local asset integrity check failed')
    }
    writeBinary(response, 200, bytes, asset.mimeType)
    return
  }
  const employeeRevision = match(url.pathname, /^\/api\/employees\/([^/]+)\/revisions$/)
  if (method === 'POST' && employeeRevision !== undefined) {
    const body = await readJson(request)
    const reviseInput: Parameters<SqliteStore['reviseEmployee']>[0] = {
      employeeId: employeeRevision[0],
      reason: requiredString(body, 'reason'),
    }
    const persona = optionalString(body.persona)
    if (persona !== undefined) reviseInput.persona = persona
    if (body.skillGrants !== undefined) reviseInput.skillGrants = optionalStringArray(body.skillGrants)
    if (body.capabilityGrants !== undefined) {
      reviseInput.capabilityGrants = optionalStringArray(body.capabilityGrants)
    }
    const modelPolicy = record(body.modelPolicy)
    if (modelPolicy !== undefined) reviseInput.modelPolicy = modelPolicy as JsonObject
    const revision = store.reviseEmployee(reviseInput)
    writeJson(response, 201, { revision })
    return
  }
  const employeeDossier = match(url.pathname, /^\/api\/employees\/([^/]+)\/dossier$/)
  if (method === 'GET' && employeeDossier !== undefined) {
    writeJson(response, 200, store.getEmployeeDossier(employeeDossier[0]))
    return
  }
  const employeeProfile = match(url.pathname, /^\/api\/employees\/([^/]+)\/profile$/)
  if (method === 'PUT' && employeeProfile !== undefined) {
    const body = await readJson(request)
    const profile = store.reviseEmployeeProfile({
      employeeId: employeeProfile[0],
      ...(body.displayName === undefined ? {} : { displayName: requiredString(body, 'displayName') }),
      ...(body.birthday === undefined ? {} : { birthday: nullableString(body.birthday) }),
      ...(body.background === undefined ? {} : { background: requiredString(body, 'background') }),
      ...(body.personalityTraits === undefined
        ? {}
        : { personalityTraits: optionalStringArray(body.personalityTraits) }),
      ...(record(body.appearance) === undefined ? {} : { appearance: record(body.appearance) as JsonObject }),
      reason: requiredString(body, 'reason'),
    })
    writeJson(response, 201, { profile })
    return
  }
  const employeeEvidence = match(url.pathname, /^\/api\/employees\/([^/]+)\/skill-evidence$/)
  if (method === 'POST' && employeeEvidence !== undefined) {
    const body = await readJson(request)
    const evidence = store.recordSkillEvidence({
      employeeId: employeeEvidence[0],
      skillId: requiredString(body, 'skillId'),
      kind: requiredEnum(body, 'kind', ['task', 'test', 'review', 'artifact', 'training']),
      outcome: requiredEnum(body, 'outcome', ['observed', 'passed', 'failed']),
      summary: requiredString(body, 'summary'),
      sourceEventIds: optionalStringArray(body.sourceEventIds),
      sourceMessageIds: optionalStringArray(body.sourceMessageIds),
      artifactRefs: optionalStringArray(body.artifactRefs),
    })
    writeJson(response, 201, { evidence })
    return
  }
  const employeeSkills = match(url.pathname, /^\/api\/employees\/([^/]+)\/skills$/)
  if (method === 'POST' && employeeSkills !== undefined) {
    const body = await readJson(request)
    const skill = store.reviseEmployeeSkill({
      employeeId: employeeSkills[0],
      skillId: requiredString(body, 'skillId'),
      status: requiredEnum(body, 'status', ['learning', 'verified', 'suspended']),
      evidenceIds: optionalStringArray(body.evidenceIds),
      reason: requiredString(body, 'reason'),
    })
    writeJson(response, 201, { skill })
    return
  }
  const employeeMilestones = match(url.pathname, /^\/api\/employees\/([^/]+)\/milestones$/)
  if (method === 'POST' && employeeMilestones !== undefined) {
    const body = await readJson(request)
    const milestone = store.appendEmployeeMilestone({
      employeeId: employeeMilestones[0],
      category: requiredEnum(body, 'category', [
        'joined', 'task', 'delivery', 'skill', 'review', 'promotion',
        'failure', 'recovery', 'celebration', 'birthday', 'reflection',
      ]),
      title: requiredString(body, 'title'),
      summary: requiredString(body, 'summary'),
      sourceEventIds: optionalStringArray(body.sourceEventIds),
      sourceMessageIds: optionalStringArray(body.sourceMessageIds),
      artifactRefs: optionalStringArray(body.artifactRefs),
      ...(body.occurredAt === undefined ? {} : { occurredAt: requiredString(body, 'occurredAt') }),
    })
    writeJson(response, 201, { milestone })
    return
  }
  const employeeJournals = match(url.pathname, /^\/api\/employees\/([^/]+)\/journals$/)
  if (method === 'POST' && employeeJournals !== undefined) {
    const body = await readJson(request)
    const journal = store.writeEmployeeJournal({
      employeeId: employeeJournals[0],
      localDate: requiredString(body, 'localDate'),
      summary: requiredString(body, 'summary'),
      highlights: optionalStringArray(body.highlights),
      sourceEventIds: optionalStringArray(body.sourceEventIds),
      sourceMessageIds: optionalStringArray(body.sourceMessageIds),
    })
    writeJson(response, 201, { journal })
    return
  }
  const employeeArchive = match(url.pathname, /^\/api\/employees\/([^/]+)\/archive$/)
  if (method === 'POST' && employeeArchive !== undefined) {
    writeJson(response, 200, { employee: store.archiveEmployee(employeeArchive[0]) })
    return
  }

  throw new HttpError(404, 'not_found', 'Route not found')
}

function matchesImageSignature(
  bytes: Buffer,
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp',
): boolean {
  if (mimeType === 'image/png') {
    return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  }
  if (mimeType === 'image/jpeg') {
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  }
  return bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
}

function matchesAttachmentSignature(bytes: Buffer, mimeType: LocalAssetMimeType): boolean {
  if (mimeType === 'image/png' || mimeType === 'image/jpeg' || mimeType === 'image/webp') {
    return matchesImageSignature(bytes, mimeType)
  }
  if (mimeType === 'application/pdf') return bytes.subarray(0, 5).toString('ascii') === '%PDF-'
  const text = bytes.toString('utf8')
  if (text.includes('\0') || text.includes('\uFFFD')) return false
  if (mimeType === 'application/json') {
    try {
      JSON.parse(text)
      return true
    } catch {
      return false
    }
  }
  return true
}

function attachmentExtension(mimeType: LocalAssetMimeType): string {
  return ({
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'text/plain': 'txt',
    'text/markdown': 'md',
    'application/json': 'json',
    'application/pdf': 'pdf',
  } as Record<LocalAssetMimeType, string>)[mimeType]
}

function validatedChatAttachments(
  value: unknown,
  store: SqliteStore,
  workspaceId: string,
): ChatAttachment[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 8) {
    throw new HttpError(422, 'invalid_attachments', 'Attachments must be an array with at most 8 items')
  }
  return value.map((item) => {
    const input = record(item)
    if (input === undefined) throw new HttpError(422, 'invalid_attachment', 'Invalid attachment')
    const assetId = requiredString(input, 'assetId')
    const asset = store.getLocalAsset(assetId)
    if (asset === undefined || asset.workspaceId !== workspaceId || asset.kind !== 'attachment') {
      throw new HttpError(422, 'attachment_unavailable', 'Attachment does not belong to this workspace')
    }
    return {
      assetId: asset.id,
      name: requiredString(input, 'name').slice(0, 180),
      mimeType: asset.mimeType,
      byteLength: asset.byteLength,
      url: `/api/assets/${asset.id}`,
    }
  })
}

function attachmentAwarePrompt(prompt: string, attachments: ChatAttachment[]): string {
  const inventory = attachments
    .map((attachment) => `- ${attachment.name} (${attachment.mimeType}, asset ${attachment.assetId})`)
    .join('\n')
  return `${prompt}\n\n用户随消息附加了以下本地文件：\n${inventory}\n请在回复中明确说明你如何使用这些附件；无法读取内容时不要臆测。`
}

function chatAttachmentJson(attachment: ChatAttachment): JsonObject {
  return {
    assetId: attachment.assetId,
    name: attachment.name,
    mimeType: attachment.mimeType,
    byteLength: attachment.byteLength,
    url: attachment.url,
  }
}

function harnessModelRoute(profile: ModelProfile): HarnessModelRoute {
  const contextWindow = optionalPositiveInteger(profile.settings.contextWindow)
  const maxTokens = optionalPositiveInteger(profile.settings.maxTokens)
  return {
    id: profile.id,
    displayName: profile.displayName,
    api: profile.api,
    baseURL: profile.baseUrl,
    modelId: profile.modelId,
    ...(profile.credentialEnvName === undefined
      ? {}
      : { apiKeyEnv: profile.credentialEnvName }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
  }
}

async function resolveWorkspaceEntry(
  workspaceRoot: string,
  requestedPath: string,
): Promise<{ absolutePath: string; relativePath: string }> {
  const normalized = requestedPath.replaceAll('\\', '/').replace(/^\.\//, '')
  if (
    normalized.includes('\0') ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.split('/').some((part) => part === '..') ||
    workspaceEntryIsHidden(normalized)
  ) {
    throw new HttpError(403, 'workspace_path_rejected', 'Workspace path is not accessible')
  }
  const candidate = resolve(workspaceRoot, ...normalized.split('/').filter(Boolean))
  let absolutePath: string
  try {
    absolutePath = await realpath(candidate)
  } catch (error) {
    if (isMissingFile(error)) throw new HttpError(404, 'workspace_entry_not_found', 'Workspace entry not found')
    throw error
  }
  if (!pathIsInside(workspaceRoot, absolutePath)) {
    throw new HttpError(403, 'workspace_path_rejected', 'Workspace path escapes the configured root')
  }
  const relativePath = relative(workspaceRoot, absolutePath).split(sep).join('/')
  if (workspaceEntryIsHidden(relativePath)) {
    throw new HttpError(403, 'workspace_path_rejected', 'Workspace path is not accessible')
  }
  return { absolutePath, relativePath }
}

function pathIsInside(root: string, target: string): boolean {
  const normalizeCase = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value
  const normalizedRoot = normalizeCase(resolve(root))
  const normalizedTarget = normalizeCase(resolve(target))
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}${sep}`)
}

function workspaceEntryIsHidden(relativePath: string): boolean {
  if (!relativePath) return false
  const segments = relativePath.replaceAll('\\', '/').split('/').filter(Boolean)
  const hiddenDirectories = new Set(['node_modules', 'dist', 'coverage', '.git', '.ssh'])
  const sensitiveFiles = new Set(['credentials.json', 'secrets.json', 'id_rsa', 'id_ed25519'])
  return segments.some((segment) => {
    const lower = segment.toLowerCase()
    return segment.startsWith('.') || hiddenDirectories.has(lower) || sensitiveFiles.has(lower)
  })
}

function workspacePreviewKind(fileName: string): { kind: 'text' | 'image'; contentType: string } | undefined {
  const extension = extname(fileName).toLowerCase()
  const images: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
  }
  const imageType = images[extension]
  if (imageType !== undefined) return { kind: 'image', contentType: imageType }
  const textExtensions = new Set([
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.txt',
    '.css', '.scss', '.html', '.yaml', '.yml', '.toml', '.sql', '.py', '.rs',
    '.go', '.java', '.kt', '.swift', '.sh', '.ps1', '.bat', '.cmd', '.xml',
    '.svg', '.csv',
  ])
  return textExtensions.has(extension)
    ? { kind: 'text', contentType: 'text/plain; charset=utf-8' }
    : undefined
}

function artifactTimestamp(): string {
  return new Date().toISOString().replaceAll(/[:.]/g, '-').replace('T', '_').replace('Z', '')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function mentionedEmployeeIds(
  prompt: string,
  employees: Array<{ id: string; displayName: string }>,
): string[] {
  return employees
    .filter((employee) => prompt.includes(`@${employee.displayName}`))
    .sort((left, right) => prompt.indexOf(`@${left.displayName}`) - prompt.indexOf(`@${right.displayName}`))
    .map((employee) => employee.id)
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolvePromise()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    server.close((error) => (error === undefined ? resolvePromise() : reject(error)))
  })
}

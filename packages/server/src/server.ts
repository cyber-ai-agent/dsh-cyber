import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import { mkdir, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { BUILTIN_BLUEPRINTS } from '@dsh-cyber/catalog'
import type { AgentRuntimePort, ModelProfile } from '@dsh-cyber/contracts'
import {
  HarnessModelRouter,
  inspectHarnessCandidate,
  inspectHarnessCompatibility,
  readActiveHarnessRuntime,
  resolveCandidateDshBin,
  type HarnessModelRoute,
} from '@dsh-cyber/harness-adapter'
import { ConversationOrchestrator } from '@dsh-cyber/orchestration'
import {
  LocalPackageCatalog,
  LocalPackageRuntime,
  PackageManager,
  type PackageRuntimePort,
} from '@dsh-cyber/package-runtime'
import { SqliteStore } from '@dsh-cyber/persistence'

import { HttpError, writeError } from './http/errors.js'
import { optionalPositiveInteger } from './http/request.js'
import { Router } from './http/router.js'
import { assertLocalRequest, isLoopbackHost } from './http/security.js'
import { serveWebAsset } from './http/static-files.js'
import { registerAssetRoutes } from './routes/asset-routes.js'
import { registerCatalogRoutes } from './routes/catalog-routes.js'
import { registerConversationRoutes } from './routes/conversation-routes.js'
import { registerEmployeeRoutes } from './routes/employee-routes.js'
import { registerModelRoutes } from './routes/model-routes.js'
import { registerPackageRoutes } from './routes/package-routes.js'
import { registerSystemRoutes } from './routes/system-routes.js'
import { registerWorkspaceFileRoutes } from './routes/workspace-file-routes.js'
import { registerWorkspaceRoutes } from './routes/workspace-routes.js'
import { registerWorldRuntimeRoutes } from './routes/world-runtime-routes.js'
import { registerWorldRoutes } from './routes/world-routes.js'
import { RuntimeStreamHub } from './streams/runtime-stream-hub.js'
import { WorldStreamHub } from './streams/world-stream-hub.js'
import { WorldRuntimeService } from './world-runtime-service.js'

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
  if (!isLoopbackHost(host)) throw new Error('Phase 1 server only supports loopback hosts')
  const port = options.port ?? DEFAULT_PORT
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error(`Invalid port: ${port}`)

  const stateRoot = resolve(options.stateRoot)
  const workspaceRoot = await realpath(resolve(options.workspacePath))
  const webRoot = resolve(options.webRoot ?? fileURLToPath(new URL('../../web/dist', import.meta.url)))
  await mkdir(join(stateRoot, 'data'), { recursive: true })

  const runtimeStateRoot = join(stateRoot, 'runtime')
  const compatibility = await inspectHarnessCompatibility(join(runtimeStateRoot, 'harness-home'))
  if (!compatibility.ok) {
    throw new Error(`Harness compatibility check failed: ${compatibility.errors.join('; ')}`)
  }

  const store = await SqliteStore.open(join(stateRoot, 'data', 'dsh-cyber.sqlite'))
  for (const blueprint of BUILTIN_BLUEPRINTS) store.saveBlueprint(blueprint)

  const activeDshBinPath = await resolveActiveRuntime(store, runtimeStateRoot, stateRoot)
  const runtime = options.runtime ?? new HarnessModelRouter({
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
  const orchestrator = new ConversationOrchestrator({ store, runtime, workspacePath: workspaceRoot })
  const packageManager = new PackageManager({
    store,
    runtime: options.packageRuntime ?? new LocalPackageRuntime(join(stateRoot, 'packages')),
  })
  const packageCatalog = new LocalPackageCatalog(
    options.marketplaceRoot ?? fileURLToPath(new URL('../../../marketplace', import.meta.url)),
  )
  const runtimeStreamHub = new RuntimeStreamHub()
  const worldStreamHub = new WorldStreamHub()
  const worldRuntime = new WorldRuntimeService({ store, publish: (event) => worldStreamHub.publish(event) })

  const router = new Router()
  registerSystemRoutes(router, { store, stateRoot, workspaceRoot })
  registerWorkspaceFileRoutes(router, { workspaceRoot })
  registerCatalogRoutes(router, { store, packageCatalog })
  registerWorkspaceRoutes(router, { store })
  registerModelRoutes(router, { store })
  registerAssetRoutes(router, { store, stateRoot })
  registerWorldRoutes(router, { store })
  registerPackageRoutes(router, { store, packageManager, packageCatalog })
  registerWorldRuntimeRoutes(router, { store, worldRuntime, worldStreamHub })
  registerConversationRoutes(router, { store, orchestrator, runtimeStreamHub, worldRuntime })
  registerEmployeeRoutes(router, { store })

  const httpServer = createServer((request, response) => {
    void dispatchHttpRequest(router, webRoot, request, response)
      .catch((error: unknown) => writeError(response, error))
  })
  httpServer.requestTimeout = 0
  httpServer.headersTimeout = 10_000
  httpServer.keepAliveTimeout = 5_000

  const unsubscribe = orchestrator.subscribe((event) => {
    runtimeStreamHub.publish(event)
    worldRuntime.publishRuntime(event.worldId, event.event, event.agentId)
  })
  let startedAddress: CyberServerAddress | undefined
  let closed = false

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
      startedAddress = { host, port: address.port, origin: `http://${host}:${address.port}` }
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

async function dispatchHttpRequest(
  router: Router,
  webRoot: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  assertLocalRequest(request)
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  if ((request.method ?? 'GET') === 'GET' && !url.pathname.startsWith('/api/')) {
    if (await serveWebAsset(response, webRoot, url.pathname)) return
  }
  if (await router.dispatch(request, response)) return
  throw new HttpError(404, 'not_found', 'Route not found')
}

async function resolveActiveRuntime(
  store: SqliteStore,
  runtimeStateRoot: string,
  stateRoot: string,
): Promise<string | undefined> {
  const activeRuntime = await readActiveHarnessRuntime(runtimeStateRoot)
  if (activeRuntime === undefined) return undefined
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
  return resolveCandidateDshBin(activeRuntime.candidateRoot)
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
    ...(profile.credentialEnvName === undefined ? {} : { apiKeyEnv: profile.credentialEnvName }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
  }
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

import { createServer } from 'node:http'
import { mkdir, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { BUILTIN_BLUEPRINTS } from '@dsh-cyber/catalog'
import type { AgentRuntimePort, AgentTurnRequest } from '@dsh-cyber/contracts'
import {
  HarnessModelRouter,
  inspectHarnessCandidate,
  inspectHarnessCompatibility,
  readActiveHarnessRuntime,
  resolveCandidateDshBin,
  type HarnessModelRoute,
} from '@dsh-cyber/harness-adapter'
import { ConversationOrchestrator } from '@dsh-cyber/orchestration'
import { LocalPackageCatalog, LocalPackageRuntime, PackageManager, type PackageRuntimePort } from '@dsh-cyber/package-runtime'
import { SqliteStore, WorldSimulationStore } from '@dsh-cyber/persistence'

import { dispatchHttpRequest } from './http/context.js'
import { writeError } from './http/errors.js'
import { Router } from './http/router.js'
import { isLoopbackHost } from './http/security.js'
import { closeServer, listenBrowserSafe } from './http/server-lifecycle.js'
import { registerAmbientLifeRoutes } from './routes/ambient-life-routes.js'
import { registerAssetRoutes } from './routes/asset-routes.js'
import { registerCatalogRoutes } from './routes/catalog-routes.js'
import { registerConversationRoutes } from './routes/conversation-routes.js'
import { registerEmployeeRoutes } from './routes/employee-routes.js'
import { registerIntegrationRoutes } from './routes/integration-routes.js'
import { registerModelInteractionRoutes } from './routes/model-interaction-routes.js'
import { registerModelRoutes } from './routes/model-routes.js'
import { registerPackageRoutes } from './routes/package-routes.js'
import { registerSystemRoutes } from './routes/system-routes.js'
import { registerTaskScheduleRoutes } from './routes/task-schedule-routes.js'
import { registerWorkspaceFileRoutes } from './routes/workspace-file-routes.js'
import { registerWorkspaceRoutes } from './routes/workspace-routes.js'
import { registerWorldRuntimeRoutes } from './routes/world-runtime-routes.js'
import { registerWorldTraceRoutes } from './routes/world-trace-routes.js'
import { registerWorldRoutes } from './routes/world-routes.js'
import { registerWorldSettingsRoutes } from './routes/world-settings-routes.js'
import { AmbientLifeExecutor } from './services/ambient-life-executor.js'
import { AmbientLifeRuntime } from './services/ambient-life-runtime.js'
import { AmbientLifeScheduler } from './services/ambient-life-scheduler.js'
import { AmbientLifeSettingsService } from './services/ambient-life-settings-service.js'
import { AssetService } from './services/asset-service.js'
import { CharacterProfileRuntime } from './services/character-profile-runtime.js'
import { CharacterSkillRuntime } from './services/character-skill-runtime.js'
import { EmployeeActivityProjectionService } from './services/employee-activity-projection-service.js'
import { harnessModelRoute } from './services/harness-model-route.js'
import { ModelCatalogService } from './services/model-catalog-service.js'
import { ModelCredentialService } from './services/model-credential-service.js'
import { ModelInteractionService, TurnInteractionLoggingRuntime } from './services/model-interaction-service.js'
import { PeerCollaborationService } from './services/peer-collaboration-service.js'
import { RoleAwareAmbientLifeService } from './services/role-aware-ambient-life-service.js'
import { RuntimeUpdateService } from './services/runtime-update-service.js'
import { TaskScheduleService } from './services/task-schedule-service.js'
import { WorldAccessService } from './services/world-access-service.js'
import { WorldAmbientSlotResolver } from './services/world-ambient-slot-resolver.js'
import { WorldAmbientStateProvider } from './services/world-ambient-state-provider.js'
import { WorldFileService } from './services/world-file-service.js'
import { WorldRootService } from './services/world-root-service.js'
import { WorldSettingsService } from './services/world-settings-service.js'
import { WorldTraceService } from './services/world-trace-service.js'
import { WorldMarketplaceService } from './services/world-marketplace-service.js'
import { WorldPackageInstanceService } from './services/world-package-instance-service.js'
import { createBuiltinSkillRegistry } from './skills/builtin-skill-registry.js'
import { LocalSkillActionRepository } from './skills/local-skill-action-repository.js'
import { SqliteSkillActionRepository } from './skills/sqlite-skill-action-repository.js'
import type { CharacterSkillActionRepository } from './skills/skill-action-repository.js'
import type { CharacterSkillAdapterRegistry } from './skills/skill-adapter.js'
import { RuntimeStreamHub } from './streams/runtime-stream-hub.js'
import { WorldStreamHub } from './streams/world-stream-hub.js'
import { validateStagedPackageEntrypoints } from './installed-package-runtime.js'
import { WorldRuntimeService } from './world-runtime-service.js'
import { createBuiltinIntegrationRegistry } from './integrations/builtin-integration-registry.js'
import { IntegrationService } from './integrations/integration-service.js'
import { OfficialMcpClientFactory, type McpClientFactory } from './integrations/mcp-client.js'
import { MCP_INTEGRATION_ID } from './integrations/mcp-provider.js'
import { McpSkillAdapter } from './skills/mcp-skill-adapter.js'

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
  skillRegistry?: CharacterSkillAdapterRegistry
  skillActionRepository?: CharacterSkillActionRepository
  marketplaceRoot?: string
  bootstrapDefaultWorld?: boolean
  mcpClientFactory?: McpClientFactory
}

export interface CyberServerAddress { host: string; port: number; origin: string }
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
  if (!compatibility.ok) throw new Error(`Harness compatibility check failed: ${compatibility.errors.join('; ')}`)

  const store = await SqliteStore.open(join(stateRoot, 'data', 'dsh-cyber.sqlite'))
  store.recoverConversationRuntimeAfterRestart()
  // Built-in blueprint identities are immutable once persisted. Older local
  // states may already contain the same id/version from a previous release;
  // keep that durable source record and only seed genuinely missing versions.
  // Any changed built-in definition must ship with a higher blueprint version.
  for (const blueprint of BUILTIN_BLUEPRINTS) {
    if (store.getBlueprint(blueprint.id, blueprint.version) === undefined) store.saveBlueprint(blueprint)
  }
  if (options.bootstrapDefaultWorld === true && store.listWorkspaces().length === 0) {
    const local = store.createWorkspace({ name: '本地实例' })
    const world = store.createWorld({ workspaceId: local.id, name: '我的世界', templateId: 'personal-world' })
    store.recruitEmployee({ workspaceId: local.id, worldId: world.id, blueprintId: 'core.butler', blueprintVersion: 1, displayName: '管家' })
  }
  const worldSimulation = new WorldSimulationStore(store)

  const worldRoots = new WorldRootService(stateRoot)
  await Promise.all(store.listWorkspaces().flatMap((workspace) => store.listWorlds(workspace.id, true).map((world) => worldRoots.ensure(world.id))))
  const worldSettings = new WorldSettingsService(worldRoots)
  const ambientLifeSettings = new AmbientLifeSettingsService(store)
  const worldAccess = new WorldAccessService(worldRoots)
  const credentials = await ModelCredentialService.open(stateRoot)
  const modelCatalog = new ModelCatalogService(credentials)
  const worldPackages = new WorldPackageInstanceService(store, worldRoots)
  const mcpClients = options.mcpClientFactory ?? new OfficialMcpClientFactory()
  const integrations = await IntegrationService.open(stateRoot, createBuiltinIntegrationRegistry(mcpClients))
  const skillRegistry = options.skillRegistry ?? createBuiltinSkillRegistry({
    firecrawl: {
      store,
      integrations,
      listWorldPackages: (worldId) => worldPackages.listRuntimePackages(worldId),
    },
  })
  const mcpAdapter = options.skillRegistry === undefined ? new McpSkillAdapter({ store, integrations, clients: mcpClients }) : undefined
  if (mcpAdapter !== undefined) {
    skillRegistry.register(mcpAdapter)
    await refreshMcpCatalog(mcpAdapter, skillRegistry)
  }

  const activeDshBinPath = await resolveActiveRuntime(store, runtimeStateRoot, stateRoot)
  const interactions = new ModelInteractionService(store)
  const baseRuntime = options.runtime ?? new HarnessModelRouter({
    stateRoot: runtimeStateRoot,
    ...(activeDshBinPath === undefined ? {} : { dshBinPath: activeDshBinPath }),
    resolveRoute(request) { return resolveHarnessRoute(store, request) },
  })
  const profileRuntime = new CharacterProfileRuntime(baseRuntime, store, skillRegistry)
  const runtime = new TurnInteractionLoggingRuntime({
    inner: profileRuntime,
    service: interactions,
    resolveRoute(request) { return resolveHarnessRoute(store, request) },
  })
  const orchestrator = new ConversationOrchestrator({
    store,
    runtime,
    workspacePath: workspaceRoot,
    resolveWorldRoot: async (worldId) => (await worldRoots.ensure(worldId)).filesPath,
  })
  const peerCollaboration = new PeerCollaborationService({
    store,
    simulationStore: worldSimulation,
    orchestrator,
  })
  const packageManager = new PackageManager({
    store,
    runtime: options.packageRuntime ?? new LocalPackageRuntime(join(stateRoot, 'packages')),
    validateStaged: validateStagedPackageEntrypoints,
  })
  const packageCatalog = new LocalPackageCatalog(options.marketplaceRoot ?? fileURLToPath(new URL('../../../marketplace', import.meta.url)))
  const runtimeStreamHub = new RuntimeStreamHub()
  const worldStreamHub = new WorldStreamHub()
  const worldRuntime = new WorldRuntimeService({
    store,
    simulationStore: worldSimulation,
    worldPackages,
    publish: (event) => {
      worldStreamHub.publish(event)
      runtimeStreamHub.publishWorld(event)
    },
  })
  const worldMarketplace = new WorldMarketplaceService(store, worldRuntime, worldPackages)
  const ambientSlotResolver = new WorldAmbientSlotResolver({ store })
  const ambientStateProvider = new WorldAmbientStateProvider({
    store,
    simulationStore: worldSimulation,
    resolveSlots: (worldId) => ambientSlotResolver.resolve(worldId),
  })
  const ambientLifeService = new RoleAwareAmbientLifeService({
    stateProvider: ambientStateProvider,
    persistence: worldSimulation,
  })
  const ambientLifeRuntime = new AmbientLifeRuntime({
    service: ambientLifeService,
    executor: new AmbientLifeExecutor({ store, simulationStore: worldSimulation }),
    publish: (worldId) => worldRuntime.publishCurrent(worldId),
  })
  const ambientLifeScheduler = new AmbientLifeScheduler({
    settings: ambientLifeSettings,
    service: ambientLifeRuntime,
  })
  let skillActions = options.skillActionRepository
  if (skillActions === undefined) {
    const sqliteActions = new SqliteSkillActionRepository(store)
    const legacyActions = new LocalSkillActionRepository(join(stateRoot, 'skills', 'actions.json'))
    for (const workspace of store.listWorkspaces()) {
      for (const world of store.listWorlds(workspace.id, true)) {
        for (const action of await legacyActions.listByWorld(world.id)) {
          await sqliteActions.reserve(action, 0)
        }
      }
    }
    store.recoverSkillActionsAfterRestart()
    skillActions = sqliteActions
  }
  const skillRuntime = new CharacterSkillRuntime(store, {
    registry: skillRegistry,
    actions: skillActions,
  })
  const worldTrace = new WorldTraceService({ store, actions: skillActions })
  const employeeActivity = new EmployeeActivityProjectionService(store)
  employeeActivity.projectAll()
  const taskSchedules = new TaskScheduleService({ store, orchestrator, settings: worldSettings, employeeActivity })
  const runtimeUpdates = new RuntimeUpdateService(store, stateRoot, workspaceRoot)
  const assets = new AssetService(store, stateRoot)
  const worldFiles = new WorldFileService(worldRoots)

  const router = new Router()
  registerSystemRoutes(router, { store, stateRoot, runtimeUpdates })
  registerWorkspaceFileRoutes(router, { worldFiles, access: worldAccess })
  registerCatalogRoutes(router, { store, packageCatalog, worldPackages })
  registerWorkspaceRoutes(router, { store })
  registerModelRoutes(router, { store, credentials, modelCatalog, interactions })
  registerIntegrationRoutes(router, {
    store,
    integrations,
    onChanged: async (integrationId) => {
      if (integrationId === MCP_INTEGRATION_ID && mcpAdapter !== undefined) await refreshMcpCatalog(mcpAdapter, skillRegistry)
    },
  })
  registerAmbientLifeRoutes(router, { store, settings: ambientLifeSettings, access: worldAccess })
  registerAssetRoutes(router, { store, assets, access: worldAccess })
  registerWorldRoutes(router, { store, worldAccess, worldPackages })
  registerWorldSettingsRoutes(router, { store, settings: worldSettings, access: worldAccess })
  registerTaskScheduleRoutes(router, { store, schedules: taskSchedules, access: worldAccess })
  registerPackageRoutes(router, { store, packageManager, packageCatalog, skillRuntime, worldMarketplace, worldPackages, worldAccess })
  registerWorldRuntimeRoutes(router, { store, worldRuntime, worldStreamHub, worldAccess })
  registerWorldTraceRoutes(router, { store, trace: worldTrace, access: worldAccess })
  registerModelInteractionRoutes(router, { store, interactions })
  registerConversationRoutes(router, { store, orchestrator, peerCollaboration, skillRuntime, runtimeStreamHub, worldRuntime, worldAccess, worldFiles, worldSettings, worldTrace, employeeActivity, worldPackages })
  registerEmployeeRoutes(router, { store, worldAccess })

  const httpServer = createServer((request, response) => {
    void dispatchHttpRequest(router, webRoot, request, response).catch((error: unknown) => writeError(response, error))
  })
  httpServer.requestTimeout = 0
  httpServer.headersTimeout = 10_000
  httpServer.keepAliveTimeout = 5_000

  const unsubscribe = orchestrator.subscribe((event) => {
    runtimeStreamHub.publish(event)
    runtimeStreamHub.publishTrace(event.worldId, worldTrace.adaptRuntime(event))
    worldRuntime.publishRuntime(event.worldId, event.event, event.agentId, event.sessionId)
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
      const address = await listenBrowserSafe(httpServer, port, host)
      startedAddress = { host, port: address.port, origin: `http://${host}:${address.port}` }
      ambientLifeScheduler.start()
      taskSchedules.start()
      skillRuntime.start()
      return startedAddress
    },
    address() { return startedAddress },
    async close() {
      if (closed) return
      closed = true
      skillRuntime.close()
      await taskSchedules.close()
      await ambientLifeScheduler.close()
      unsubscribe()
      runtimeStreamHub.close()
      worldStreamHub.close()
      if (httpServer.listening) await closeServer(httpServer)
      await orchestrator.close()
      credentials.close()
      integrations.close()
      store.close()
    },
  }
}

async function refreshMcpCatalog(adapter: McpSkillAdapter, registry: CharacterSkillAdapterRegistry): Promise<void> {
  try { await adapter.refresh() } catch { adapter.clear() }
  registry.refresh(adapter)
}

async function resolveActiveRuntime(store: SqliteStore, runtimeStateRoot: string, stateRoot: string): Promise<string | undefined> {
  const activeRuntime = await readActiveHarnessRuntime(runtimeStateRoot)
  if (activeRuntime === undefined) return undefined
  const activeReport = await inspectHarnessCandidate({ candidateRoot: activeRuntime.candidateRoot, stateRoot: runtimeStateRoot })
  if (!activeReport.ok || activeReport.version !== activeRuntime.version) {
    store.close()
    throw new Error(`Activated Harness runtime is unavailable or incompatible. Run "dsh-cyber runtime-rollback --data-dir ${stateRoot}" to recover.`)
  }
  return resolveCandidateDshBin(activeRuntime.candidateRoot)
}

function resolveHarnessRoute(store: SqliteStore, request: AgentTurnRequest): HarnessModelRoute | undefined {
  const profile = store.resolveModelProfile(request.agent.workspaceId, request.agent.worldId, request.agent.id)
  return profile === undefined ? undefined : harnessModelRoute(profile, request.reasoningEffort)
}

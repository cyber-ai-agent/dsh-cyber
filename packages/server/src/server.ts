import { createServer } from 'node:http'
import { mkdir, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { BUILTIN_BLUEPRINTS } from '@dsh-cyber/catalog'
import type { JsonObject, AgentRuntimePort, AgentTurnRequest } from '@dsh-cyber/contracts'
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
import { assertApplicationAccess } from './http/application-access-guard.js'
import { writeError } from './http/errors.js'
import { Router } from './http/router.js'
import { isLoopbackHost } from './http/security.js'
import { closeServer, listenBrowserSafe } from './http/server-lifecycle.js'
import { registerAmbientLifeRoutes } from './routes/ambient-life-routes.js'
import { registerApplicationAccessRoutes } from './routes/application-access-routes.js'
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
import { registerWorldAuthorityRoutes } from './routes/world-authority-routes.js'
import { registerWorldRoutes } from './routes/world-routes.js'
import { registerWorldSettingsRoutes } from './routes/world-settings-routes.js'
import { AmbientLifeExecutor } from './services/ambient-life-executor.js'
import { AmbientLifeRuntime } from './services/ambient-life-runtime.js'
import { AmbientLifeScheduler } from './services/ambient-life-scheduler.js'
import { AmbientLifeSettingsService } from './services/ambient-life-settings-service.js'
import { AssetService } from './services/asset-service.js'
import { ApplicationAccessService } from './services/application-access-service.js'
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
import { ApplicationUpdateService } from './services/application-update-service.js'
import { TaskScheduleService } from './services/task-schedule-service.js'
import { TurnAwareApprovalContinuationService } from './services/turn-aware-approval-continuation-service.js'
import { WorldAccessService } from './services/world-access-service.js'
import { WorldAmbientSlotResolver } from './services/world-ambient-slot-resolver.js'
import { WorldAmbientStateProvider } from './services/world-ambient-state-provider.js'
import { WorldFileService } from './services/world-file-service.js'
import { WorldRootService } from './services/world-root-service.js'
import { WorldSettingsService } from './services/world-settings-service.js'
import { WorldTraceService } from './services/world-trace-service.js'
import { WorldMarketplaceService } from './services/world-marketplace-service.js'
import { WorldPackageInstanceService } from './services/world-package-instance-service.js'
import { WorldCharacterAuthorityService } from './services/world-character-authority-service.js'
import { WorldPermissionRequestService } from './services/world-permission-request-service.js'
import { WorldAuthorityBackfillService } from './services/world-authority-backfill-service.js'
import { OwnerRuntimeAccessService } from './services/owner-runtime-access-service.js'
import { WorldRuntimePermissionResolver } from './services/world-runtime-permission-resolver.js'
import { createBuiltinSkillRegistry } from './skills/builtin-skill-registry.js'
import { LocalSkillActionRepository } from './skills/local-skill-action-repository.js'
import { SqliteSkillActionRepository } from './skills/sqlite-skill-action-repository.js'
import type { CharacterSkillActionRepository } from './skills/skill-action-repository.js'
import type { CharacterSkillAdapterRegistry } from './skills/skill-adapter.js'
import { createWorldManagementHost } from './skills/world-management-host.js'
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
  const authority = new WorldCharacterAuthorityService(store)
  const authorityBackfill = new WorldAuthorityBackfillService({
    authority: {
      get: authority.get.bind(authority),
      hasPermission: authority.hasPermission.bind(authority),
      updateAuthority: authority.updateAuthority.bind(authority),
      listWorlds: (workspaceId) => store.listWorlds(workspaceId),
      listEmployees: (worldId) => store.listEmployees(worldId),
      listAuthorityChanges: (worldId, employeeId) => authority.listChanges(worldId, employeeId),
    },
    roots: worldRoots,
  })
  await authorityBackfill.run(store.listWorkspaces().map((workspace) => workspace.id))
  // The runtime service is constructed later, so the publisher is resolved
  // lazily. Decisions announce a change rather than the client polling a
  // snapshot that fires once per streamed token.
  let publishDecisionChanged: ((worldId: string, payload: JsonObject) => void) | undefined
  const worldPermissions = new WorldPermissionRequestService({
    store,
    authority,
    onDecisionChanged: (worldId, payload) => publishDecisionChanged?.(worldId, payload),
  })
  const ownerRuntimeAccess = new OwnerRuntimeAccessService()
  const worldRuntimePermissions = new WorldRuntimePermissionResolver({
    roots: worldRoots,
    authority,
    worldPermissions,
  })
  const mcpClients = options.mcpClientFactory ?? new OfficialMcpClientFactory()
  const integrations = await IntegrationService.open(stateRoot, createBuiltinIntegrationRegistry(mcpClients))

  const worldManagementHost = createWorldManagementHost({ store, worldSettings, worldPackages, authority })

  const skillRegistry = options.skillRegistry ?? createBuiltinSkillRegistry({
    firecrawl: {
      store,
      integrations,
      listWorldPackages: (worldId) => worldPackages.listRuntimePackages(worldId),
    },
    worldManagement: worldManagementHost,
  })
  const mcpAdapter = options.skillRegistry === undefined ? new McpSkillAdapter({ store, integrations, clients: mcpClients }) : undefined
  if (mcpAdapter !== undefined) skillRegistry.register(mcpAdapter)

  const activeDshBinPath = await resolveActiveRuntime(store, runtimeStateRoot, stateRoot)
  const interactions = new ModelInteractionService(store)
  const baseRuntime = options.runtime ?? new HarnessModelRouter({
    stateRoot: runtimeStateRoot,
    ...(activeDshBinPath === undefined ? {} : { dshBinPath: activeDshBinPath }),
    resolveRoute(request) { return resolveHarnessRoute(store, request) },
  })
  const profileRuntime = new CharacterProfileRuntime(baseRuntime, store, skillRegistry, authority)
  const runtime = new TurnInteractionLoggingRuntime({
    inner: profileRuntime,
    service: interactions,
    resolveRoute(request) { return resolveHarnessRoute(store, request) },
  })
  const orchestrator = new ConversationOrchestrator({
    store,
    runtime,
    workspacePath: workspaceRoot,
    // Per character, not per world: a character without world.files.read runs
    // in an empty host-managed workspace so the permission actually means
    // something at runtime.
    resolveWorldRoot: async (worldId, employeeId) =>
      (await worldRuntimePermissions.resolve({ worldId, employeeId })).workspacePath,
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
  publishDecisionChanged = (worldId, payload) => worldRuntime.publishDecisionChanged(worldId, payload)
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
    // A corrupt legacy ledger must not stop a local-first application from
    // starting; the SQLite ledger is authoritative and already loaded.
    try {
      const legacyActions = new LocalSkillActionRepository(join(stateRoot, 'skills', 'actions.json'))
      for (const workspace of store.listWorkspaces()) {
        for (const world of store.listWorlds(workspace.id, true)) {
          for (const action of await legacyActions.listByWorld(world.id)) {
            await sqliteActions.reserve(action, 0)
          }
        }
      }
    } catch (error) {
      console.warn('[dsh-cyber] 旧版 skills/actions.json 无法读取，已跳过迁移：', errorText(error))
    }
    store.recoverSkillActionsAfterRestart()
    skillActions = sqliteActions
  }
  const skillRuntime = new CharacterSkillRuntime(store, {
    registry: skillRegistry,
    actions: skillActions,
    worldPermissions,
  })
  const turnContinuations = new TurnAwareApprovalContinuationService({
    store,
    orchestrator,
    skills: skillRuntime,
    settings: worldSettings,
    worldPackages,
    worldPermissions,
  })
  const worldTrace = new WorldTraceService({ store, actions: skillActions })
  const employeeActivity = new EmployeeActivityProjectionService(store)
  employeeActivity.projectAll()
  const taskSchedules = new TaskScheduleService({ store, orchestrator, settings: worldSettings, employeeActivity })
  const runtimeUpdates = new RuntimeUpdateService(store, stateRoot, workspaceRoot)
  const applicationUpdates = new ApplicationUpdateService(store, stateRoot, workspaceRoot)
  const applicationAccess = new ApplicationAccessService(stateRoot)
  const assets = new AssetService(store, stateRoot)
  const worldFiles = new WorldFileService(worldRoots)

  const router = new Router()
  registerApplicationAccessRoutes(router, applicationAccess)
  registerSystemRoutes(router, { store, stateRoot, runtimeUpdates, applicationUpdates })
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
  registerWorldRoutes(router, { store, worldAccess, worldPackages, authority })
  registerWorldAuthorityRoutes(router, { store, worldAccess, authority, worldPermissions, skillRuntime, turnContinuations , ownerRuntimeAccess })
  registerWorldSettingsRoutes(router, { store, settings: worldSettings, access: worldAccess })
  registerTaskScheduleRoutes(router, { store, schedules: taskSchedules, access: worldAccess })
  registerPackageRoutes(router, { store, packageManager, packageCatalog, skillRuntime, worldMarketplace, worldPackages, worldAccess })
  registerWorldRuntimeRoutes(router, { store, worldRuntime, worldStreamHub, worldAccess })
  registerWorldTraceRoutes(router, { store, trace: worldTrace, access: worldAccess })
  registerModelInteractionRoutes(router, { store, interactions })
  registerConversationRoutes(router, { store, orchestrator, peerCollaboration, skillRuntime, turnContinuations, runtimeStreamHub, worldRuntime, worldAccess, worldFiles, worldSettings, worldTrace, employeeActivity, worldPackages, worldRuntimePermissions, ownerRuntimeAccess })
  registerEmployeeRoutes(router, { store, worldAccess, authority })

  const httpServer = createServer((request, response) => {
    void (async () => {
      await assertApplicationAccess(applicationAccess, request)
      await dispatchHttpRequest(router, webRoot, request, response)
    })().catch((error: unknown) => writeError(response, error))
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
      // Neither of these may gate the listener. MCP discovery talks to
      // user-configured endpoints that can black-hole, and continuation runs
      // live model turns that fail when a provider is down or a credential is
      // stale. A local-first application must still start — and must still be
      // reachable so the user can open Settings and fix the cause.
      if (mcpAdapter !== undefined) {
        void refreshMcpCatalog(mcpAdapter, skillRegistry)
      }
      void sweepOrphanedPackageStaging(store, worldPackages).catch((error: unknown) => {
        console.warn('[dsh-cyber] 清理残留的包暂存目录失败：', errorText(error))
      })
      void turnContinuations.recover().catch((error: unknown) => {
        console.warn('[dsh-cyber] 恢复等待审批的回合失败，已跳过：', errorText(error))
      })
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

/** MCP servers are user-configured endpoints; discovery is best-effort. */
const MCP_DISCOVERY_TIMEOUT_MS = 5_000

async function refreshMcpCatalog(adapter: McpSkillAdapter, registry: CharacterSkillAdapterRegistry): Promise<void> {
  try {
    await withTimeout(adapter.refresh(), MCP_DISCOVERY_TIMEOUT_MS)
  } catch (error) {
    // A stalled or hostile endpoint must not hold the process, and a catalog
    // that could not be read stays empty rather than stale.
    adapter.clear()
    console.warn('[dsh-cyber] MCP 工具目录刷新失败，本次保持为空：', errorText(error))
  }
  registry.refresh(adapter)
}

function withTimeout<TValue>(work: Promise<TValue>, milliseconds: number): Promise<TValue> {
  return new Promise<TValue>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error(`操作超过 ${milliseconds} 毫秒未完成`)), milliseconds)
    timer.unref?.()
    work.then(resolvePromise, rejectPromise).finally(() => clearTimeout(timer))
  })
}

/** Crash residue from `instantiate`; safe to remove because nothing reads it. */
async function sweepOrphanedPackageStaging(store: SqliteStore, worldPackages: WorldPackageInstanceService): Promise<void> {
  let removed = 0
  for (const workspace of store.listWorkspaces()) {
    for (const world of store.listWorlds(workspace.id, true)) {
      removed += await worldPackages.sweepOrphanedStaging(world.id)
    }
  }
  if (removed > 0) console.warn(`[dsh-cyber] 已清理 ${removed} 个残留的包暂存目录。`)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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

import {
  Buildings,
  CaretDown,
  Check,
  Compass,
  Cube,
  GearSix,
  Pulse,
  SidebarSimple,
  Storefront,
} from '@phosphor-icons/react'
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type {
  AgentRuntimeEvent,
  AgentPermissionMode,
  ChatAttachment,
  CyberMarketKind,
  CyberMarketPackage,
  CyberPackageManifest,
  EmployeeBlueprint,
  EmployeeDossier,
  EmployeeInstance,
  EmployeeRevision,
  InstalledPackage,
  JsonObject,
  LocalAssetMimeType,
  ModelAssignment,
  ModelInteractionLog,
  ModelInteractionLogFilter,
  ModelInteractionLogPage,
  ModelProfile,
  PackageInstallTransaction,
  PackagePermissionPreview,
  RuntimeUpdateTransaction,
  TaskSchedule,
  WorkMessage,
  WorkSession,
  WorkSessionParticipant,
  Workspace,
  WorkspacePreferences,
  WorkspaceSnapshot,
  World,
  WorldAccessSummary,
  WorldSettings,
  ReasoningEffort,
  WorldSnapshot,
} from '@dsh-cyber/contracts'

import { ApiError, api } from './api.js'
import { ArtifactDock } from './components/ArtifactDock.js'
import { ChatWorkbench } from './components/ChatWorkbench.js'
import { CreativeWorkshopLauncher } from './components/CreativeWorkshopLauncher.js'
import { EmployeeManagementDialog } from './components/EmployeeManagementDialog.js'
import { GroupConversationDialog } from './components/GroupConversationDialog.js'
import { NavigationPane } from './components/NavigationPane.js'
import { PackageMarketDialog } from './components/PackageMarketDialog.js'
import { RecruitmentDialog } from './components/RecruitmentDialog.js'
import { ResizableShell } from './components/ResizableShell.js'
import {
  SettingsDialog,
  type DiscoveredModel,
  type ModelDiscoveryDraft,
  type ModelProfileSaveDraft,
  type SettingsSection,
  type SystemAction,
  type SystemActionInput,
  type SystemActionResult,
} from './components/SettingsDialog.js'
import { demoData, demoTavernDossiers, demoTavernEmployees, demoTavernMessages, demoTavernSessions } from './demo-data.js'
import type { ConversationIntent, CyberEmployee, DockTab, SessionParticipantMap } from './types.js'
import { worldExperience } from './world-experience.js'
import { WorldRuntimeDock } from './features/world/WorldRuntimeDock.js'
import { WorldTracePanel } from './components/world-trace/WorldTracePanel.js'
import { WorldSettingsDialog, WorldUnlockDialog } from './components/WorldSettingsDialog.js'
import { TaskSchedulePanel } from './components/TaskSchedulePanel.js'

const demoMode = new URLSearchParams(window.location.search).get('demo') === '1'
const worldRuntimeV2Enabled = new URLSearchParams(window.location.search).get('legacyWorld') !== '1'
type AppMode = 'world' | 'workbench'

interface ChatResult {
  session: WorkSession
}

interface RuntimeEnvelope {
  workspaceId: string
  worldId: string
  sessionId: string
  agentId: string
  event: AgentRuntimeEvent
}

export default function App() {
  const [workspace, setWorkspace] = useState<Workspace | undefined>(demoMode ? demoData.workspace : undefined)
  const [worlds, setWorlds] = useState<World[]>(demoMode ? demoData.worlds : [])
  const [activeWorld, setActiveWorld] = useState<World | undefined>(demoMode ? demoData.activeWorld : undefined)
  const [employees, setEmployees] = useState<CyberEmployee[]>(demoMode ? demoData.employees : [])
  const [sessions, setSessions] = useState<WorkSession[]>(demoMode ? demoData.sessions : [])
  const [activeSessionId, setActiveSessionId] = useState<string | undefined>(demoMode ? demoData.sessions[0]?.id : undefined)
  const [sessionParticipants, setSessionParticipants] = useState<SessionParticipantMap>(() => demoMode ? inferDemoSessionParticipants(demoData.sessions, demoData.messages, demoData.employees) : {})
  const [conversationIntent, setConversationIntent] = useState<ConversationIntent>()
  const [messages, setMessages] = useState<WorkMessage[]>(demoMode ? demoData.messages : [])
  const [preferences, setPreferences] = useState<WorkspacePreferences | undefined>(demoMode ? demoData.preferences : undefined)
  const [models, setModels] = useState<ModelProfile[]>(demoMode ? demoData.modelProfiles : [])
  const [modelAssignments, setModelAssignments] = useState<ModelAssignment[]>([])
  const [dossiers, setDossiers] = useState<Record<string, EmployeeDossier>>(demoMode ? demoData.dossiers : {})
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string | undefined>()
  const [dockTab, setDockTab] = useState<DockTab>('world')
  const [dockCollapsed, setDockCollapsed] = useState(false)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('appearance')
  const [savingSettings, setSavingSettings] = useState(false)
  const [recruitmentOpen, setRecruitmentOpen] = useState(false)
  const [groupDialogOpen, setGroupDialogOpen] = useState(false)
  const [packageMarketOpen, setPackageMarketOpen] = useState(false)
  const [packageMarketKind, setPackageMarketKind] = useState<CyberMarketKind>('plugin')
  const [marketplaceItems, setMarketplaceItems] = useState<CyberMarketPackage[]>([])
  const [installedPackages, setInstalledPackages] = useState<InstalledPackage[]>([])
  const [packageTransactions, setPackageTransactions] = useState<PackageInstallTransaction[]>([])
  const [packageLoading, setPackageLoading] = useState(false)
  const [packageInstalling, setPackageInstalling] = useState(false)
  const [blueprints, setBlueprints] = useState<EmployeeBlueprint[]>([])
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [recruiting, setRecruiting] = useState(false)
  const [managingEmployeeId, setManagingEmployeeId] = useState<string>()
  const [savingEmployee, setSavingEmployee] = useState(false)
  const [loading, setLoading] = useState(!demoMode)
  const [error, setError] = useState<string | undefined>()
  const [appMode, setAppMode] = useState<AppMode>(worldRuntimeV2Enabled ? 'world' : 'workbench')
  const [worldRuntimeAvailable, setWorldRuntimeAvailable] = useState(demoMode)
  const [worldRuntimeRevision, setWorldRuntimeRevision] = useState(0)
  const [worldSettingsOpen, setWorldSettingsOpen] = useState(false)
  const [worldSettings, setWorldSettings] = useState<WorldSettings>()
  const [worldAccess, setWorldAccess] = useState<WorldAccessSummary>()
  const [lockedWorld, setLockedWorld] = useState<World>()
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>('auto')
  const [permissionMode, setPermissionMode] = useState<AgentPermissionMode>('read-only')
  const [taskSchedules, setTaskSchedules] = useState<TaskSchedule[]>([])
  const [scheduleBusy, setScheduleBusy] = useState(false)

  const activeSession = sessions.find((session) => session.id === activeSessionId)
  const activeParticipantIds = conversationIntent?.employeeIds
    ?? (activeSessionId === undefined ? [] : sessionParticipants[activeSessionId] ?? [])
  const experience = activeWorld === undefined ? undefined : worldExperience(activeWorld)
  const selectedEmployee = employees.find((employee) => employee.id === selectedEmployeeId)
  const managingEmployee = employees.find((employee) => employee.id === managingEmployeeId)
  const managingDossier = managingEmployeeId === undefined ? undefined : dossiers[managingEmployeeId]
  const managingRevision = managingDossier?.revisions.find((revision) => revision.revision === managingEmployee?.currentRevision)
  const supportsWorldRuntime = worldRuntimeV2Enabled && worldRuntimeAvailable

  const loadWorld = useCallback(async (world: World) => {
    setError(undefined)
    setActiveWorld(world)
    setActiveSessionId(undefined)
    setSessionParticipants({})
    setConversationIntent(undefined)
    setMessages([])
    setDraft('')
    setSelectedEmployeeId(undefined)
    setDockTab('world')
    setPermissionMode('read-only')
    setTaskSchedules([])
    if (demoMode) {
      const isCompany = world.id === demoData.activeWorld.id
      setWorldRuntimeAvailable(true)
      setAppMode(worldRuntimeV2Enabled ? 'world' : 'workbench')
      const nextEmployees = isCompany ? demoData.employees : demoTavernEmployees
      const nextSessions = isCompany ? demoData.sessions : demoTavernSessions
      const nextMessages = isCompany ? demoData.messages : demoTavernMessages
      setEmployees(nextEmployees)
      setSessions(nextSessions)
      setMessages(nextMessages)
      setSessionParticipants(inferDemoSessionParticipants(nextSessions, nextMessages, nextEmployees))
      setDossiers(isCompany ? demoData.dossiers : demoTavernDossiers)
      setActiveSessionId(nextSessions[0]?.id)
      return
    }
    let snapshot: WorldSnapshot
    try { snapshot = await api<WorldSnapshot>(`/api/worlds/${world.id}/snapshot`) } catch (cause) { if (cause instanceof ApiError && cause.status === 423) { setLockedWorld(world); return } throw cause }
    const capability = await api<{ supported: boolean }>(`/api/worlds/${world.id}/runtime-capability`)
    const settingsResult = await api<{ settings: WorldSettings; access: WorldAccessSummary }>(`/api/worlds/${world.id}/settings`)
    setWorldSettings(settingsResult.settings)
    applyWorldAppearance(settingsResult.settings)
    setWorldAccess(settingsResult.access)
    setReasoningEffort(settingsResult.settings.model.reasoningEffort)
    setPermissionMode(settingsResult.settings.runtime.permissionMode)
    setWorldRuntimeAvailable(capability.supported)
    setAppMode(worldRuntimeV2Enabled && capability.supported ? 'world' : 'workbench')
    const [dossierResults, participantResults, scheduleResult] = await Promise.all([
      Promise.all(snapshot.employees.map(async (employee) => {
      try {
        return await api<EmployeeDossier>(`/api/employees/${employee.id}/dossier`)
      } catch {
        return undefined
      }
      })),
      Promise.all(snapshot.openSessions.map(async (session) => {
        try {
          const result = await api<{ items: WorkSessionParticipant[] }>(`/api/sessions/${session.id}/participants`)
          return [session.id, result.items.filter((participant) => participant.kind === 'employee').map((participant) => participant.participantId)] as const
        } catch {
          return [session.id, []] as const
        }
      })),
      api<{ items: TaskSchedule[] }>(`/api/worlds/${world.id}/schedules`),
    ])
    const nextDossiers: Record<string, EmployeeDossier> = {}
    for (const dossier of dossierResults) {
      if (dossier !== undefined) nextDossiers[dossier.employee.id] = dossier
    }
    setDossiers(nextDossiers)
    setEmployees(snapshot.employees.map((employee, index) => toCyberEmployee(employee, index, nextDossiers[employee.id])))
    setSessions(snapshot.openSessions)
    setSessionParticipants(Object.fromEntries(participantResults))
    setTaskSchedules(scheduleResult.items)
  }, [])

  const openWorkshopWorld = useCallback(async (worldId: string) => {
    if (workspace === undefined || demoMode) return
    const snapshot = await api<WorkspaceSnapshot>(`/api/workspaces/${workspace.id}/snapshot`)
    setWorlds(snapshot.worlds)
    const target = snapshot.worlds.find((world) => world.id === worldId)
    if (target === undefined) throw new Error('创意工坊对应的世界不存在或已归档')
    await loadWorld(target)
  }, [loadWorld, workspace])

  const bindWorldTheme = useCallback(async (packageId: string) => {
    if (activeWorld === undefined) throw new Error('世界尚未就绪')
    if (demoMode) {
      setWorldRuntimeAvailable(true)
      setAppMode('world')
      setWorldRuntimeRevision((value) => value + 1)
      return
    }
    await api(`/api/worlds/${encodeURIComponent(activeWorld.id)}/theme-binding`, {
      method: 'PUT',
      body: JSON.stringify({ action: 'bind', packageId }),
    })
    setWorldRuntimeAvailable(true)
    setAppMode('world')
    setWorldRuntimeRevision((value) => value + 1)
  }, [activeWorld])

  useEffect(() => {
    if (demoMode) return
    let cancelled = false
    void (async () => {
      try {
        const result = await api<{ items: Workspace[] }>('/api/workspaces')
        if (cancelled || result.items.length === 0) return
        const first = result.items[0]!
        const [snapshot, preferenceResult, modelResult] = await Promise.all([
          api<WorkspaceSnapshot>(`/api/workspaces/${first.id}/snapshot`),
          api<{ preferences: WorkspacePreferences }>(`/api/workspaces/${first.id}/preferences`),
          api<{ items: ModelProfile[]; assignments: ModelAssignment[] }>(`/api/workspaces/${first.id}/model-profiles`),
        ])
        if (cancelled) return
        setWorkspace(first)
        setWorlds(snapshot.worlds)
        setPreferences(preferenceResult.preferences)
        setModels(modelResult.items)
        setModelAssignments(modelResult.assignments)
        if (snapshot.worlds[0] !== undefined) await loadWorld(snapshot.worlds[0])
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : '无法连接本地 DSH Cyber 服务')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [loadWorld])

  useEffect(() => {
    if (demoMode || activeSessionId === undefined) return
    let cancelled = false
    void api<{ items: WorkMessage[] }>(`/api/sessions/${activeSessionId}/messages`)
      .then((result) => {
        if (cancelled) return
        setMessages(result.items)
        const participantIds = participantIdsFromMessages(result.items)
        if (participantIds.length > 0) {
          setSessionParticipants((current) => ({ ...current, [activeSessionId]: participantIds }))
        }
      })
      .catch((cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : '会话加载失败') })
    return () => { cancelled = true }
  }, [activeSessionId])

  useEffect(() => {
    if (demoMode || activeWorld === undefined) return
    const stream = new EventSource(`/api/worlds/${encodeURIComponent(activeWorld.id)}/live`)
    const onRuntime = (raw: Event) => {
      const message = raw as MessageEvent<string>
      try {
        const envelope = JSON.parse(message.data) as RuntimeEnvelope
        if (envelope.worldId !== activeWorld.id) return
        const status = runtimeEmployeeStatus(envelope.event)
        if (status !== undefined) {
          setEmployees((current) => current.map((employee) => employee.id === envelope.agentId
            ? { ...employee, status, currentActivity: runtimeActivity(envelope.event, employee.role) }
            : employee))
        }
      } catch {
        // Ignore malformed transient data; the durable transcript remains authoritative.
      }
    }
    stream.addEventListener('runtime', onRuntime)
    return () => {
      stream.removeEventListener('runtime', onRuntime)
      stream.close()
    }
  }, [activeWorld])

  useEffect(() => {
    const root = document.documentElement
    const scheme = preferences?.colorScheme ?? 'dark'
    root.dataset.colorScheme = scheme
    root.dataset.skin = preferences?.skinId ?? 'cyber-graphite'
    root.dataset.density = preferences?.interfaceDensity ?? 'compact'
    root.dataset.motion = preferences?.motion ?? 'system'
  }, [preferences])

  const openDossier = useCallback(async (employeeId: string) => {
    setSelectedEmployeeId(employeeId)
    setAppMode('workbench')
    setDockCollapsed(false)
    setDockTab('dossier')
    if (demoMode) return
    try {
      const dossier = await api<EmployeeDossier>(`/api/employees/${employeeId}/dossier`)
      setDossiers((current) => ({ ...current, [employeeId]: dossier }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '角色档案加载失败')
    }
  }, [demoMode])

  const directEmployee = useCallback((employee: CyberEmployee) => {
    const existing = sessions.find((session) => session.kind === 'direct' && (
      sessionParticipants[session.id]?.includes(employee.id) === true ||
      (sessionParticipants[session.id]?.length ?? 0) === 0 && session.title.includes(employee.displayName)
    ))
    setActiveSessionId(existing?.id)
    setConversationIntent(existing === undefined ? {
      kind: 'direct',
      employeeIds: [employee.id],
      title: `与 ${employee.displayName} 对话`,
    } : undefined)
    if (existing === undefined) setMessages([])
    setDraft('')
    setSelectedEmployeeId(employee.id)
  }, [sessionParticipants, sessions])

  const createGroupIntent = useCallback((input: { title: string; employeeIds: string[] }) => {
    const selected = employees.filter((employee) => input.employeeIds.includes(employee.id))
    if (selected.length < 2) return
    setGroupDialogOpen(false)
    setActiveSessionId(undefined)
    setMessages([])
    setDraft('')
    setConversationIntent({
      kind: 'group',
      employeeIds: selected.map((employee) => employee.id),
      title: input.title.trim() || selected.map((employee) => employee.displayName).join('、'),
    })
    setSelectedEmployeeId(selected[0]?.id)
  }, [employees])

  const openRecruitment = useCallback(async () => {
    if (activeWorld === undefined) return
    setRecruitmentOpen(true)
    setCatalogLoading(true)
    setError(undefined)
    try {
      const result = await api<{ items: EmployeeBlueprint[] }>(`/api/catalog/blueprints?templateId=${encodeURIComponent(activeWorld.templateId)}&workspaceId=${encodeURIComponent(activeWorld.workspaceId)}`)
      setBlueprints(result.items)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '角色市场加载失败')
    } finally {
      setCatalogLoading(false)
    }
  }, [activeWorld])

  const loadPackages = useCallback(async () => {
    if (workspace === undefined || demoMode) return
    const result = await api<{ items: InstalledPackage[]; transactions: PackageInstallTransaction[] }>(`/api/workspaces/${workspace.id}/packages`)
    setInstalledPackages(result.items)
    setPackageTransactions(result.transactions)
  }, [demoMode, workspace])

  const searchMarketplace = useCallback(async (market: CyberMarketKind, query = '') => {
    if (workspace === undefined) return
    const result = await api<{ items: CyberMarketPackage[] }>(`/api/marketplace?market=${market}&workspaceId=${encodeURIComponent(workspace.id)}&q=${encodeURIComponent(query)}`)
    setMarketplaceItems(result.items)
  }, [workspace])

  const openPackageMarket = useCallback(async (market: CyberMarketKind = 'plugin') => {
    setPackageMarketKind(market)
    setPackageMarketOpen(true)
    setPackageLoading(true)
    setError(undefined)
    try {
      await Promise.all([loadPackages(), searchMarketplace(market)])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '软件包清单加载失败')
    } finally {
      setPackageLoading(false)
    }
  }, [loadPackages, searchMarketplace])

  const previewPackage = useCallback(async (manifest: CyberPackageManifest): Promise<PackagePermissionPreview> => {
    if (workspace === undefined) throw new Error('工作区尚未就绪')
    if (demoMode) {
      const active = installedPackages.find((item) => item.packageId === manifest.id)
      const previous = new Set(active?.capabilities ?? [])
      return {
        workspaceId: workspace.id,
        packageId: manifest.id,
        version: manifest.version,
        capabilities: [...new Set(manifest.capabilities)].sort(),
        addedCapabilities: [...new Set(manifest.capabilities)].filter((item) => !previous.has(item)).sort(),
        removedCapabilities: [...previous].filter((item) => !manifest.capabilities.includes(item)).sort(),
        dataEgress: [...new Set(manifest.dataEgress)].sort(),
        ...(active === undefined ? {} : { previousVersion: active.version }),
        approvalToken: `demo-${manifest.id}-${manifest.version}`,
        approvalExpiresAt: new Date(Date.now() + 5 * 60 * 1_000).toISOString(),
      }
    }
    return api<PackagePermissionPreview>(`/api/workspaces/${workspace.id}/packages/preview`, {
      method: 'POST',
      body: JSON.stringify({ manifest }),
    })
  }, [installedPackages, workspace])

  const installPackage = useCallback(async (input: { manifest: CyberPackageManifest; sourceDirectory: string; approvalToken: string }) => {
    if (workspace === undefined) throw new Error('工作区尚未就绪')
    setPackageInstalling(true)
    try {
      if (demoMode) {
        const timestamp = new Date().toISOString()
        setInstalledPackages((current) => [...current.filter((item) => item.packageId !== input.manifest.id), {
          workspaceId: workspace.id,
          packageId: input.manifest.id,
          version: input.manifest.version,
          kind: input.manifest.kind,
          status: 'active',
          installedPath: `demo/${input.manifest.id}`,
          capabilities: input.manifest.capabilities,
          manifest: input.manifest,
          installedAt: timestamp,
          updatedAt: timestamp,
        }])
      } else {
        await api(`/api/workspaces/${workspace.id}/packages/install`, {
          method: 'POST',
          body: JSON.stringify(input),
        })
        await loadPackages()
      }
    } finally {
      setPackageInstalling(false)
    }
  }, [loadPackages, workspace])

  const previewMarketplacePackage = useCallback(async (item: CyberMarketPackage): Promise<PackagePermissionPreview> => {
    if (workspace === undefined) throw new Error('工作区尚未就绪')
    if (demoMode) return previewPackage(item.manifest)
    const result = await api<{ preview: PackagePermissionPreview }>(`/api/workspaces/${workspace.id}/marketplace/preview`, {
      method: 'POST',
      body: JSON.stringify({ packageId: item.manifest.id, version: item.manifest.version }),
    })
    return result.preview
  }, [previewPackage, workspace])

  const installMarketplacePackage = useCallback(async (item: CyberMarketPackage, approvalToken: string) => {
    if (workspace === undefined) throw new Error('工作区尚未就绪')
    setPackageInstalling(true)
    try {
      if (demoMode) {
        await installPackage({ manifest: item.manifest, sourceDirectory: item.sourceDirectory, approvalToken })
        const timestamp = new Date().toISOString()
        setMarketplaceItems((current) => current.map((candidate) => candidate.manifest.id === item.manifest.id
          ? { ...candidate, installedVersion: item.manifest.version }
          : candidate))
        setPackageTransactions((current) => [{
          id: `demo-market-${item.manifest.id}-${Date.now()}`,
          workspaceId: workspace.id,
          packageId: item.manifest.id,
          version: item.manifest.version,
          status: 'activated',
          approvedCapabilities: item.manifest.capabilities,
          createdAt: timestamp,
          updatedAt: timestamp,
        }, ...current])
      } else {
        await api(`/api/workspaces/${workspace.id}/marketplace/install`, {
          method: 'POST',
          body: JSON.stringify({ packageId: item.manifest.id, version: item.manifest.version, approvalToken }),
        })
        await Promise.all([loadPackages(), searchMarketplace(item.market)])
      }
    } finally {
      setPackageInstalling(false)
    }
  }, [installPackage, loadPackages, searchMarketplace, workspace])

  const recruitEmployee = useCallback(async (
    blueprint: EmployeeBlueprint,
    displayName: string | undefined,
    capabilityGrants: string[],
  ) => {
    if (activeWorld === undefined) return
    setRecruiting(true)
    setError(undefined)
    try {
      let employee: EmployeeInstance
      if (demoMode) {
        const timestamp = new Date().toISOString()
        employee = {
          id: `demo-recruit-${Date.now()}`,
          workspaceId: activeWorld.workspaceId,
          worldId: activeWorld.id,
          blueprintId: blueprint.id,
          blueprintVersion: blueprint.version,
          displayName: displayName ?? blueprint.displayName,
          role: blueprint.role,
          status: 'available',
          currentRevision: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
        }
      } else {
        const result = await api<{ employee: EmployeeInstance }>(`/api/worlds/${activeWorld.id}/recruit`, {
          method: 'POST',
          body: JSON.stringify({
            blueprintId: blueprint.id,
            blueprintVersion: blueprint.version,
            capabilityGrants,
            ...(displayName === undefined ? {} : { displayName }),
          }),
        })
        employee = result.employee
      }
      const mapped = toCyberEmployee(employee, employees.length)
      setEmployees((current) => [...current, mapped])
      setRecruitmentOpen(false)
      setActiveSessionId(undefined)
      setConversationIntent({
        kind: 'direct',
        employeeIds: [employee.id],
        title: `与 ${employee.displayName} 对话`,
      })
      setDraft('')
      setSelectedEmployeeId(employee.id)
      setAppMode('world')
      setDockTab('world')
      setDockCollapsed(false)
      if (!demoMode) {
        const dossier = await api<EmployeeDossier>(`/api/employees/${employee.id}/dossier`)
        setDossiers((current) => ({ ...current, [employee.id]: dossier }))
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '招聘失败')
    } finally {
      setRecruiting(false)
    }
  }, [activeWorld, employees.length])

  const reviseEmployee = useCallback(async (input: { reason: string; persona?: string; skillGrants?: string[]; capabilityGrants?: string[]; modelPolicy: { modelProfileId?: string } }) => {
    if (managingEmployee === undefined) return
    setSavingEmployee(true)
    setError(undefined)
    try {
      let revision: EmployeeRevision
      if (demoMode) {
        const previous = dossiers[managingEmployee.id]?.revisions.find((item) => item.revision === managingEmployee.currentRevision)
        revision = {
          employeeId: managingEmployee.id,
          revision: managingEmployee.currentRevision + 1,
          persona: input.persona ?? previous?.persona ?? '',
          skillGrants: input.skillGrants ?? previous?.skillGrants ?? [],
          capabilityGrants: input.capabilityGrants ?? previous?.capabilityGrants ?? [],
          modelPolicy: input.modelPolicy,
          reason: input.reason,
          createdAt: new Date().toISOString(),
        }
      } else {
        const result = await api<{ revision: EmployeeRevision }>(`/api/employees/${managingEmployee.id}/revisions`, {
          method: 'POST',
          body: JSON.stringify(input),
        })
        revision = result.revision
      }
      setEmployees((current) => current.map((employee) => employee.id === managingEmployee.id
        ? { ...employee, currentRevision: revision.revision, updatedAt: revision.createdAt }
        : employee))
      if (!demoMode) {
        const dossier = await api<EmployeeDossier>(`/api/employees/${managingEmployee.id}/dossier`)
        setDossiers((current) => ({ ...current, [managingEmployee.id]: dossier }))
      } else {
        setDossiers((current) => {
          const dossier = current[managingEmployee.id]
          return dossier === undefined ? current : { ...current, [managingEmployee.id]: { ...dossier, employee: { ...dossier.employee, currentRevision: revision.revision }, revisions: [...dossier.revisions, revision] } }
        })
      }
      setManagingEmployeeId(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '角色版本更新失败')
    } finally {
      setSavingEmployee(false)
    }
  }, [dossiers, managingEmployee])

  const updateEmployeeProfile = useCallback(async (input: {
    displayName: string
    role: string
    avatarIndex: number
    background: string
    personalityTraits: string[]
    relationshipToUser: string
    addressUserAs: string
    selfReference: string
  }) => {
    if (managingEmployee === undefined) return
    setSavingEmployee(true)
    setError(undefined)
    try {
      const previous = dossiers[managingEmployee.id]?.profile
      const appearance = {
        ...(previous?.appearance ?? {}),
        avatarIndex: input.avatarIndex,
        worldSkinIndex: input.avatarIndex,
        relationshipToUser: input.relationshipToUser,
        addressUserAs: input.addressUserAs,
        selfReference: input.selfReference,
      }
      let profile = previous
      if (demoMode) {
        profile = {
          employeeId: managingEmployee.id,
          revision: (previous?.revision ?? 0) + 1,
          background: input.background,
          personalityTraits: input.personalityTraits,
          appearance,
          reason: '更新角色资料与关系设定',
          createdAt: new Date().toISOString(),
          ...(previous?.birthday === undefined ? {} : { birthday: previous.birthday }),
        }
      } else {
        const result = await api<{ profile: EmployeeDossier['profile'] }>('/api/employees/' + managingEmployee.id + '/profile', {
          method: 'PUT',
          body: JSON.stringify({
            displayName: input.displayName,
            role: input.role,
            background: input.background,
            personalityTraits: input.personalityTraits,
            appearance,
            reason: '更新角色资料与关系设定',
          }),
        })
        profile = result.profile
      }
      const updatedAt = profile?.createdAt ?? new Date().toISOString()
      setEmployees((current) => current.map((employee) => employee.id === managingEmployee.id
        ? { ...employee, displayName: input.displayName, role: input.role, avatarIndex: input.avatarIndex, updatedAt }
        : employee))
      setDossiers((current) => {
        const dossier = current[managingEmployee.id]
        return dossier === undefined
          ? current
          : { ...current, [managingEmployee.id]: { ...dossier, employee: { ...dossier.employee, displayName: input.displayName, role: input.role, updatedAt }, ...(profile === undefined ? {} : { profile }) } }
      })
      setWorldRuntimeRevision((value) => value + 1)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '角色资料保存失败')
    } finally {
      setSavingEmployee(false)
    }
  }, [dossiers, managingEmployee])

  const archiveEmployee = useCallback(async () => {
    if (managingEmployee === undefined) return
    setSavingEmployee(true)
    setError(undefined)
    try {
      if (!demoMode) {
        await api(`/api/employees/${managingEmployee.id}/archive`, { method: 'POST', body: '{}' })
      }
      setEmployees((current) => current.filter((employee) => employee.id !== managingEmployee.id))
      setDossiers((current) => {
        const next = { ...current }
        delete next[managingEmployee.id]
        return next
      })
      if (selectedEmployeeId === managingEmployee.id) {
        setSelectedEmployeeId(undefined)
        setDockTab('world')
      }
      setManagingEmployeeId(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '角色归档失败')
    } finally {
      setSavingEmployee(false)
    }
  }, [managingEmployee, selectedEmployeeId])

  const selectSession = useCallback((sessionId: string) => {
    setConversationIntent(undefined)
    setActiveSessionId(sessionId)
    setDraft('')
    setSelectedEmployeeId(sessionParticipants[sessionId]?.[0])
    if (demoMode) {
      setMessages(sessionId === demoData.sessions[0]?.id
        ? demoData.messages
        : sessionId === demoTavernSessions[0]?.id ? demoTavernMessages : [])
    }
  }, [sessionParticipants])

  const send = useCallback(async (prompt: string, attachments: ChatAttachment[]) => {
    if (activeWorld === undefined) return
    setSending(true)
    // 乐观更新：点击发送瞬间立即清空输入框，不等模型回合结束
    setDraft('')
    setError(undefined)
    try {
      const explicitEmployeeIds = conversationIntent?.employeeIds
        ?? (activeSessionId === undefined ? [] : sessionParticipants[activeSessionId] ?? [])
      const mentioned = employees.filter((employee) => prompt.includes(`@${employee.displayName}`))
      const targetIds = explicitEmployeeIds.length > 0 ? explicitEmployeeIds : mentioned.map((employee) => employee.id)
      if (demoMode) {
        const targets = targetIds.length > 0
          ? targetIds.map((id) => employees.find((employee) => employee.id === id)).filter((employee): employee is CyberEmployee => employee !== undefined)
          : employees.slice(0, 1)
        const session = activeSession ?? makeDemoSession(
          activeWorld,
          prompt,
          targets.length > 1 ? 'group' : 'direct',
          conversationIntent?.title,
        )
        const ownerMessage = makeDemoMessage(
          session.id,
          messages.length + 1,
          'owner',
          'owner',
          'user',
          prompt,
          {
            participantIds: targets.map((employee) => employee.id),
            ...(attachments.length === 0 ? {} : { attachments: serializableAttachments(attachments) }),
          },
        )
        setSessions((current) => current.some((item) => item.id === session.id) ? current : [session, ...current])
        setActiveSessionId(session.id)
        setSessionParticipants((current) => ({ ...current, [session.id]: targets.map((employee) => employee.id) }))
        setConversationIntent(undefined)
        setMessages((current) => [...current, ownerMessage])
        await delay(650)
        const replies = targets.map((employee, index) => makeDemoMessage(
          session.id,
          messages.length + index + 2,
          employee.id,
          'employee',
          'assistant',
          worldExperience(activeWorld).kind === 'tavern'
            ? tavernDemoReply(employee, prompt)
            : `${employee.displayName}收到。我会以${employee.role}的职责独立处理“${compactPrompt(prompt)}”，完成后给出证据、产物和下一步。`,
        ))
        setMessages((current) => [...current, ...replies])
        return
      }
      // 乐观更新：用户消息立即上屏，不依赖 chat 响应返回
      const ownerMessage: WorkMessage = {
        id: `local-owner-${Date.now()}`,
        sessionId: activeSessionId ?? `pending-${Date.now()}`,
        sequence: messages.length + 1,
        senderId: 'owner',
        senderKind: 'owner',
        kind: 'user',
        content: prompt,
        metadata: {
          displayTime: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
          participantIds: targetIds,
          ...(attachments.length === 0 ? {} : { attachments: serializableAttachments(attachments) }),
        },
        createdAt: new Date().toISOString(),
      }
      setMessages((current) => [...current, ownerMessage])
      const result = await api<ChatResult>(`/api/worlds/${activeWorld.id}/chat`, {
        method: 'POST',
        body: JSON.stringify({
          prompt,
          reasoningEffort,
          permissionMode,
          interactionKind: conversationIntent?.kind === 'group' || targetIds.length > 1
            ? 'meeting'
            : /(?:^|\s)任务[：:]/.test(prompt) ? 'task' : 'chat',
          ...(attachments.length === 0 ? {} : { attachments }),
          ...(targetIds.length === 0 ? {} : { employeeIds: targetIds }),
          ...(conversationIntent === undefined ? {} : { title: conversationIntent.title }),
          ...(activeSessionId === undefined ? {} : { sessionId: activeSessionId }),
        }),
      })
      setActiveSessionId(result.session.id)
      setSessionParticipants((current) => ({ ...current, [result.session.id]: targetIds }))
      setConversationIntent(undefined)
      setSessions((current) => [result.session, ...current.filter((item) => item.id !== result.session.id)])
      const transcript = await api<{ items: WorkMessage[] }>(`/api/sessions/${result.session.id}/messages`)
      setMessages(transcript.items)
    } catch (cause) {
      // The orchestrator persists the owner's message before starting the model
      // turn. Keep that conversational fact visible even when execution fails;
      // the failure itself is explained by the toast and World Trace.
      setError(cause instanceof Error ? cause.message : '消息发送失败')
    } finally {
      setSending(false)
    }
  }, [activeSession, activeSessionId, activeWorld, conversationIntent, employees, messages.length, sessionParticipants, reasoningEffort, permissionMode])

  const refreshTaskSchedules = useCallback(async () => {
    if (activeWorld === undefined || demoMode) return
    const result = await api<{ items: TaskSchedule[] }>(`/api/worlds/${activeWorld.id}/schedules`)
    setTaskSchedules(result.items)
  }, [activeWorld])

  const createTaskSchedule = useCallback(async (input: { employeeId: string; title: string; prompt: string; kind: 'once' | 'interval'; scheduledAt: string; everySeconds?: number; permissionMode: 'read-only' | 'workspace-write' }) => {
    if (activeWorld === undefined) return
    setScheduleBusy(true); setError(undefined)
    try {
      const result = await api<{ item: TaskSchedule }>(`/api/worlds/${activeWorld.id}/schedules`, { method: 'POST', body: JSON.stringify(input) })
      setTaskSchedules((current) => [result.item, ...current])
    } catch (cause) { setError(cause instanceof Error ? cause.message : '计划创建失败'); throw cause }
    finally { setScheduleBusy(false) }
  }, [activeWorld])

  const updateTaskScheduleStatus = useCallback(async (item: TaskSchedule, status: 'active' | 'paused') => {
    if (activeWorld === undefined) return
    setScheduleBusy(true); setError(undefined)
    try {
      const result = await api<{ item: TaskSchedule }>(`/api/worlds/${activeWorld.id}/schedules/${item.id}`, { method: 'PATCH', body: JSON.stringify({ status }) })
      setTaskSchedules((current) => current.map((value) => value.id === item.id ? result.item : value))
    } catch (cause) { setError(cause instanceof Error ? cause.message : '计划更新失败') }
    finally { setScheduleBusy(false) }
  }, [activeWorld])

  const runTaskSchedule = useCallback(async (item: TaskSchedule) => {
    if (activeWorld === undefined) return
    setScheduleBusy(true); setError(undefined)
    try {
      const result = await api<{ run: { status: string; errorCode?: string } }>(`/api/worlds/${activeWorld.id}/schedules/${item.id}/run`, { method: 'POST', body: '{}' })
      if (result.run.status === 'failed') setError(`计划执行失败：${scheduleErrorLabel(result.run.errorCode)}`)
      await refreshTaskSchedules()
    } catch (cause) { setError(cause instanceof Error ? cause.message : '计划执行失败') }
    finally { setScheduleBusy(false) }
  }, [activeWorld, refreshTaskSchedules])

  const deleteTaskSchedule = useCallback(async (item: TaskSchedule) => {
    if (activeWorld === undefined) return
    setScheduleBusy(true); setError(undefined)
    try {
      await api(`/api/worlds/${activeWorld.id}/schedules/${item.id}`, { method: 'DELETE' })
      setTaskSchedules((current) => current.filter((value) => value.id !== item.id))
    } catch (cause) { setError(cause instanceof Error ? cause.message : '计划删除失败') }
    finally { setScheduleBusy(false) }
  }, [activeWorld])

  const uploadChatAttachment = useCallback(async (file: File): Promise<ChatAttachment> => {
    if (workspace === undefined) throw new Error('请先创建工作区')
    const mimeType = attachmentMimeType(file)
    if (demoMode) {
      return {
        assetId: `demo-attachment-${Date.now()}`,
        name: file.name,
        mimeType,
        byteLength: file.size,
        url: URL.createObjectURL(file),
      }
    }
    const dataBase64 = await fileToBase64(file)
    const result = await api<{ attachment: ChatAttachment }>(`/api/workspaces/${workspace.id}/assets/attachment`, {
      method: 'POST',
      body: JSON.stringify({ name: file.name, mimeType, dataBase64 }),
    })
    return result.attachment
  }, [workspace])

  const savePreferences = useCallback(async (next: WorkspacePreferences) => {
    if (workspace === undefined) return
    setSavingSettings(true)
    try {
      if (demoMode) {
        setPreferences({ ...next, updatedAt: new Date().toISOString() })
      } else {
        const result = await api<{ preferences: WorkspacePreferences }>(`/api/workspaces/${workspace.id}/preferences`, {
          method: 'PUT',
          body: JSON.stringify(next),
        })
        setPreferences(result.preferences)
      }
      setSettingsOpen(false)
    } finally {
      setSavingSettings(false)
    }
  }, [workspace])

  const uploadBackground = useCallback(async (file: File) => {
    if (workspace === undefined) throw new Error('请先创建工作区')
    if (demoMode) return URL.createObjectURL(file)
    const dataBase64 = await fileToBase64(file)
    const result = await api<{ asset: { id: string } }>(`/api/workspaces/${workspace.id}/assets/background`, {
      method: 'POST',
      body: JSON.stringify({ mimeType: file.type, dataBase64 }),
    })
    return `assets/${result.asset.id}`
  }, [workspace])

  const saveModel = useCallback(async (profile: ModelProfileSaveDraft): Promise<ModelProfile> => {
    if (workspace === undefined) throw new Error('请先创建工作区')
    if (demoMode) {
      const timestamp = new Date().toISOString()
      const currentProfile = profile.id ? models.find((item) => item.id === profile.id) : undefined
      const profileData = { ...profile }
      delete profileData.apiKey
      delete profileData.clearCredential
      const saved: ModelProfile = {
        ...profileData,
        id: profile.id ?? `demo-model-${crypto.randomUUID()}`,
        workspaceId: workspace.id,
        createdAt: currentProfile?.createdAt ?? timestamp,
        updatedAt: timestamp,
      }
      setModels((current) => [
        ...current
          .filter((item) => item.id !== saved.id)
          .map((item) => saved.isDefault ? { ...item, isDefault: false } : item),
        saved,
      ])
      return saved
    }
    const result = await api<{ profile: ModelProfile }>(`/api/workspaces/${workspace.id}/model-profiles`, {
      method: 'POST',
      body: JSON.stringify(profile),
    })
    setModels((current) => [
      ...current
        .filter((item) => item.id !== result.profile.id)
        .map((item) => result.profile.isDefault ? { ...item, isDefault: false } : item),
      result.profile,
    ])
    return result.profile
  }, [models, workspace])

  const discoverModels = useCallback(async (input: ModelDiscoveryDraft): Promise<DiscoveredModel[]> => {
    if (workspace === undefined) throw new Error('请先创建工作区')
    if (demoMode) {
      await delay(250)
      return [
        { id: 'qwen3.5' },
        { id: 'qwen3.5:9b' },
        { id: 'deepseek-chat' },
      ]
    }
    const result = await api<{ items: DiscoveredModel[] }>(`/api/workspaces/${workspace.id}/model-profiles/discover`, {
      method: 'POST',
      body: JSON.stringify(input),
    })
    return result.items
  }, [demoMode, workspace])

  const deleteModel = useCallback(async (modelProfileId: string): Promise<void> => {
    if (workspace === undefined) throw new Error('请先创建工作区')
    if (demoMode) {
      setModels((current) => {
        const removed = current.find((item) => item.id === modelProfileId)
        const remaining = current.filter((item) => item.id !== modelProfileId)
        if (removed?.isDefault && remaining[0]) remaining[0] = { ...remaining[0], isDefault: true }
        return remaining
      })
      setModelAssignments((current) => current.filter((item) => item.modelProfileId !== modelProfileId))
      return
    }
    const result = await api<{ removed: boolean; items: ModelProfile[]; assignments: ModelAssignment[] }>(`/api/workspaces/${workspace.id}/model-profiles/${encodeURIComponent(modelProfileId)}`, {
      method: 'DELETE',
    })
    if (!result.removed) throw new Error('模型配置不存在或已被删除')
    setModels(result.items)
    setModelAssignments(result.assignments)
  }, [workspace])

  const assignModel = useCallback(async (input: { scope: ModelAssignment['scope']; scopeId: string; modelProfileId?: string }) => {
    if (workspace === undefined) return
    if (demoMode) {
      setModelAssignments((current) => {
        const remaining = current.filter((item) => item.scope !== input.scope || item.scopeId !== input.scopeId)
        return input.modelProfileId === undefined ? remaining : [...remaining, { ...input, modelProfileId: input.modelProfileId, workspaceId: workspace.id, updatedAt: new Date().toISOString() }]
      })
      return
    }
    const endpoint = `/api/workspaces/${workspace.id}/model-assignments/${input.scope}/${encodeURIComponent(input.scopeId)}`
    if (input.modelProfileId === undefined) {
      await api(endpoint, { method: 'DELETE' })
      setModelAssignments((current) => current.filter((item) => item.scope !== input.scope || item.scopeId !== input.scopeId))
    } else {
      const result = await api<{ assignment: ModelAssignment }>(endpoint, { method: 'PUT', body: JSON.stringify({ modelProfileId: input.modelProfileId }) })
      setModelAssignments((current) => [...current.filter((item) => item.scope !== result.assignment.scope || item.scopeId !== result.assignment.scopeId), result.assignment])
    }
  }, [workspace])

  const runSystemAction = useCallback(async (action: SystemAction, input?: SystemActionInput): Promise<SystemActionResult> => {
    if (demoMode) {
      await delay(350)
      if (action === 'backup' || action === 'export') {
        return {
          ok: true,
          kind: action,
          output: `演示模式/${action === 'backup' ? 'dsh-cyber-demo.dshbackup' : 'dsh-cyber-demo.json'}`,
          ...(action === 'backup' ? { format: 'dsh-cyber-local-backup', bundle: true } : {}),
          createdAt: new Date().toISOString(),
        }
      }
      if (action === 'verify-update') {
        return { ok: true, version: '0.1.1-rc.1', supported: true, contractId: 'dsh-session-events-v1', checks: { packageVersions: true, isolatedProfile: true }, transaction: demoRuntimeTransaction('verified') }
      }
      if (action === 'contract-update') return { ok: true, transaction: demoRuntimeTransaction('contract-tested') }
      if (action === 'canary-update') return { ok: true, transaction: demoRuntimeTransaction('canary-passed') }
      if (action === 'activate-update') return { ok: true, transaction: demoRuntimeTransaction('activated'), restartRequired: true }
      if (action === 'rollback-update') return { ok: true, transaction: demoRuntimeTransaction('rolled-back'), restartRequired: true }
      if (action === 'list-updates') return { ok: true, items: [] }
      return { ok: true, checkedAt: new Date().toISOString(), compatibility: { expectedVersion: '0.1.1-rc.1', errors: [] }, database: { schemaVersion: 5, integrity: ['ok'], errors: [] } }
    }
    if (action === 'status') return api<SystemActionResult>('/api/system/status')
    if (action === 'doctor') return api<SystemActionResult>('/api/system/doctor', { method: 'POST', body: '{}' })
    if (action === 'backup') return api<SystemActionResult>('/api/system/backup', { method: 'POST', body: '{}' })
    if (action === 'export') return api<SystemActionResult>('/api/system/export', { method: 'POST', body: '{}' })
    if (action === 'list-updates') return api<SystemActionResult>('/api/system/updates')
    if (action === 'verify-update') return api<SystemActionResult>('/api/system/update/verify', { method: 'POST', body: JSON.stringify({ candidateRoot: input?.candidateRoot }) })
    const transactionId = input?.transactionId
    if (!transactionId) throw new Error('缺少更新事务，请重新验证候选版本。')
    if (action === 'contract-update') return api<SystemActionResult>(`/api/system/update/${transactionId}/contract-test`, { method: 'POST', body: '{}' })
    if (action === 'canary-update') return api<SystemActionResult>(`/api/system/update/${transactionId}/canary`, { method: 'POST', body: JSON.stringify({ modelProfileId: input?.modelProfileId }) })
    if (action === 'activate-update') return api<SystemActionResult>(`/api/system/update/${transactionId}/activate`, { method: 'POST', body: JSON.stringify({ approved: input?.approved === true }) })
    return api<SystemActionResult>(`/api/system/update/${transactionId}/rollback`, { method: 'POST', body: JSON.stringify({ approved: input?.approved === true }) })
  }, [])

  const loadModelLogs = useCallback(async (filter: ModelInteractionLogFilter): Promise<ModelInteractionLogPage> => {
    if (workspace === undefined) throw new Error('请先创建工作区')
    if (demoMode) {
      await delay(200)
      const status = filter.status
      const modelId = filter.modelId
      const items: ModelInteractionLog[] = (demoData.modelProfiles[0] ? [
        {
          id: 'demo-log-1',
          workspaceId: workspace.id,
          source: 'turn' as const,
          modelId: demoData.modelProfiles[0].modelId,
          provider: demoData.modelProfiles[0].displayName,
          status: 'success' as const,
          promptMessageCount: 3,
          promptCharCount: 842,
          responseCharCount: 156,
          toolCallCount: 2,
          durationMs: 3_420,
          tokensPrompt: 1_204,
          tokensCompletion: 312,
          tokensTotal: 1_516,
          createdAt: new Date(Date.now() - 4 * 60_000).toISOString(),
        },
        {
          id: 'demo-log-2',
          workspaceId: workspace.id,
          source: 'discovery' as const,
          modelId: '-',
          provider: demoData.modelProfiles[0].displayName,
          status: 'failed' as const,
          errorCode: 'model_catalog_timeout',
          errorMessage: '模型服务响应超时，请检查地址或稍后重试。',
          promptMessageCount: 0,
          promptCharCount: 0,
          durationMs: 12_000,
          createdAt: new Date(Date.now() - 32 * 60_000).toISOString(),
        },
      ] : [])
        .filter((log) =>
          (status === undefined || log.status === status) &&
          (modelId === undefined || modelId === '' || log.modelId === modelId),
        )
      const pageSize = filter.pageSize
      const page = Math.max(1, filter.page)
      const total = items.length
      return {
        items: items.slice((page - 1) * pageSize, page * pageSize),
        total,
        page,
        pageSize,
        modelIds: [...new Set(items.map((log) => log.modelId))],
      }
    }
    const query = new URLSearchParams()
    query.set('page', String(filter.page))
    query.set('pageSize', String(filter.pageSize))
    if (filter.status !== undefined) query.set('status', filter.status)
    if (filter.modelId !== undefined && filter.modelId) query.set('modelId', filter.modelId)
    return api<ModelInteractionLogPage>(`/api/workspaces/${workspace.id}/model-interactions?${query.toString()}`)
  }, [demoMode, workspace])

  const clearModelLogs = useCallback(async (): Promise<number> => {
    if (workspace === undefined) throw new Error('请先创建工作区')
    if (demoMode) {
      await delay(200)
      return 0
    }
    const result = await api<{ removed: number }>(`/api/workspaces/${workspace.id}/model-interactions`, { method: 'DELETE' })
    return result.removed
  }, [demoMode, workspace])

  const resize = useCallback((leftPaneWidth: number, rightPaneWidth: number) => {
    setPreferences((current) => current === undefined ? current : { ...current, leftPaneWidth, rightPaneWidth })
  }, [])

  const backgroundImage = resolveBackground(preferences?.backgroundAssetRef)
  const shellStyle = useMemo(() => backgroundImage === undefined ? undefined : {
    '--workspace-background-image': `url("${backgroundImage}")`,
    '--workspace-background-opacity': String(preferences?.backgroundOpacity ?? 0.2),
    '--workspace-background-size': preferences?.backgroundFit === 'contain' ? 'contain' : preferences?.backgroundFit === 'tile' ? 'auto' : 'cover',
    '--workspace-background-repeat': preferences?.backgroundFit === 'tile' ? 'repeat' : 'no-repeat',
  } as CSSProperties, [backgroundImage, preferences?.backgroundFit, preferences?.backgroundOpacity])

  if (loading) return <LoadingScreen />
  if (workspace === undefined || activeWorld === undefined || preferences === undefined) {
    return <Onboarding {...(error === undefined ? {} : { error })} onCreated={async () => window.location.reload()} />
  }

  return (
    <div className="app-frame" style={shellStyle}>
      <div className="workspace-backdrop" aria-hidden="true" />
      <header className="topbar">
        <div className="brand-lockup"><Cube size={20} weight="fill" /><strong>DSH Cyber</strong></div>

        <WorldSwitcher
          worlds={worlds}
          activeWorld={activeWorld}
          onSelect={(world) => void loadWorld(world)}
          onExplore={() => void openPackageMarket('theme')}
        />
        <nav aria-label="全局功能">
          <CreativeWorkshopLauncher workspaceId={workspace.id} onCreated={(project) => void openWorkshopWorld(project.worldId)} onOpenWorld={(worldId) => void openWorkshopWorld(worldId)} />
          <button type="button" onClick={() => void openPackageMarket(packageMarketKind)}><Storefront size={16} />市场</button>
          <button type="button" onClick={() => { setSettingsSection('runtime'); setSettingsOpen(true) }}><Pulse size={16} /><span>运行时健康</span><i className="health-indicator" />良好</button>
          <button type="button" onClick={() => { setSettingsSection('appearance'); setSettingsOpen(true) }}><GearSix size={17} />设置</button>
        </nav>
      </header>
      {error === undefined ? null : <div className="error-banner" role="alert">{error}<button type="button" onClick={() => setError(undefined)}>关闭</button></div>}
      <ResizableShell
        leftWidth={preferences.leftPaneWidth}
        rightWidth={preferences.rightPaneWidth}
        rightCollapsed={dockCollapsed}
        rightPrimary={appMode === 'world' && dockTab === 'world'}
        onResize={resize}
        left={(
          <NavigationPane
            world={activeWorld}
            sessions={sessions}
            {...(activeSessionId === undefined ? {} : { activeSessionId })}
            activeEmployeeIds={activeParticipantIds}
            sessionParticipants={sessionParticipants}
            employees={employees}
            onSelectSession={selectSession}
            onSelectEmployee={(employeeId) => void openDossier(employeeId)}
            onDirectEmployee={directEmployee}
            onRecruit={() => void openRecruitment()}
            onCreateGroup={() => setGroupDialogOpen(true)}
          onWorldSettings={() => setWorldSettingsOpen(true)}
          />
        )}
        center={(
          <ChatWorkbench
            demoMode={demoMode}
            world={activeWorld}
            {...(activeSession === undefined ? {} : { session: activeSession })}
            {...(conversationIntent === undefined ? {} : { intent: conversationIntent })}
            participantIds={activeParticipantIds}
            messages={messages}
            employees={employees}
            sending={sending}
            draft={draft}
            onDraftChange={setDraft}
            onSend={send}
            onUploadAttachment={uploadChatAttachment}
            onOpenDossier={(employeeId) => void openDossier(employeeId)}
            onOpenArtifact={() => { setAppMode('world'); setDockCollapsed(false); setDockTab('world') }}
            onRecruit={() => { setSelectedEmployeeId(undefined); setDockCollapsed(false); setDockTab('dossier') }}
          />
        )}
        right={(
          <ArtifactDock
            demoMode={demoMode}
            activeTab={dockTab}
            {...(selectedEmployee === undefined ? {} : { selectedEmployee })}
            dossiers={dossiers}
            employees={employees}
            world={activeWorld}
            {...(backgroundImage === undefined ? {} : { sceneImage: backgroundImage })}
            {...(supportsWorldRuntime ? {
              worldContent: (
                <WorldRuntimeDock
                  key={`${activeWorld.id}:${worldRuntimeRevision}`}
                  demoMode={demoMode}
                  world={activeWorld}
                  employees={employees}
                  conversationEmployeeIds={activeParticipantIds}
                  {...(selectedEmployeeId === undefined ? {} : { selectedEmployeeId })}
                  onSelectEmployee={(employeeId) => {
                    const employee = employees.find((item) => item.id === employeeId)
                    if (employee !== undefined) directEmployee(employee)
                  }}
                  onStartGroup={(employeeIds, session) => {
          const selected = employees.filter((employee) => employeeIds.includes(employee.id))
          if (selected.length < 2) return
          if (session !== undefined) {
            setSessions((current) => [session, ...current.filter((item) => item.id !== session.id)])
            setSessionParticipants((current) => ({ ...current, [session.id]: employeeIds }))
            setActiveSessionId(session.id)
            setConversationIntent(undefined)
            setSelectedEmployeeId(employeeIds[0])
            setMessages([])
            setAppMode('workbench')
            setDockCollapsed(false)
            setDockTab('world')
            return
          }
          createGroupIntent({ employeeIds: selected.map((employee) => employee.id), title: selected.map((employee) => employee.displayName).join('、') })
        }}
                />
              ),
            } : {})}
            traceContent={<WorldTracePanel key={activeWorld.id} world={activeWorld} employees={employees} demoMode={demoMode} />}
            scheduleContent={<TaskSchedulePanel employees={employees} items={taskSchedules} busy={scheduleBusy} onCreate={createTaskSchedule} onStatus={updateTaskScheduleStatus} onRun={runTaskSchedule} onDelete={deleteTaskSchedule} />}
            onTabChange={(tab) => { setDockTab(tab); setAppMode(tab === 'world' ? 'world' : 'workbench') }}
            onCollapse={() => setDockCollapsed(true)}
            onSelectEmployee={(employeeId) => void openDossier(employeeId)}
            onDirectEmployee={directEmployee}
            onManageEmployee={(employee) => setManagingEmployeeId(employee.id)}
            onShowAllDossiers={() => setSelectedEmployeeId(undefined)}
            onInvite={() => void openRecruitment()}
          />
        )}
      />
      {dockCollapsed ? <button className="dock-reopen" type="button" onClick={() => setDockCollapsed(false)} aria-label="展开侧边栏"><SidebarSimple size={18} /></button> : null}
      {groupDialogOpen ? (
        <GroupConversationDialog
          employees={employees}
          onClose={() => setGroupDialogOpen(false)}
          onCreate={createGroupIntent}
        />
      ) : null}
      {settingsOpen ? (
        <SettingsDialog
          preferences={preferences}
          models={models}
          assignments={modelAssignments}
          workspace={workspace}
          worlds={worlds}
          employees={employees}
          initialSection={settingsSection}
          saving={savingSettings}
          onClose={() => setSettingsOpen(false)}
          onSavePreferences={savePreferences}
          onUploadBackground={uploadBackground}
          onSaveModel={saveModel}
          onDiscoverModels={discoverModels}
          onDeleteModel={deleteModel}
          onAssignModel={assignModel}
          onSystemAction={runSystemAction}
          onLoadModelLogs={loadModelLogs}
          onClearModelLogs={clearModelLogs}
        />
      ) : null}
      {recruitmentOpen ? (
        <RecruitmentDialog
          blueprints={blueprints}
          employees={employees}
          world={activeWorld}
          loading={catalogLoading}
          recruiting={recruiting}
          onClose={() => setRecruitmentOpen(false)}
          onRecruit={recruitEmployee}
        />
      ) : null}
      {packageMarketOpen ? (
        <PackageMarketDialog
          initialMarket={packageMarketKind}
          items={marketplaceItems}
          installed={installedPackages}
          transactions={packageTransactions}
          employees={employees}
          loading={packageLoading}
          installing={packageInstalling}
          onClose={() => setPackageMarketOpen(false)}
          onPreview={previewPackage}
          onInstall={installPackage}
          onSearch={searchMarketplace}
          onPreviewMarketplace={previewMarketplacePackage}
          onInstallMarketplace={installMarketplacePackage}
          onBindTheme={bindWorldTheme}
        />
      ) : null}
      {worldSettingsOpen && activeWorld !== undefined && worldSettings !== undefined && worldAccess !== undefined ? <WorldSettingsDialog world={activeWorld} value={worldSettings} access={worldAccess} models={models} saving={savingSettings} onClose={()=>setWorldSettingsOpen(false)} onSave={async (value)=>{ setSavingSettings(true); try { const result = await api<{settings:WorldSettings}>(`/api/worlds/${activeWorld.id}/settings`, { method:'PUT', body:JSON.stringify(value) }); setWorldSettings(result.settings); setReasoningEffort(result.settings.model.reasoningEffort); setPermissionMode(result.settings.runtime.permissionMode); applyWorldAppearance(result.settings) } finally { setSavingSettings(false) } }} onSetPassword={async(password)=>{ const result=await api<{access:WorldAccessSummary}>(`/api/worlds/${activeWorld.id}/access/password`,{method:'POST',body:JSON.stringify({password})});setWorldAccess(result.access)}} onClearPassword={async()=>{const result=await api<{access:WorldAccessSummary}>(`/api/worlds/${activeWorld.id}/access/password`,{method:'DELETE'});setWorldAccess(result.access)}} onLock={async()=>{await api(`/api/worlds/${activeWorld.id}/access/lock`,{method:'POST',body:'{}'});setWorldSettingsOpen(false);setLockedWorld(activeWorld)}} /> : null}
      {lockedWorld !== undefined ? <WorldUnlockDialog worldName={lockedWorld.name} onUnlock={async(password)=>{ await api(`/api/worlds/${lockedWorld.id}/access/unlock`,{method:'POST',body:JSON.stringify({password})}); const world=lockedWorld; setLockedWorld(undefined); await loadWorld(world) }} /> : null}
      {managingEmployee !== undefined ? (
        <EmployeeManagementDialog
          employee={managingEmployee}
          {...(managingDossier?.profile === undefined ? {} : { profile: managingDossier.profile })}
          {...(managingRevision === undefined ? {} : { currentRevision: managingRevision })}
          models={models}
          avatarIndex={managingEmployee.avatarIndex}
          saving={savingEmployee}
          onClose={() => setManagingEmployeeId(undefined)}
          onRevise={reviseEmployee}
          onUpdateProfile={updateEmployeeProfile}
          onArchive={archiveEmployee}
        />
      ) : null}
    </div>
  )
}

function scheduleErrorLabel(code?: string): string {
  const labels: Record<string, string> = {
    'model-unavailable': '模型或凭据不可用',
    'runtime-unavailable': '运行时不可用',
    'employee-unavailable': '执行角色不可用',
    'service-restarted': '服务重启时中断',
    'execution-failed': '任务执行未成功',
  }
  return labels[code ?? ''] ?? '请在世界轨迹中查看失败详情'
}

function applyWorldAppearance(settings: WorldSettings): void {
  const root = document.documentElement
  const appearance = settings.appearance
  root.style.setProperty('--world-accent', appearance.accentColor)
  root.style.setProperty('--world-background', appearance.pageBackground)
  root.style.setProperty('--world-panel', appearance.panelBackground)
  root.style.setProperty('--world-owner-bubble', appearance.ownerBubbleColor)
  root.style.setProperty('--world-character-bubble', appearance.characterBubbleColor)
  root.style.setProperty('--world-text', appearance.textColor)
  root.style.setProperty('--world-muted', appearance.mutedTextColor)
  root.style.setProperty('--world-panel-radius', `${appearance.panelRadius}px`)
  root.style.setProperty('--world-bubble-radius', `${appearance.bubbleRadius}px`)
  root.style.setProperty('--world-button-radius', `${appearance.buttonRadius}px`)
  root.style.setProperty('--world-font-scale', String(appearance.fontScale))
}

function WorldSwitcher({
  worlds,
  activeWorld,
  onSelect,
  onExplore,
}: {
  worlds: World[]
  activeWorld: World
  onSelect(world: World): void
  onExplore(): void
}) {
  const detailsRef = useRef<HTMLDetailsElement>(null)
  const close = () => { if (detailsRef.current) detailsRef.current.open = false }
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (detailsRef.current?.open && !detailsRef.current.contains(event.target as Node)) close()
    }
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') close() }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [])
  return (
    <details ref={detailsRef} className="topbar-world-switcher">
      <summary aria-label={`切换世界，当前为${activeWorld.name}`}>
        <Buildings size={17} />
        <span>当前世界：</span>
        <strong>{activeWorld.name}</strong>
        <CaretDown size={14} />
      </summary>
      <div className="topbar-world-switcher__menu">
        <header><strong>切换世界主体</strong><span>角色、会话和地图彼此独立</span></header>
        <div role="menu">
          {worlds.map((world) => (
            <button
              key={world.id}
              type="button"
              role="menuitemradio"
              aria-checked={world.id === activeWorld.id}
              onClick={() => { onSelect(world); close() }}
            >
              <Buildings size={17} />
              <span><strong>{world.name}</strong><small>{worldExperience(world).kind === 'tavern' ? '叙事角色世界' : '团队协作世界'}</small></span>
              {world.id === activeWorld.id ? <Check size={16} weight="bold" /> : null}
            </button>
          ))}
        </div>
        <button className="topbar-world-switcher__explore" type="button" onClick={() => { onExplore(); close() }}>
          <Compass size={18} />
          <span><strong>探索更多世界</strong><small>前往主题市场搜索并安装</small></span>
        </button>
      </div>
    </details>
  )
}

function LoadingScreen() {
  return <div className="loading-screen"><Cube size={28} weight="fill" /><strong>DSH Cyber</strong><span>正在恢复本地世界…</span></div>
}

function Onboarding({ error, onCreated }: { error?: string; onCreated(): Promise<void> }) {
  const [creating, setCreating] = useState(false)
  const create = async () => {
    setCreating(true)
    try {
      const workspaceResult = await api<{ workspace: Workspace }>('/api/workspaces', { method: 'POST', body: JSON.stringify({ name: '本地实例' }) })
      const worldResult = await api<{ world: World }>(`/api/workspaces/${workspaceResult.workspace.id}/worlds`, { method: 'POST', body: JSON.stringify({ name: '我的世界', templateId: 'personal-world' }) })
      await api(`/api/worlds/${worldResult.world.id}/recruit`, { method: 'POST', body: JSON.stringify({ blueprintId: 'core.butler', blueprintVersion: 1, displayName: '管家' }) })
      await onCreated()
    } finally {
      setCreating(false)
    }
  }
  return (
    <main className="onboarding">
      <div className="brand-lockup brand-lockup--large"><Cube size={28} weight="fill" /><strong>DSH Cyber</strong></div>
      <h1>创建第一个本地世界</h1>
      <p>每个世界拥有独立角色、会话、文件、设定和访问锁。首次会添加一名“管家”帮助你开始。</p>
      {error === undefined ? null : <div className="onboarding__error">{error}</div>}
      <button className="primary-button" type="button" disabled={creating} onClick={() => void create()}>{creating ? '正在创建…' : '创建我的世界'}</button>
      <a href="?demo=1">先体验交互演示</a>
    </main>
  )
}

function toCyberEmployee(employee: EmployeeInstance, index: number, dossier?: EmployeeDossier): CyberEmployee {
  return {
    ...employee,
    avatarIndex: profileAvatarIndex(dossier) ?? stableAvatar(employee.id, index),
    summary: `${employee.role}独立 Agent，拥有自己的会话、记忆与成长记录。`,
    currentActivity: statusActivity(employee),
  }
}

function profileAvatarIndex(dossier?: EmployeeDossier): number | undefined {
  const value = dossier?.profile?.appearance.avatarIndex
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < 8 ? value : undefined
}

function stableAvatar(id: string, fallback: number): number {
  let total = fallback
  for (const character of id) total = (total * 31 + character.charCodeAt(0)) % 8
  return total
}

function statusActivity(employee: EmployeeInstance): string {
  if (employee.status === 'working') return `正在执行${employee.role}任务`
  if (employee.status === 'blocked') return '等待依赖或进一步处理'
  if (employee.status === 'waiting') return '等待下一步处理'
  return '可接新任务'
}

function makeDemoSession(
  world: World,
  prompt: string,
  kind: WorkSession['kind'] = 'direct',
  title?: string,
): WorkSession {
  const timestamp = new Date().toISOString()
  return { id: `session-${Date.now()}`, workspaceId: world.workspaceId, worldId: world.id, kind, title: title?.trim() || compactPrompt(prompt), status: 'open', createdAt: timestamp, updatedAt: timestamp }
}

function participantIdsFromMessages(messages: WorkMessage[]): string[] {
  const ids: string[] = []
  for (const message of messages) {
    const metadataIds = message.metadata.participantIds
    if (Array.isArray(metadataIds)) {
      for (const value of metadataIds) {
        if (typeof value === 'string' && value !== 'owner' && !ids.includes(value)) ids.push(value)
      }
    }
    if (message.senderKind === 'employee' && !ids.includes(message.senderId)) ids.push(message.senderId)
  }
  return ids
}

function inferDemoSessionParticipants(
  sessions: WorkSession[],
  messages: WorkMessage[],
  employees: CyberEmployee[],
): SessionParticipantMap {
  const result: SessionParticipantMap = {}
  for (const session of sessions) {
    const messageParticipants = participantIdsFromMessages(messages.filter((message) => message.sessionId === session.id))
    if (messageParticipants.length > 0) {
      result[session.id] = messageParticipants
      continue
    }
    const titleParticipants = employees
      .filter((employee) => session.title.includes(employee.displayName))
      .map((employee) => employee.id)
    result[session.id] = session.kind === 'direct' ? titleParticipants.slice(0, 1) : titleParticipants
  }
  return result
}

function makeDemoMessage(sessionId: string, sequence: number, senderId: string, senderKind: WorkMessage['senderKind'], kind: WorkMessage['kind'], content: string, metadata?: JsonObject): WorkMessage {
  const createdAt = new Date().toISOString()
  return { id: `message-${Date.now()}-${sequence}`, sessionId, sequence, senderId, senderKind, kind, content, metadata: { displayTime: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }), ...metadata }, createdAt }
}

function compactPrompt(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim()
  return compact.length > 36 ? `${compact.slice(0, 35)}…` : compact
}

function tavernDemoReply(employee: CyberEmployee, prompt: string): string {
  const cue = compactPrompt(prompt.replace(new RegExp(`@${employee.displayName}`, 'g'), '').trim())
  if (employee.id.includes('innkeeper')) return `伊瑟拉把杯子轻轻放下，目光越过摇晃的烛火：“${cue || '你终于来了'}……这句话，我十二年前也听过一次。”`
  if (employee.id.includes('bard')) return `洛安按住仍在震颤的琴弦，笑意并未抵达眼底：“关于‘${cue || '这个故事'}’，歌里有三个版本。你想先听活人的，还是亡者的？”`
  if (employee.id.includes('knight')) return `凯恩抬起被雨水打湿的脸，声音很低：“${cue || '继续说'}。但如果你提到北境，我会先问清你的立场。”`
  return `弥娅翻开皮革封面的旧册，在你的话旁写下时间与见证者：“${cue || '这段对话'}已经归档。现在，我们可以追查它和旧传闻的联系。”`
}

function resolveBackground(reference?: string): string | undefined {
  if (reference === undefined) return undefined
  if (reference.startsWith('blob:') || reference.startsWith('data:')) return reference
  const assetId = /^assets\/(.+)$/.exec(reference)?.[1]
  return assetId === undefined ? undefined : `/api/assets/${encodeURIComponent(assetId)}`
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('文件读取失败'))
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.readAsDataURL(file)
  })
}

function attachmentMimeType(file: File): LocalAssetMimeType {
  const byType = file.type.toLowerCase()
  const supported: LocalAssetMimeType[] = [
    'image/png', 'image/jpeg', 'image/webp',
    'text/plain', 'text/markdown', 'application/json', 'application/pdf',
  ]
  if (supported.includes(byType as LocalAssetMimeType)) return byType as LocalAssetMimeType
  const extension = file.name.toLowerCase().split('.').pop()
  const byExtension: Record<string, LocalAssetMimeType> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
    txt: 'text/plain', md: 'text/markdown', json: 'application/json', pdf: 'application/pdf',
  }
  const inferred = extension === undefined ? undefined : byExtension[extension]
  if (inferred === undefined) throw new Error('仅支持 PNG、JPEG、WebP、TXT、Markdown、JSON 和 PDF 附件。')
  return inferred
}

function serializableAttachments(attachments: ChatAttachment[]): JsonObject[] {
  return attachments.map((attachment) => ({
    assetId: attachment.assetId,
    name: attachment.name,
    mimeType: attachment.mimeType,
    byteLength: attachment.byteLength,
    url: attachment.url,
  }))
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds))
}

function demoRuntimeTransaction(status: RuntimeUpdateTransaction['status']): RuntimeUpdateTransaction {
  const timestamp = new Date().toISOString()
  return {
    id: 'demo-runtime-update',
    candidateRoot: '演示候选运行时',
    version: '0.1.1-rc.1',
    contractId: 'dsh-session-events-v1',
    status,
    report: { ok: true, demo: true },
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

function runtimeEmployeeStatus(event: AgentRuntimeEvent): EmployeeInstance['status'] | undefined {
  if (event.kind === 'turn.started' || event.kind === 'tool.started') return 'working'
  if (event.kind === 'turn.completed') return 'available'
  if (event.kind === 'turn.failed') return 'blocked'
  return undefined
}

function runtimeActivity(event: AgentRuntimeEvent, role: string): string {
  if (event.kind === 'tool.started') return `正在使用 ${event.toolName ?? '工具'}`
  if (event.kind === 'turn.started') return `正在处理${role}任务`
  if (event.kind === 'turn.failed') return '执行失败，等待推进'
  return '可接新任务'
}

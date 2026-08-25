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
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type {
  AgentRuntimeEvent,
  AgentPermissionMode,
  ApprovalRequestView,
  ApprovalScope,
  ChatAttachment,
  CyberMarketKind,
  CyberMarketPackage,
  CyberPackageManifest,
  EmployeeBlueprint,
  EmployeeDossier,
  EmployeeInstance,
  EmployeeRevision,
  InstalledPackage,
  InstalledPluginCommand,
  JsonObject,
  LocalAssetMimeType,
  ModelAssignment,
  ModelInteractionLog,
  ModelInteractionLogFilter,
  ModelInteractionLogPage,
  ModelProfile,
  PackageInstallTransaction,
  PackagePermissionPreview,
  TaskSchedule,
  WorkMessage,
  WorkSession,
  WorkSessionParticipant,
  Workspace,
  WorkspacePreferences,
  WorkspaceSnapshot,
  World,
  WorldCharacterAuthority,
  WorldCharacterPermission,
  WorldCharacterRole,
  WorldPermissionDecisionScope,
  WorldPermissionRequest,
  WorldAccessSummary,
  WorldSettings,
  ReasoningEffort,
  WorldSnapshot,
} from '@dsh-cyber/contracts'
import {
  isWorldCharacterPermission,
  isWorldCharacterRole,
  RECOMMENDED_ADMIN_PERMISSIONS,
} from '@dsh-cyber/contracts'

import { ApiError, api } from './api.js'
import {
  ChatTurnQueue,
  mergeChatTimeline,
  messageClientTurnId,
  type PendingChatTurn,
  type StreamingChatReply,
} from './chat-realtime.js'
import { ChatWorkbench, isChatMessage } from './components/ChatWorkbench.js'
import { CreativeWorkshopLauncher } from './components/CreativeWorkshopLauncher.js'
import { NavigationPane } from './components/NavigationPane.js'
import { ResizableShell } from './components/ResizableShell.js'
import type {
  DiscoveredModel,
  ModelDiscoveryDraft,
  ModelProfileSaveDraft,
  SettingsSection,
  SystemAction,
  SystemActionInput,
  SystemActionResult,
} from './components/SettingsDialog.js'
import { demoData, demoTavernDossiers, demoTavernEmployees, demoTavernMessages, demoTavernSessions } from './demo-data.js'
import type { ConversationIntent, CyberEmployee, DockTab, SessionParticipantMap } from './types.js'
import type { EmployeeSettingsSection } from './components/EmployeeManagementDialog.js'
import { worldExperience } from './world-experience.js'
import { subscribeWorldLive } from './world-live-client.js'

const SettingsDialog = lazy(async () => ({ default: (await import('./components/SettingsDialog.js')).SettingsDialog }))
const ArtifactDock = lazy(async () => ({ default: (await import('./components/ArtifactDock.js')).ArtifactDock }))
const EmployeeManagementDialog = lazy(async () => ({ default: (await import('./components/EmployeeManagementDialog.js')).EmployeeManagementDialog }))
const GroupConversationDialog = lazy(async () => ({ default: (await import('./components/GroupConversationDialog.js')).GroupConversationDialog }))
const MessageHistoryDialog = lazy(async () => ({ default: (await import('./components/MessageHistoryDialog.js')).MessageHistoryDialog }))
const PackageMarketDialog = lazy(async () => ({ default: (await import('./components/PackageMarketDialog.js')).PackageMarketDialog }))
const RecruitmentDialog = lazy(async () => ({ default: (await import('./components/RecruitmentDialog.js')).RecruitmentDialog }))
const WorldSettingsDialog = lazy(async () => ({ default: (await import('./components/WorldSettingsDialog.js')).WorldSettingsDialog }))
const WorldUnlockDialog = lazy(async () => ({ default: (await import('./components/WorldSettingsDialog.js')).WorldUnlockDialog }))
const WorldRuntimeDock = lazy(async () => ({ default: (await import('./features/world/WorldRuntimeDock.js')).WorldRuntimeDock }))
const WorldTracePanel = lazy(async () => ({ default: (await import('./components/world-trace/WorldTracePanel.js')).WorldTracePanel }))
const TaskSchedulePanel = lazy(async () => ({ default: (await import('./components/TaskSchedulePanel.js')).TaskSchedulePanel }))

const demoMode = new URLSearchParams(window.location.search).get('demo') === '1'
const worldRuntimeV2Enabled = new URLSearchParams(window.location.search).get('legacyWorld') !== '1'
const MESSAGE_PAGE_SIZE = 20
type AppMode = 'world' | 'workbench'

interface ChatResult {
  session: WorkSession
}

interface RuntimeEnvelope {
  workspaceId: string
  worldId: string
  sessionId: string
  agentId: string
  workTurnId: string
  agentRunId: string
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
  const [messages, setMessages] = useState<WorkMessage[]>(demoMode ? demoData.messages.slice(-MESSAGE_PAGE_SIZE) : [])
  const [messagePage, setMessagePage] = useState({ hasMore: demoMode && demoData.messages.length > MESSAGE_PAGE_SIZE, loading: false })
  const [pendingApprovals, setPendingApprovals] = useState<ApprovalRequestView[]>([])
  const [pendingWorldPermissionRequests, setPendingWorldPermissionRequests] = useState<WorldPermissionRequest[]>([])
  const [transcriptReload, setTranscriptReload] = useState(0)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [preferences, setPreferences] = useState<WorkspacePreferences | undefined>(demoMode ? demoData.preferences : undefined)
  const [models, setModels] = useState<ModelProfile[]>(demoMode ? demoData.modelProfiles : [])
  const [modelAssignments, setModelAssignments] = useState<ModelAssignment[]>([])
  const [dossiers, setDossiers] = useState<Record<string, EmployeeDossier>>(demoMode ? demoData.dossiers : {})
  const [authorities, setAuthorities] = useState<WorldCharacterAuthority[]>([])
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string | undefined>()
  const [dockTab, setDockTab] = useState<DockTab>('world')
  const [dockCollapsed, setDockCollapsed] = useState(false)
  const [draft, setDraft] = useState('')
  const [composerFocusRequest, setComposerFocusRequest] = useState(0)
  const [pendingTurns, setPendingTurns] = useState<PendingChatTurn[]>([])
  const [outboxMessages, setOutboxMessages] = useState<Record<string, WorkMessage[]>>({})
  const [streamingReplies, setStreamingReplies] = useState<Record<string, StreamingChatReply>>({})
  const turnQueueRef = useRef(new ChatTurnQueue())
  const sessionByQueueKeyRef = useRef(new Map<string, string>())
  const queueKeyBySessionRef = useRef(new Map<string, string>())
  const pendingTurnsRef = useRef<PendingChatTurn[]>([])
  const worldLoadRequestRef = useRef(0)
  const transcriptLoadRequestRef = useRef(0)
  const activeWorldRef = useRef<World | undefined>(undefined)
  const activeSessionIdRef = useRef<string | undefined>(undefined)
  const activeConversationKeyRef = useRef<string | undefined>(undefined)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('appearance')
  const [savingSettings, setSavingSettings] = useState(false)
  const [recruitmentOpen, setRecruitmentOpen] = useState(false)
  const [groupDialogOpen, setGroupDialogOpen] = useState(false)
  const [groupCreating, setGroupCreating] = useState(false)
  const [packageMarketOpen, setPackageMarketOpen] = useState(false)
  const [packageMarketKind, setPackageMarketKind] = useState<CyberMarketKind>('theme')
  const [marketplaceItems, setMarketplaceItems] = useState<CyberMarketPackage[]>([])
  const [installedPackages, setInstalledPackages] = useState<InstalledPackage[]>([])
  const [installedPluginCommands, setInstalledPluginCommands] = useState<InstalledPluginCommand[]>([])
  const [packageTransactions, setPackageTransactions] = useState<PackageInstallTransaction[]>([])
  const [packageLoading, setPackageLoading] = useState(false)
  const [packageInstalling, setPackageInstalling] = useState(false)
  const [blueprints, setBlueprints] = useState<EmployeeBlueprint[]>([])
  const [preferredBlueprintId, setPreferredBlueprintId] = useState<string>()
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [recruiting, setRecruiting] = useState(false)
  const [managingEmployeeId, setManagingEmployeeId] = useState<string>()
  const [managingEmployeeSection, setManagingEmployeeSection] = useState<EmployeeSettingsSection>('profile')
  const [savingEmployee, setSavingEmployee] = useState(false)
  const [loading, setLoading] = useState(!demoMode)
  const [error, setError] = useState<string | undefined>()
  const [appMode, setAppMode] = useState<AppMode>(worldRuntimeV2Enabled ? 'world' : 'workbench')
  const [worldRuntimeAvailable, setWorldRuntimeAvailable] = useState(demoMode)
  const [worldRuntimeRevision, setWorldRuntimeRevision] = useState(0)
  const [worldSettingsOpen, setWorldSettingsOpen] = useState(false)
  const [worldSettings, setWorldSettings] = useState<WorldSettings>()
  const [worldSettingsRevision, setWorldSettingsRevision] = useState<number>()
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
  const activeConversationKey = conversationQueueKey(
    conversationIntent,
    activeSession,
    activeParticipantIds,
    queueKeyBySessionRef.current,
  )
  const activePendingTurns = pendingTurns.filter((turn) =>
    turn.worldId === activeWorld?.id && turn.queueKey === activeConversationKey,
  )
  const activeStreamingReplies = Object.values(streamingReplies).filter((reply) =>
    reply.worldId === activeWorld?.id && reply.queueKey === activeConversationKey,
  )
  const activeOutboxMessages = activeConversationKey === undefined ? [] : outboxMessages[activeConversationKey] ?? []
  const chatMessages = useMemo(
    () => mergeChatTimeline(messages, activeOutboxMessages, activePendingTurns, activeStreamingReplies),
    [activeOutboxMessages, activePendingTurns, activeStreamingReplies, messages],
  )
  const activePendingCount = activePendingTurns.filter((turn) => turn.status === 'queued' || turn.status === 'running').length
  const activeQueuedCount = activePendingTurns.filter((turn) => turn.status === 'queued').length
  activeWorldRef.current = activeWorld
  activeSessionIdRef.current = activeSessionId
  activeConversationKeyRef.current = activeConversationKey
  pendingTurnsRef.current = pendingTurns

  const pendingDecisionFetchRef = useRef<string | undefined>(undefined)

  const refreshPendingDecisions = useCallback(async (worldId: string): Promise<void> => {
    if (demoMode) return
    // One in-flight fetch per world: a burst of events collapses into a single
    // request instead of a queue of identical ones.
    if (pendingDecisionFetchRef.current === worldId) return
    pendingDecisionFetchRef.current = worldId
    try {
      const result = await api<{
        approvals?: ApprovalRequestView[]
        permissionRequests?: WorldPermissionRequest[]
        worldPermissionRequests?: WorldPermissionRequest[]
        requests?: WorldPermissionRequest[]
      }>(`/api/worlds/${encodeURIComponent(worldId)}/pending-decisions`)
      if (activeWorldRef.current?.id !== worldId) return
      setPendingApprovals(result.approvals ?? [])
      setPendingWorldPermissionRequests(result.permissionRequests ?? result.worldPermissionRequests ?? result.requests ?? [])
    } catch {
      // A failed refresh must never interrupt the conversation; the next live or polling pass retries.
    } finally {
      if (pendingDecisionFetchRef.current === worldId) pendingDecisionFetchRef.current = undefined
    }
  }, [])

  const loadWorld = useCallback(async (world: World) => {
    const requestId = worldLoadRequestRef.current + 1
    worldLoadRequestRef.current = requestId
    const isCurrentRequest = () => worldLoadRequestRef.current === requestId

    setError(undefined)
    setActiveWorld(world)
    activeWorldRef.current = world
    setActiveSessionId(undefined)
    activeSessionIdRef.current = undefined
    setSessions([])
    setSessionParticipants({})
    setConversationIntent(undefined)
    activeConversationKeyRef.current = undefined
    setHistoryOpen(false)
    setMessages([])
    setMessagePage({ hasMore: false, loading: false })
    setDraft('')
    setSelectedEmployeeId(undefined)
    setEmployees([])
    setDossiers({})
    setAuthorities([])
    setPendingApprovals([])
    setPendingWorldPermissionRequests([])
    setDockTab('world')
    setPermissionMode('read-only')
    setTaskSchedules([])
    setWorldSettings(undefined)
    setWorldSettingsRevision(undefined)
    setWorldAccess(undefined)
    setWorldRuntimeAvailable(false)
    if (demoMode) {
      const isCompany = world.id === demoData.activeWorld.id
      setWorldRuntimeAvailable(true)
      setAppMode(worldRuntimeV2Enabled ? 'world' : 'workbench')
      const nextEmployees = isCompany ? demoData.employees : demoTavernEmployees
      const nextAuthorities = demoAuthorities(world, nextEmployees)
      const authorityByEmployee = new Map(nextAuthorities.map((authority) => [authority.employeeId, authority]))
      const nextSessions = isCompany ? demoData.sessions : demoTavernSessions
      const nextMessages = isCompany ? demoData.messages : demoTavernMessages
      setAuthorities(nextAuthorities)
      setEmployees(nextEmployees.map((employee) => applyAuthorityToEmployee(employee, authorityByEmployee.get(employee.id))))
      setSessions(nextSessions)
      setMessages(nextMessages.slice(-MESSAGE_PAGE_SIZE))
      setMessagePage({ hasMore: nextMessages.length > MESSAGE_PAGE_SIZE, loading: false })
      setSessionParticipants(inferDemoSessionParticipants(nextSessions, nextMessages, nextEmployees))
      setDossiers(isCompany ? demoData.dossiers : demoTavernDossiers)
      setActiveSessionId(nextSessions[0]?.id)
      return
    }
    try {
      let snapshot: WorldSnapshot
      try {
        snapshot = await api<WorldSnapshot>(`/api/worlds/${world.id}/snapshot`)
      } catch (cause) {
        if (cause instanceof ApiError && cause.status === 423) {
          if (isCurrentRequest()) setLockedWorld(world)
          return
        }
        throw cause
      }
      if (!isCurrentRequest()) return

      const [capability, settingsResult] = await Promise.all([
        api<{ supported: boolean }>(`/api/worlds/${world.id}/runtime-capability`),
        api<{ settings: WorldSettings; access: WorldAccessSummary; revision?: number; settingsRevision?: number }>(`/api/worlds/${world.id}/settings`),
      ])
      if (!isCurrentRequest()) return

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
      if (!isCurrentRequest()) return

      const nextDossiers: Record<string, EmployeeDossier> = {}
      for (const dossier of dossierResults) {
        if (dossier !== undefined) nextDossiers[dossier.employee.id] = dossier
      }
      setWorldSettings(settingsResult.settings)
      setWorldSettingsRevision(settingsResult.revision ?? settingsResult.settingsRevision)
      applyWorldAppearance(settingsResult.settings)
      setWorldAccess(settingsResult.access)
      setReasoningEffort(settingsResult.settings.model.reasoningEffort)
      setPermissionMode(settingsResult.settings.runtime.permissionMode)
      setWorldRuntimeAvailable(capability.supported)
      setAppMode(worldRuntimeV2Enabled && capability.supported ? 'world' : 'workbench')
      setDossiers(nextDossiers)
      const nextAuthorities = snapshot.authorities ?? []
      const authorityByEmployee = new Map(nextAuthorities.map((authority) => [authority.employeeId, authority]))
      setAuthorities(nextAuthorities)
      setEmployees(snapshot.employees.map((employee, index) => toCyberEmployee(employee, index, nextDossiers[employee.id], authorityByEmployee.get(employee.id))))
      setSessions(snapshot.openSessions)
      // A world with existing sessions opens the most recently active one by default.
      // This keeps the composer and history action attached to a real conversation
      // instead of presenting an empty, non-sendable center pane after refresh.
      setActiveSessionId(snapshot.openSessions[0]?.id)
      setSessionParticipants(Object.fromEntries(participantResults))
      setTaskSchedules(scheduleResult.items)
      rememberActiveWorld(world.workspaceId, world.id)
    } catch (cause) {
      if (isCurrentRequest()) setError(cause instanceof Error ? cause.message : '世界加载失败')
    }
  }, [])

  const openWorkshopWorld = useCallback(async (worldId: string) => {
    if (workspace === undefined || demoMode) return
    const snapshot = await api<WorkspaceSnapshot>(`/api/workspaces/${workspace.id}/snapshot`)
    setWorlds(snapshot.worlds)
    const target = snapshot.worlds.find((world) => world.id === worldId)
    if (target === undefined) throw new Error('创意工坊对应的世界不存在或已归档')
    await loadWorld(target)
  }, [loadWorld, workspace])

  const createWorldFromTheme = useCallback(async (item: CyberMarketPackage, name: string) => {
    if (workspace === undefined) throw new Error('工作区尚未就绪')
    if (demoMode) throw new Error('演示模式不会写入新世界，请在本地工作区中创建')
    const result = await api<{ world: World }>(`/api/workspaces/${workspace.id}/marketplace/worlds`, {
      method: 'POST',
      body: JSON.stringify({ packageId: item.manifest.id, name }),
    })
    const snapshot = await api<WorkspaceSnapshot>(`/api/workspaces/${workspace.id}/snapshot`)
    setWorlds(snapshot.worlds)
    setPackageMarketOpen(false)
    await loadWorld(result.world)
  }, [loadWorld, workspace])

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
        const remembered = readRememberedWorldId(first.id)
        const target = snapshot.worlds.find((world) => world.id === remembered) ?? snapshot.worlds[0]
        if (target !== undefined) await loadWorld(target)
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : '无法连接本地 DSH Cyber 服务')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [loadWorld])

  const patchPendingTurn = useCallback((turnId: string, patch: Partial<PendingChatTurn>) => {
    setPendingTurns((current) => {
      const next = current.map((turn) => turn.id === turnId ? { ...turn, ...patch } : turn)
      pendingTurnsRef.current = next
      return next
    })
  }, [])

  const removePendingTurn = useCallback((turnId: string) => {
    setPendingTurns((current) => {
      const next = current.filter((turn) => turn.id !== turnId)
      pendingTurnsRef.current = next
      return next
    })
  }, [])

  const bindConversationSession = useCallback((queueKey: string, session: WorkSession, employeeIds: string[]) => {
    sessionByQueueKeyRef.current.set(queueKey, session.id)
    queueKeyBySessionRef.current.set(session.id, queueKey)
    setPendingTurns((current) => {
      const next = current.map((turn) => turn.queueKey === queueKey && turn.sessionId === undefined
        ? { ...turn, sessionId: session.id }
        : turn)
      pendingTurnsRef.current = next
      return next
    })
    if (activeWorldRef.current?.id !== session.worldId) return
    setSessions((current) => [session, ...current.filter((item) => item.id !== session.id)])
    setSessionParticipants((current) => ({ ...current, [session.id]: employeeIds }))
    if (activeConversationKeyRef.current === queueKey || activeConversationKeyRef.current === undefined) {
      setActiveSessionId(session.id)
      setConversationIntent(undefined)
    }
  }, [])

  const refreshConversationTranscript = useCallback(async (sessionId: string, queueKey: string, worldId: string, reportError = false) => {
    try {
      const result = await api<{ items: WorkMessage[]; hasMore?: boolean }>(`/api/sessions/${sessionId}/messages?view=chat&limit=${MESSAGE_PAGE_SIZE}`)
      setOutboxMessages((current) => reconcileOutboxMessages(current, queueKey, result.items))
      if (activeWorldRef.current?.id === worldId && activeConversationKeyRef.current === queueKey) {
        // Merge rather than replace: this refresh returns only the newest page,
        // and replacing would throw away everything loadOlder() pulled in every
        // time one of this client's own turns completes.
        setMessages((current) => mergeMessages(current, result.items))
        setMessagePage((current) => ({ hasMore: current.hasMore || result.hasMore === true, loading: false }))
        const participantIds = participantIdsFromMessages(result.items)
        if (participantIds.length > 0) {
          setSessionParticipants((current) => ({ ...current, [sessionId]: participantIds }))
        }
      }
      return result.items
    } catch (cause) {
      if (reportError && activeWorldRef.current?.id === worldId && activeConversationKeyRef.current === queueKey) {
        setError(cause instanceof Error ? cause.message : '会话加载失败')
      }
      return undefined
    }
  }, [])

  useEffect(() => {
    const requestId = ++transcriptLoadRequestRef.current
    if (demoMode || activeSessionId === undefined) return
    const sessionId = activeSessionId
    const worldId = activeWorldRef.current?.id
    const controller = new AbortController()
    let timedOut = false
    const timeout = window.setTimeout(() => {
      timedOut = true
      controller.abort()
    }, 10_000)
    const queueKey = queueKeyBySessionRef.current.get(activeSessionId) ?? activeConversationKeyRef.current
    setMessages([])
    setMessagePage({ hasMore: false, loading: false })
    void api<{ items: WorkMessage[]; hasMore?: boolean }>(`/api/sessions/${encodeURIComponent(sessionId)}/messages?view=chat&limit=${MESSAGE_PAGE_SIZE}`, { signal: controller.signal })
      .then((result) => {
        if (
          requestId !== transcriptLoadRequestRef.current ||
          activeSessionIdRef.current !== sessionId ||
          activeWorldRef.current?.id !== worldId
        ) return
        setMessages(result.items)
        setMessagePage({ hasMore: result.hasMore === true, loading: false })
        if (queueKey !== undefined) {
          sessionByQueueKeyRef.current.set(queueKey, sessionId)
          queueKeyBySessionRef.current.set(sessionId, queueKey)
          setOutboxMessages((current) => reconcileOutboxMessages(current, queueKey, result.items))
        }
        const participantIds = participantIdsFromMessages(result.items)
        if (participantIds.length > 0) {
          setSessionParticipants((current) => ({ ...current, [sessionId]: participantIds }))
        }
      })
      .catch((cause: unknown) => {
        if (requestId !== transcriptLoadRequestRef.current) return
        if (timedOut) {
          setError('会话加载超时，请重新点击当前会话重试')
          return
        }
        if (controller.signal.aborted) return
        setError(cause instanceof Error ? cause.message : '会话加载失败')
      })
      .finally(() => window.clearTimeout(timeout))
    return () => {
      window.clearTimeout(timeout)
      controller.abort()
    }
  }, [activeSessionId, transcriptReload])

  useEffect(() => {
    if (demoMode || activeWorld === undefined) return
    const world = activeWorld
    const onRuntime = (raw: Event) => {
      const message = raw as MessageEvent<string>
      try {
        const envelope = JSON.parse(message.data) as RuntimeEnvelope
        if (envelope.worldId !== world.id) return
        const status = runtimeEmployeeStatus(envelope.event)
        if (status !== undefined) {
          setEmployees((current) => current.map((employee) => employee.id === envelope.agentId
            ? { ...employee, status, currentActivity: runtimeActivity(envelope.event, employee.role) }
            : employee))
        }

        const clientTurnId = metadataText(envelope.event.metadata.clientTurnId)
        const traceTurnId = envelope.agentRunId
        if (traceTurnId === undefined) return
        const pending = pendingTurnsRef.current.find((turn) =>
          (clientTurnId !== undefined && turn.id === clientTurnId) ||
          (clientTurnId === undefined && turn.sessionId === envelope.sessionId),
        )
        const effectiveClientTurnId = clientTurnId ?? pending?.id
        if (effectiveClientTurnId === undefined) return
        const queueKey = pending?.queueKey
          ?? queueKeyBySessionRef.current.get(envelope.sessionId)
          ?? (activeSessionIdRef.current === envelope.sessionId ? activeConversationKeyRef.current : undefined)
        if (queueKey === undefined) return

        if (pending !== undefined && pending.sessionId !== envelope.sessionId) {
          const timestamp = new Date().toISOString()
          bindConversationSession(queueKey, {
            id: envelope.sessionId,
            workspaceId: world.workspaceId,
            worldId: world.id,
            kind: pending.employeeIds.length > 1 ? 'group' : 'direct',
            title: pending.title,
            status: 'open',
            createdAt: timestamp,
            updatedAt: timestamp,
          }, pending.employeeIds)
        } else {
          sessionByQueueKeyRef.current.set(queueKey, envelope.sessionId)
          queueKeyBySessionRef.current.set(envelope.sessionId, queueKey)
        }

        const streamId = `stream-${traceTurnId}`
        const upsertStream = (content: string, replaceContent: boolean) => {
          setStreamingReplies((current) => {
            const previous = current[streamId]
            const createdAt = previous?.createdAt ?? new Date().toISOString()
            return {
              ...current,
              [streamId]: {
                id: streamId,
                queueKey,
                worldId: world.id,
                sessionId: envelope.sessionId,
                employeeId: envelope.agentId,
                clientTurnId: effectiveClientTurnId,
                traceTurnId,
                workTurnId: envelope.workTurnId,
                agentRunId: envelope.agentRunId,
                content: replaceContent ? content : `${previous?.content ?? ''}${content}`,
                createdAt,
              },
            }
          })
        }

        if (envelope.event.kind === 'turn.started') upsertStream('', true)
        if (envelope.event.kind === 'text.delta' && envelope.event.content !== undefined) {
          upsertStream(envelope.event.content, false)
        }
        if (envelope.event.kind === 'assistant.message' && envelope.event.content?.trim()) {
          upsertStream(envelope.event.content, true)
        }
        if (envelope.event.kind === 'turn.completed' || envelope.event.kind === 'turn.failed') {
          void refreshConversationTranscript(envelope.sessionId, queueKey, world.id).finally(() => {
            setStreamingReplies((current) => {
              if (current[streamId] === undefined) return current
              const next = { ...current }
              delete next[streamId]
              return next
            })
          })
        }
      } catch {
        // Ignore malformed transient data; the durable transcript remains authoritative.
      }
    }
    return subscribeWorldLive(world.id, 'runtime', onRuntime)
  }, [activeWorld, bindConversationSession, refreshConversationTranscript])

  useEffect(() => {
    if (demoMode || activeWorld === undefined || pendingTurns.length === 0) return
    const world = activeWorld
    const reconcile = () => {
      for (const turn of pendingTurnsRef.current) {
        if (turn.worldId !== world.id || (turn.status !== 'queued' && turn.status !== 'running')) continue
        const sessionId = turn.sessionId ?? sessionByQueueKeyRef.current.get(turn.queueKey)
        if (sessionId !== undefined) void refreshConversationTranscript(sessionId, turn.queueKey, world.id)
      }
    }
    const timer = window.setInterval(reconcile, 900)
    return () => window.clearInterval(timer)
  }, [activeWorld, demoMode, pendingTurns.length, refreshConversationTranscript])

  // Authority changes are world-scoped facts. Reuse the shared /live stream so
  // another tab can update badges without reloading messages or dossiers.
  useEffect(() => {
    const worldId = activeWorld?.id
    if (demoMode || worldId === undefined) return
    const onWorldState = (event: Event) => {
      try {
        const envelope = JSON.parse((event as MessageEvent<string>).data) as { worldId?: string; payload?: unknown; authorities?: unknown }
        if (envelope.worldId !== undefined && envelope.worldId !== worldId) return
        // Pending decisions are refreshed by the `world-decision` stream, not
        // by every world-state envelope: this handler fires once per streamed
        // token, so refetching here turned one character turn into dozens of
        // requests for a list that had not changed.
        const payload = envelope.payload
        const raw = envelope.authorities ?? (payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>).authorities : undefined)
        if (!Array.isArray(raw)) return
        const next = raw.filter((value): value is WorldCharacterAuthority => isWorldCharacterAuthority(value) && value.worldId === worldId)
        if (next.length === 0 && raw.length > 0) return
        const authorityByEmployee = new Map(next.map((authority) => [authority.employeeId, authority]))
        setAuthorities(next)
        setEmployees((current) => current.map((employee) => applyAuthorityToEmployee(employee, authorityByEmployee.get(employee.id))))
      } catch {
        // Runtime stream payloads are intentionally tolerant; HTTP remains authoritative.
      }
    }
    return subscribeWorldLive(worldId, 'world-state', onWorldState)
  }, [activeWorld, demoMode, refreshPendingDecisions])

  // Pending decisions refresh when a decision actually moves. The world-state
  // snapshot fires once per streamed token and says nothing about decisions.
  useEffect(() => {
    const worldId = activeWorld?.id
    if (demoMode || worldId === undefined) return
    const onDecision = (event: Event) => {
      try {
        const envelope = JSON.parse((event as MessageEvent<string>).data) as { worldId?: string }
        if (envelope.worldId !== undefined && envelope.worldId !== worldId) return
      } catch {
        // A malformed envelope still means something changed; refresh anyway.
      }
      void refreshPendingDecisions(worldId)
    }
    return subscribeWorldLive(worldId, 'world-decision', onDecision)
  }, [activeWorld, demoMode, refreshPendingDecisions])

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
      setError(cause instanceof Error ? cause.message : '角色信息加载失败')
    }
  }, [demoMode])

  const directEmployee = useCallback((employee: CyberEmployee) => {
    const existing = sessions.find((session) => session.kind === 'direct' && (
      sessionParticipants[session.id]?.includes(employee.id) === true ||
      (sessionParticipants[session.id]?.length ?? 0) === 0 && session.title.includes(employee.displayName)
    ))
    if (existing?.id === activeSessionId) {
      setConversationIntent(undefined)
      setDraft('')
      setSelectedEmployeeId(employee.id)
      if (!demoMode && messages.length === 0) setTranscriptReload((value) => value + 1)
      return
    }
    setActiveSessionId(existing?.id)
    setConversationIntent(existing === undefined ? {
      kind: 'direct',
      employeeIds: [employee.id],
      title: `与 ${employee.displayName} 对话`,
    } : undefined)
    setMessages([])
    setMessagePage({ hasMore: false, loading: false })
    setDraft('')
    setSelectedEmployeeId(employee.id)
  }, [activeSessionId, messages.length, sessionParticipants, sessions])

  const createGroupSession = useCallback(async (input: { title: string; employeeIds: string[] }) => {
    const world = activeWorld
    const selected = employees.filter((employee) => input.employeeIds.includes(employee.id))
    if (world === undefined || selected.length < 2 || groupCreating) return
    setGroupCreating(true)
    setError(undefined)
    try {
      const title = input.title.trim() || selected.map((employee) => employee.displayName).join('、')
      let session: WorkSession
      let participantIds = selected.map((employee) => employee.id)
      if (demoMode) {
        session = makeDemoSession(world, title, 'group', title)
      } else {
        const result = await api<{ session: WorkSession; participantIds: string[] }>(`/api/worlds/${encodeURIComponent(world.id)}/group-sessions`, {
          method: 'POST',
          body: JSON.stringify({ title, employeeIds: participantIds }),
        })
        session = result.session
        participantIds = result.participantIds
      }
      setSessions((current) => [session, ...current.filter((item) => item.id !== session.id)])
      setSessionParticipants((current) => ({ ...current, [session.id]: participantIds }))
      setActiveSessionId(session.id)
      setGroupDialogOpen(false)
      setConversationIntent(undefined)
      setMessages([])
      setMessagePage({ hasMore: false, loading: false })
      setDraft('')
      setSelectedEmployeeId(selected[0]?.id)
      setAppMode('workbench')
      setDockCollapsed(false)
      setDockTab('world')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '群聊创建失败')
    } finally {
      setGroupCreating(false)
    }
  }, [activeWorld, demoMode, employees, groupCreating])

  const openRecruitment = useCallback(async (preferredId?: string) => {
    if (activeWorld === undefined) return
    setPreferredBlueprintId(preferredId)
    setRecruitmentOpen(true)
    setCatalogLoading(true)
    setError(undefined)
    try {
      const result = await api<{ items: EmployeeBlueprint[] }>(`/api/catalog/blueprints?templateId=${encodeURIComponent(activeWorld.templateId)}&worldId=${encodeURIComponent(activeWorld.id)}`)
      setBlueprints(result.items)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '角色市场加载失败')
    } finally {
      setCatalogLoading(false)
    }
  }, [activeWorld])

  const refreshWorldAuthorities = useCallback(async (worldId: string): Promise<WorldCharacterAuthority[]> => {
    if (demoMode) return authorities
    const result = await api<{ worldId: string; authorities: WorldCharacterAuthority[] }>(`/api/worlds/${encodeURIComponent(worldId)}/authorities`)
    if (activeWorldRef.current?.id === worldId) {
      const authorityByEmployee = new Map(result.authorities.map((authority) => [authority.employeeId, authority]))
      setAuthorities(result.authorities)
      setEmployees((current) => current.map((employee) => applyAuthorityToEmployee(employee, authorityByEmployee.get(employee.id))))
    }
    return result.authorities
  }, [authorities, demoMode])

  const updateWorldAuthority = useCallback(async (employeeId: string, input: { role: WorldCharacterRole; permissionGrants: WorldCharacterPermission[]; reason: string }): Promise<void> => {
    const world = activeWorldRef.current
    if (world === undefined) return
    setSavingEmployee(true)
    setError(undefined)
    try {
      let authority: WorldCharacterAuthority
      if (demoMode) {
        const previous = authorities.find((item) => item.employeeId === employeeId)
        const timestamp = new Date().toISOString()
        authority = {
          worldId: world.id,
          employeeId,
          role: input.role,
          permissionGrants: input.permissionGrants,
          createdAt: previous?.createdAt ?? timestamp,
          updatedAt: timestamp,
        }
      } else {
        const result = await api<{ authority: WorldCharacterAuthority }>(`/api/worlds/${encodeURIComponent(world.id)}/authorities/${encodeURIComponent(employeeId)}`, {
          method: 'PUT',
          body: JSON.stringify(input),
        })
        authority = result.authority
      }
      setAuthorities((current) => [...current.filter((item) => item.employeeId !== employeeId), authority])
      setEmployees((current) => current.map((employee) => employee.id === employeeId ? applyAuthorityToEmployee(employee, authority) : employee))
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '世界权限保存失败'
      setError(message)
      throw cause
    } finally {
      setSavingEmployee(false)
    }
  }, [authorities, demoMode])

  const loadPackages = useCallback(async () => {
    if (workspace === undefined || demoMode) return
    const result = await api<{ items: InstalledPackage[]; transactions: PackageInstallTransaction[] }>(`/api/workspaces/${workspace.id}/packages`)
    setInstalledPackages(result.items)
    setPackageTransactions(result.transactions)
  }, [demoMode, workspace])

  const loadInstalledPluginCommands = useCallback(async () => {
    if (activeWorld === undefined || demoMode) return
    const result = await api<{ items: InstalledPluginCommand[] }>(`/api/worlds/${activeWorld.id}/plugins`)
    setInstalledPluginCommands(result.items)
  }, [activeWorld, demoMode])

  useEffect(() => {
    if (demoMode || activeWorld === undefined) return
    void loadInstalledPluginCommands().catch(() => setInstalledPluginCommands([]))
  }, [activeWorld, demoMode, loadInstalledPluginCommands])

  const searchMarketplace = useCallback(async (market: CyberMarketKind, query = '') => {
    if (workspace === undefined) return
    const result = await api<{ items: CyberMarketPackage[] }>(`/api/marketplace?market=${market}&workspaceId=${encodeURIComponent(workspace.id)}${activeWorld === undefined ? '' : `&worldId=${encodeURIComponent(activeWorld.id)}`}&q=${encodeURIComponent(query)}`)
    setMarketplaceItems(result.items)
  }, [activeWorld, workspace])

  const openPackageMarket = useCallback(async (market: CyberMarketKind = 'theme') => {
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
          body: JSON.stringify({ ...input, ...(activeWorld === undefined || input.manifest.kind === 'world-theme' ? {} : { worldId: activeWorld.id }) }),
        })
        await Promise.all([loadPackages(), loadInstalledPluginCommands()])
      }
    } finally {
      setPackageInstalling(false)
    }
  }, [activeWorld, demoMode, loadInstalledPluginCommands, loadPackages, workspace])

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
        const activation = item.activation
        if (item.market === 'plugin' && activation?.kind === 'prompt-transform') {
          setInstalledPluginCommands((current) => [
            ...current.filter((command) => command.packageId !== item.manifest.id),
            ...activation.commands.map((command) => ({
              packageId: item.manifest.id,
              packageVersion: item.manifest.version,
              displayName: item.manifest.displayName,
              summary: item.manifest.summary,
              trigger: command.trigger,
              displayTrigger: localizedPluginTrigger(item.manifest.id, command.trigger),
              description: command.description,
              automatic: activation.automatic,
            })),
          ])
        }
        setMarketplaceItems((current) => current.map((candidate) => candidate.manifest.id === item.manifest.id
          ? { ...candidate, installedVersion: item.manifest.version,
              ...(item.market === 'theme' ? {} : { worldVersion: item.manifest.version }) }
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
          body: JSON.stringify({ packageId: item.manifest.id, version: item.manifest.version, approvalToken,
            ...(item.market === 'theme' || activeWorld === undefined ? {} : { worldId: activeWorld.id }) }),
        })
        await Promise.all([loadPackages(), searchMarketplace(item.market), item.market === 'plugin' ? loadInstalledPluginCommands() : Promise.resolve()])
      }
    } finally {
      setPackageInstalling(false)
    }
  }, [activeWorld, demoMode, installPackage, loadInstalledPluginCommands, loadPackages, searchMarketplace, workspace])

  const uninstallPackage = useCallback(async (installed: InstalledPackage) => {
    if (workspace === undefined) throw new Error('工作区尚未就绪')
    setPackageInstalling(true)
    try {
      if (demoMode) {
        setInstalledPackages((current) => current.map((item) => item.packageId === installed.packageId && item.version === installed.version ? { ...item, status: 'disabled' } : item))
        setInstalledPluginCommands((current) => current.filter((command) => command.packageId !== installed.packageId))
        setMarketplaceItems((current) => current.map((item) => {
          if (item.manifest.id !== installed.packageId) return item
          const next = { ...item }
          delete next.installedVersion
          delete next.worldVersion
          return next
        }))
      } else {
        await api(`/api/workspaces/${encodeURIComponent(workspace.id)}/packages/${encodeURIComponent(installed.packageId)}`, { method: 'DELETE' })
        await Promise.all([loadPackages(), searchMarketplace(packageMarketKind), loadInstalledPluginCommands()])
      }
    } finally {
      setPackageInstalling(false)
    }
  }, [demoMode, loadInstalledPluginCommands, loadPackages, packageMarketKind, searchMarketplace, workspace])

  const openIntegrationSettings = useCallback(() => {
    setPackageMarketOpen(false)
    setSettingsSection('integrations')
    setSettingsOpen(true)
  }, [])

  const recruitEmployee = useCallback(async (
    blueprint: EmployeeBlueprint,
    displayName: string | undefined,
    skillGrants: string[],
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
            skillGrants,
            capabilityGrants,
            ...(displayName === undefined ? {} : { displayName }),
          }),
        })
        employee = result.employee
      }
      const mapped = toCyberEmployee(employee, employees.length)
      setEmployees((current) => [...current, mapped])
      setRecruitmentOpen(false)
      setPreferredBlueprintId(undefined)
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
      setError(cause instanceof Error ? cause.message : '角色设定保存失败')
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

  const selectSession = useCallback((sessionId: string, discoveredSession?: WorkSession, discoveredParticipantIds: string[] = []) => {
    if (discoveredSession !== undefined) {
      setSessions((current) => current.some((session) => session.id === sessionId)
        ? current
        : [discoveredSession, ...current])
    }
    if (discoveredParticipantIds.length > 0) {
      setSessionParticipants((current) => current[sessionId] !== undefined
        ? current
        : { ...current, [sessionId]: discoveredParticipantIds })
    }
    const participantIds = sessionParticipants[sessionId] ?? discoveredParticipantIds
    if (sessionId === activeSessionId) {
      setConversationIntent(undefined)
      setDraft('')
      setSelectedEmployeeId(participantIds[0])
      if (!demoMode && messages.length === 0) setTranscriptReload((value) => value + 1)
      return
    }
    setConversationIntent(undefined)
    setActiveSessionId(sessionId)
    setMessagePage({ hasMore: false, loading: false })
    if (!demoMode) setMessages([])
    setDraft('')
    setSelectedEmployeeId(participantIds[0])
    if (demoMode) {
      const next = demoMessagesForSession(sessionId)
      setMessages(next.slice(-MESSAGE_PAGE_SIZE))
      setMessagePage({ hasMore: next.length > MESSAGE_PAGE_SIZE, loading: false })
    }
  }, [activeSessionId, messages.length, sessionParticipants])

  const loadOlderMessages = useCallback(async () => {
    if (activeSessionId === undefined || messagePage.loading) return
    const sessionId = activeSessionId
    const worldId = activeWorldRef.current?.id
    const transcriptRequestId = transcriptLoadRequestRef.current
    const loaded = messages.filter(isChatMessage)
    const firstSequence = loaded.reduce<number | undefined>((minimum, message) => minimum === undefined ? message.sequence : Math.min(minimum, message.sequence), undefined)
    if (firstSequence === undefined) return
    setMessagePage((current) => ({ ...current, loading: true }))
    try {
      if (demoMode) {
        const all = demoMessagesForSession(sessionId).filter(isChatMessage)
        const older = all.filter((message) => message.sequence < firstSequence).slice(-MESSAGE_PAGE_SIZE)
        setMessages((current) => mergeMessages(older, current))
        setMessagePage({ hasMore: all.some((message) => message.sequence < (older[0]?.sequence ?? firstSequence)), loading: false })
        return
      }
      const result = await api<{ items: WorkMessage[]; hasMore?: boolean }>(`/api/sessions/${encodeURIComponent(sessionId)}/messages?view=chat&limit=${MESSAGE_PAGE_SIZE}&before=${firstSequence}`)
      if (
        transcriptRequestId !== transcriptLoadRequestRef.current ||
        activeSessionIdRef.current !== sessionId ||
        activeWorldRef.current?.id !== worldId
      ) return
      setMessages((current) => mergeMessages(result.items, current))
      setMessagePage({ hasMore: result.hasMore === true, loading: false })
    } catch (cause) {
      if (
        transcriptRequestId !== transcriptLoadRequestRef.current ||
        activeSessionIdRef.current !== sessionId ||
        activeWorldRef.current?.id !== worldId
      ) return
      setMessagePage((current) => ({ ...current, loading: false }))
      setError(cause instanceof Error ? cause.message : '更早消息加载失败')
    }
  }, [activeSessionId, messagePage.loading, messages])

  const openMessageHistory = useCallback(() => {
    if (activeSession !== undefined) setHistoryOpen(true)
  }, [activeSession])

  // Decisions are durable facts. The unified pending-decisions refresh keeps
  // both approval gates and world-permission prompts in sync before resuming a turn.
  const decideWorldPermissionRequest = useCallback(async (requestId: string, scope: WorldPermissionDecisionScope | 'reject'): Promise<void> => {
    const worldId = activeWorldRef.current?.id
    await api(`/api/world-permission-requests/${encodeURIComponent(requestId)}/decision`, {
      method: 'POST',
      body: JSON.stringify({ decisionScope: scope, decidedBy: 'owner' }),
    })
    setPendingWorldPermissionRequests((current) => current.filter((request) => request.id !== requestId))
    if (worldId === undefined) return
    if (scope === 'persistent') await refreshWorldAuthorities(worldId)
    await refreshPendingDecisions(worldId)
    if (activeSessionIdRef.current !== undefined) {
      const queueKey = queueKeyBySessionRef.current.get(activeSessionIdRef.current) ?? activeSessionIdRef.current
      await refreshConversationTranscript(activeSessionIdRef.current, queueKey, worldId)
    }
  }, [refreshConversationTranscript, refreshPendingDecisions, refreshWorldAuthorities])

  const decideApproval = useCallback(async (
    approvalId: string,
    decision: 'approved' | 'rejected',
    scope: ApprovalScope,
  ): Promise<void> => {
    const worldId = activeWorld?.id
    await api(`/api/approvals/${approvalId}/decision`, { method: 'POST', body: JSON.stringify({ decision, scope }) })
    if (worldId === undefined) return
    await refreshPendingDecisions(worldId)
    // A decision usually settles the stalled turn, so pull the durable
    // transcript rather than waiting for the next stream event.
    if (activeSessionId !== undefined) await refreshConversationTranscript(activeSessionId, activeSessionId, worldId)
  }, [activeSessionId, activeWorld, refreshConversationTranscript, refreshPendingDecisions])

  useEffect(() => {
    const worldId = activeWorld?.id
    if (demoMode || worldId === undefined) {
      setPendingApprovals([])
      return
    }
    void refreshPendingDecisions(worldId)
    // The stream is the primary signal. This is a safety net for a dropped
    // connection, not the mechanism — but it must stay, because a decision
    // surface that silently shows nothing is worse than one that is late.
    const timer = setInterval(() => { void refreshPendingDecisions(worldId) }, 30_000)
    return () => clearInterval(timer)
  }, [activeWorld, demoMode, refreshPendingDecisions])

  const send = useCallback((prompt: string, attachments: ChatAttachment[]): Promise<void> => {
    const world = activeWorld
    if (world === undefined) return Promise.resolve()
    const explicitEmployeeIds = conversationIntent?.employeeIds
      ?? (activeSessionId === undefined ? [] : sessionParticipants[activeSessionId] ?? [])
    const mentioned = employees.filter((employee) => prompt.includes(`@${employee.displayName}`))
    const targetIds = explicitEmployeeIds.length > 0 ? explicitEmployeeIds : mentioned.map((employee) => employee.id)
    if (targetIds.length === 0) {
      setError('请选择或 @ 至少一个角色')
      return Promise.resolve()
    }

    const title = conversationIntent?.title
      ?? activeSession?.title
      ?? (targetIds.length === 1
        ? `与 ${employees.find((employee) => employee.id === targetIds[0])?.displayName ?? '角色'} 对话`
        : compactPrompt(prompt))
    const queueKey = activeConversationKey ?? targetConversationQueueKey(targetIds, title)
    const clientTurnId = crypto.randomUUID()
    const createdAt = new Date().toISOString()
    const capturedSessionId = activeSessionId
    const interactionKind = conversationIntent?.kind === 'group' || targetIds.length > 1
      ? 'meeting'
      : /(?:^|\s)任务[：:]/.test(prompt) ? 'task' : 'chat'
    if (capturedSessionId !== undefined) {
      sessionByQueueKeyRef.current.set(queueKey, capturedSessionId)
      queueKeyBySessionRef.current.set(capturedSessionId, queueKey)
    }

    const pendingTurn: PendingChatTurn = {
      id: clientTurnId,
      queueKey,
      worldId: world.id,
      employeeIds: targetIds,
      title,
      status: 'queued',
      createdAt,
      ...(capturedSessionId === undefined ? {} : { sessionId: capturedSessionId }),
    }
    const optimisticMessage: WorkMessage = {
      id: `local-owner-${clientTurnId}`,
      sessionId: capturedSessionId ?? `pending-${clientTurnId}`,
      sequence: Number.MAX_SAFE_INTEGER,
      senderId: 'owner',
      senderKind: 'owner',
      kind: 'user',
      content: prompt,
      metadata: {
        clientTurnId,
        localPending: true,
        displayTime: new Date(createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
        participantIds: targetIds,
        ...(attachments.length === 0 ? {} : { attachments: serializableAttachments(attachments) }),
      },
      createdAt,
    }

    setDraft('')
    setError(undefined)
    setPendingTurns((current) => {
      const next = [...current, pendingTurn]
      pendingTurnsRef.current = next
      return next
    })
    setOutboxMessages((current) => ({
      ...current,
      [queueKey]: [...(current[queueKey] ?? []), optimisticMessage],
    }))

    const runTurn = async () => {
      patchPendingTurn(clientTurnId, { status: 'running' })
      try {
        const resolvedSessionId = sessionByQueueKeyRef.current.get(queueKey) ?? capturedSessionId
        if (demoMode) {
          const session = resolvedSessionId === undefined
            ? makeDemoSession(world, prompt, targetIds.length > 1 ? 'group' : 'direct', title)
            : {
                id: resolvedSessionId,
                workspaceId: world.workspaceId,
                worldId: world.id,
                kind: targetIds.length > 1 ? 'group' as const : 'direct' as const,
                title,
                status: 'open' as const,
                createdAt,
                updatedAt: new Date().toISOString(),
              }
          bindConversationSession(queueKey, session, targetIds)
          await delay(650)
          const targets = targetIds
            .map((id) => employees.find((employee) => employee.id === id))
            .filter((employee): employee is CyberEmployee => employee !== undefined)
          const ownerMessage = makeDemoMessage(session.id, Date.now(), 'owner', 'owner', 'user', prompt, {
            clientTurnId,
            participantIds: targetIds,
            ...(attachments.length === 0 ? {} : { attachments: serializableAttachments(attachments) }),
          })
          const replies = targets.map((employee, index) => makeDemoMessage(
            session.id,
            Date.now() + index + 1,
            employee.id,
            'employee',
            'assistant',
            worldExperience(world).kind === 'tavern'
              ? tavernDemoReply(employee, prompt)
              : `${employee.displayName}收到。我会以${employee.role}的职责独立处理“${compactPrompt(prompt)}”，完成后给出证据、产物和下一步。`,
            { clientTurnId },
          ))
          if (activeWorldRef.current?.id === world.id && activeConversationKeyRef.current === queueKey) {
            setMessages((current) => [...current.filter((message) => messageClientTurnId(message) !== clientTurnId), ownerMessage, ...replies])
          }
          setOutboxMessages((current) => removeOutboxTurn(current, queueKey, clientTurnId))
          removePendingTurn(clientTurnId)
          return
        }

        const result = await api<ChatResult>(`/api/worlds/${world.id}/chat`, {
          method: 'POST',
          body: JSON.stringify({
            prompt,
            clientTurnId,
            reasoningEffort,
            permissionMode,
            interactionKind,
            ...(attachments.length === 0 ? {} : { attachments }),
            employeeIds: targetIds,
            ...(conversationIntent === undefined ? {} : { title }),
            ...(resolvedSessionId === undefined ? {} : { sessionId: resolvedSessionId }),
          }),
        })
        bindConversationSession(queueKey, result.session, targetIds)
        await refreshConversationTranscript(result.session.id, queueKey, world.id, true)
        setStreamingReplies((current) => removeStreamingTurn(current, clientTurnId))
        removePendingTurn(clientTurnId)
      } catch (cause) {
        const failure = cause instanceof Error ? cause.message : '消息发送失败'
        const failedSessionId = sessionByQueueKeyRef.current.get(queueKey) ?? capturedSessionId
        if (failedSessionId !== undefined && !demoMode) {
          await refreshConversationTranscript(failedSessionId, queueKey, world.id)
        }
        patchPendingTurn(clientTurnId, {
          status: 'failed',
          error: failure,
          ...(failedSessionId === undefined ? {} : { sessionId: failedSessionId }),
        })
        setStreamingReplies((current) => removeStreamingTurn(current, clientTurnId))
        if (activeWorldRef.current?.id === world.id && activeConversationKeyRef.current === queueKey) setError(failure)
      }
    }

    void turnQueueRef.current.enqueue(queueKey, runTurn)
    return Promise.resolve()
  }, [
    activeConversationKey,
    activeSession,
    activeSessionId,
    activeWorld,
    bindConversationSession,
    conversationIntent,
    employees,
    patchPendingTurn,
    permissionMode,
    reasoningEffort,
    refreshConversationTranscript,
    removePendingTurn,
    sessionParticipants,
  ])

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
    } catch (cause) { setError(cause instanceof Error ? cause.message : '日程创建失败'); throw cause }
    finally { setScheduleBusy(false) }
  }, [activeWorld])

  const updateTaskScheduleStatus = useCallback(async (item: TaskSchedule, status: 'active' | 'paused') => {
    if (activeWorld === undefined) return
    setScheduleBusy(true); setError(undefined)
    try {
      const result = await api<{ item: TaskSchedule }>(`/api/worlds/${activeWorld.id}/schedules/${item.id}`, { method: 'PATCH', body: JSON.stringify({ status }) })
      setTaskSchedules((current) => current.map((value) => value.id === item.id ? result.item : value))
    } catch (cause) { setError(cause instanceof Error ? cause.message : '日程更新失败') }
    finally { setScheduleBusy(false) }
  }, [activeWorld])

  const runTaskSchedule = useCallback(async (item: TaskSchedule) => {
    if (activeWorld === undefined) return
    setScheduleBusy(true); setError(undefined)
    try {
      const result = await api<{ run: { status: string; errorCode?: string } }>(`/api/worlds/${activeWorld.id}/schedules/${item.id}/run`, { method: 'POST', body: '{}' })
      if (result.run.status === 'failed') setError(`日程执行失败：${scheduleErrorLabel(result.run.errorCode)}`)
      await refreshTaskSchedules()
    } catch (cause) { setError(cause instanceof Error ? cause.message : '日程执行失败') }
    finally { setScheduleBusy(false) }
  }, [activeWorld, refreshTaskSchedules])

  const deleteTaskSchedule = useCallback(async (item: TaskSchedule) => {
    if (activeWorld === undefined) return
    setScheduleBusy(true); setError(undefined)
    try {
      await api(`/api/worlds/${activeWorld.id}/schedules/${item.id}`, { method: 'DELETE' })
      setTaskSchedules((current) => current.filter((value) => value.id !== item.id))
    } catch (cause) { setError(cause instanceof Error ? cause.message : '日程删除失败') }
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
      if (action === 'check-application-update' || action === 'apply-application-update') return { ok: true, applicationUpdate: { supported: true, channel: 'main', currentRevision: '1234567890abcdef', targetRevision: action === 'check-application-update' ? 'abcdef1234567890' : 'abcdef1234567890', commitsBehind: action === 'check-application-update' ? 3 : 0, updateAvailable: action === 'check-application-update' }, restartRequired: action === 'apply-application-update' }
      return { ok: true, checkedAt: new Date().toISOString(), compatibility: { expectedVersion: '0.1.1-rc.1', errors: [] }, database: { schemaVersion: 5, integrity: ['ok'], errors: [] } }
    }
    if (action === 'status') return api<SystemActionResult>('/api/system/status')
    if (action === 'doctor') return api<SystemActionResult>('/api/system/doctor', { method: 'POST', body: '{}' })
    if (action === 'backup') return api<SystemActionResult>('/api/system/backup', { method: 'POST', body: '{}' })
    if (action === 'export') return api<SystemActionResult>('/api/system/export', { method: 'POST', body: '{}' })
    if (action === 'check-application-update') return api<SystemActionResult>('/api/system/application-update')
    return api<SystemActionResult>('/api/system/application-update/apply', { method: 'POST', body: JSON.stringify({ approved: input?.approved === true }) })
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
  const administratorCount = authorities.filter((authority) => authority.role === 'administrator').length

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
        {administratorCount > 0 ? <div className="topbar-world-authority" aria-label={`${administratorCount} 名世界管理员`}><span>{administratorCount} 名世界管理员</span></div> : null}
        <nav aria-label="全局功能">
          <CreativeWorkshopLauncher workspaceId={workspace.id} onCreated={(project) => void openWorkshopWorld(project.worldId)} onOpenWorld={(worldId) => void openWorkshopWorld(worldId)} />
          <button type="button" onClick={() => void openPackageMarket('theme')}><Storefront size={16} />市场</button>
          <button type="button" onClick={() => { setSettingsSection('maintenance'); setSettingsOpen(true) }}><Pulse size={16} /><span>系统状态</span><i className="health-indicator" />良好</button>
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
            activityPulse={messages.length}
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
            messages={chatMessages}
            employees={employees}
            installedPlugins={installedPluginCommands}
            pendingCount={activePendingCount}
            queuedCount={activeQueuedCount}
            draft={draft}
            focusRequest={composerFocusRequest}
            onDraftChange={setDraft}
            onSend={send}
            onUploadAttachment={uploadChatAttachment}
            onOpenDossier={(employeeId) => void openDossier(employeeId)}
            onOpenArtifact={() => { setAppMode('world'); setDockCollapsed(false); setDockTab('world') }}
            onRecruit={() => { setSelectedEmployeeId(undefined); setDockCollapsed(false); setDockTab('dossier') }}
            onOpenPluginMarket={() => void openPackageMarket('plugin')}
            onOpenHistory={openMessageHistory}
            hasOlderMessages={messagePage.hasMore}
            loadingOlderMessages={messagePage.loading}
            onLoadOlderMessages={() => void loadOlderMessages()}
            approvals={pendingApprovals}
            onDecideApproval={decideApproval}
            permissionRequests={pendingWorldPermissionRequests}
            onDecideWorldPermissionRequest={decideWorldPermissionRequest}
            onOpenWorldPermissionSettings={(employeeId) => {
              setWorldSettingsOpen(false)
              setManagingEmployeeSection('permissions')
              setManagingEmployeeId(employeeId)
            }}
          />
        )}
        right={(
          <Suspense fallback={<div className="world-runtime world-runtime--loading"><strong>正在加载工作区</strong></div>}><ArtifactDock
            demoMode={demoMode}
            activeTab={dockTab}
            {...(selectedEmployee === undefined ? {} : { selectedEmployee })}
            dossiers={dossiers}
            employees={employees}
            world={activeWorld}
            {...(backgroundImage === undefined ? {} : { sceneImage: backgroundImage })}
            {...(supportsWorldRuntime ? {
              worldContent: (
                <Suspense fallback={<div className="world-runtime world-runtime--loading"><strong>正在进入世界</strong><span>加载互动场景与角色状态</span></div>}>
                  <WorldRuntimeDock
                  key={`${activeWorld.id}:${worldRuntimeRevision}`}
                  demoMode={demoMode}
                  world={activeWorld}
                  employees={employees}
                  liveEnabled={!historyOpen}
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
            setMessagePage({ hasMore: false, loading: false })
            setAppMode('workbench')
            setDockCollapsed(false)
            setDockTab('world')
            return
          }
          void createGroupSession({ employeeIds: selected.map((employee) => employee.id), title: selected.map((employee) => employee.displayName).join('、') })
        }}
                  />
                </Suspense>
              ),
            } : {})}
            traceContent={<Suspense fallback={<div className="world-runtime world-runtime--loading"><strong>正在加载轨迹</strong></div>}><WorldTracePanel key={activeWorld.id} world={activeWorld} employees={employees} demoMode={demoMode} /></Suspense>}
            scheduleContent={<Suspense fallback={<div className="world-runtime world-runtime--loading"><strong>正在加载日程</strong></div>}><TaskSchedulePanel employees={employees} items={taskSchedules} busy={scheduleBusy} onCreate={createTaskSchedule} onStatus={updateTaskScheduleStatus} onRun={runTaskSchedule} onDelete={deleteTaskSchedule} /></Suspense>}
            onTabChange={(tab) => { setDockTab(tab); setAppMode(tab === 'world' ? 'world' : 'workbench') }}
            onCollapse={() => setDockCollapsed(true)}
            onSelectEmployee={(employeeId) => void openDossier(employeeId)}
            onDirectEmployee={directEmployee}
            onManageEmployee={(employee) => { setManagingEmployeeSection('profile'); setManagingEmployeeId(employee.id) }}
            onShowAllDossiers={() => setSelectedEmployeeId(undefined)}
            onInvite={() => void openRecruitment()}
          /></Suspense>
        )}
      />
      {dockCollapsed ? <button className="dock-reopen" type="button" onClick={() => setDockCollapsed(false)} aria-label="展开侧边栏"><SidebarSimple size={18} /></button> : null}
      {groupDialogOpen ? (
        <Suspense fallback={<div className="dialog-loading" role="status">正在准备群聊…</div>}><GroupConversationDialog
          employees={employees}
          creating={groupCreating}
          onClose={() => setGroupDialogOpen(false)}
          onCreate={createGroupSession}
        /></Suspense>
      ) : null}
      {historyOpen && activeSession !== undefined ? (
        <Suspense fallback={<div className="dialog-loading" role="status">正在打开历史消息…</div>}><MessageHistoryDialog
          demoMode={demoMode}
          session={activeSession}
          employees={employees}
          {...(demoMode ? { demoMessages: demoMessagesForSession(activeSession.id) } : {})}
          onClose={() => setHistoryOpen(false)}
        /></Suspense>
      ) : null}
      {settingsOpen ? (
        <Suspense fallback={<div className="dialog-loading" role="status">正在打开设置…</div>}><SettingsDialog
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
        /></Suspense>
      ) : null}
      {recruitmentOpen ? (
        <Suspense fallback={<div className="dialog-loading" role="status">正在打开角色档案…</div>}><RecruitmentDialog
          blueprints={blueprints}
          {...(preferredBlueprintId === undefined ? {} : { initialBlueprintId: preferredBlueprintId })}
          employees={employees}
          world={activeWorld}
          loading={catalogLoading}
          recruiting={recruiting}
          onClose={() => { setRecruitmentOpen(false); setPreferredBlueprintId(undefined) }}
          onRecruit={recruitEmployee}
        /></Suspense>
      ) : null}
      {packageMarketOpen ? (
        <Suspense fallback={<div className="dialog-loading" role="status">正在打开市场…</div>}><PackageMarketDialog
          initialMarket={packageMarketKind}
          world={activeWorld}
          worlds={worlds}
          items={marketplaceItems}
          installed={installedPackages}
          transactions={packageTransactions}
          loading={packageLoading}
          installing={packageInstalling}
          onClose={() => setPackageMarketOpen(false)}
          onPreview={previewPackage}
          onInstall={installPackage}
          onSearch={searchMarketplace}
          onPreviewMarketplace={previewMarketplacePackage}
          onInstallMarketplace={installMarketplacePackage}
          onUninstall={uninstallPackage}
          onOpenSettings={openIntegrationSettings}
          onCreateThemeWorld={createWorldFromTheme}
          onRecruitTalent={async (item) => {
            const activation = item.activation?.kind === 'employee-blueprint' ? item.activation : undefined
            if (activation === undefined) throw new Error('这份角色模板没有可用的招募入口')
            setPackageMarketOpen(false)
            await openRecruitment(activation.blueprintId)
          }}
          onUsePlugin={(command) => {
            setPackageMarketOpen(false)
            setDraft(`${command} `)
            setComposerFocusRequest((value) => value + 1)
          }}
        /></Suspense>
      ) : null}
      {worldSettingsOpen && activeWorld !== undefined && worldSettings !== undefined && worldAccess !== undefined ? (
        <Suspense fallback={<div className="dialog-loading" role="status">正在打开世界设置…</div>}>
          <WorldSettingsDialog
            world={activeWorld}
            value={worldSettings}
            models={models}
            employees={employees}
            authorities={authorities}
            saving={savingSettings}
            onClose={() => setWorldSettingsOpen(false)}
            onManageAdministrators={() => {
              setWorldSettingsOpen(false)
              setDockCollapsed(false)
              setDockTab('dossier')
            }}
            onManageEmployee={(employeeId) => {
              setWorldSettingsOpen(false)
              setManagingEmployeeSection('permissions')
              setManagingEmployeeId(employeeId)
            }}
            onSave={async (value) => {
              setSavingSettings(true)
              try {
                const body = worldSettingsRevision === undefined ? value : { ...value, expectedRevision: worldSettingsRevision }
                try {
                  const result = await api<{ settings: WorldSettings; revision?: number; settingsRevision?: number }>(`/api/worlds/${activeWorld.id}/settings`, {
                    method: 'PUT',
                    body: JSON.stringify(body),
                  })
                  setWorldSettings(result.settings)
                  setWorldSettingsRevision(result.revision ?? result.settingsRevision)
                  setReasoningEffort(result.settings.model.reasoningEffort)
                  setPermissionMode(result.settings.runtime.permissionMode)
                  applyWorldAppearance(result.settings)
                } catch (cause) {
                  if (!(cause instanceof ApiError) || cause.status !== 409) throw cause
                  try {
                    const latest = await api<{ settings: WorldSettings; revision?: number; settingsRevision?: number }>(`/api/worlds/${activeWorld.id}/settings`)
                    setWorldSettings(latest.settings)
                    setWorldSettingsRevision(latest.revision ?? latest.settingsRevision)
                  } catch {
                    // Keep the editor open with its current draft if the conflict refresh fails.
                  }
                  throw new Error('世界设置已被其他页面更新。已载入最新版本，请确认变更后再保存。')
                }
              } finally {
                setSavingSettings(false)
              }
            }}
          />
        </Suspense>
      ) : null}
      {lockedWorld !== undefined ? <Suspense fallback={<div className="dialog-loading" role="status">正在打开访问验证…</div>}><WorldUnlockDialog worldName={lockedWorld.name} onUnlock={async(password)=>{ await api(`/api/worlds/${lockedWorld.id}/access/unlock`,{method:'POST',body:JSON.stringify({password})}); const world=lockedWorld; setLockedWorld(undefined); await loadWorld(world) }} /></Suspense> : null}
      {managingEmployee !== undefined ? (
        <Suspense fallback={<div className="dialog-loading" role="status">正在打开角色设置…</div>}><EmployeeManagementDialog
          employee={managingEmployee}
          {...(managingDossier?.profile === undefined ? {} : { profile: managingDossier.profile })}
          {...(managingRevision === undefined ? {} : { currentRevision: managingRevision })}
          models={models}
          avatarIndex={managingEmployee.avatarIndex}
          authority={authorities.find((authority) => authority.employeeId === managingEmployee.id)}
          initialSection={managingEmployeeSection}
          saving={savingEmployee}
          onClose={() => setManagingEmployeeId(undefined)}
          onRevise={reviseEmployee}
          onAuthorityChange={(input) => updateWorldAuthority(managingEmployee.id, input)}
          onUpdateProfile={updateEmployeeProfile}
          onArchive={archiveEmployee}
        /></Suspense>
      ) : null}
    </div>
  )
}

function conversationQueueKey(
  intent: ConversationIntent | undefined,
  session: WorkSession | undefined,
  participantIds: string[],
  aliases: Map<string, string>,
): string | undefined {
  const kind = intent?.kind ?? session?.kind
  const ids = intent?.employeeIds ?? participantIds
  if (kind === 'direct' && ids[0] !== undefined) return `direct:${ids[0]}`
  if (session !== undefined) return aliases.get(session.id) ?? `session:${session.id}`
  if (intent !== undefined) return targetConversationQueueKey(intent.employeeIds, intent.title)
  return undefined
}

function targetConversationQueueKey(employeeIds: string[], title: string): string {
  if (employeeIds.length === 1) return `direct:${employeeIds[0]}`
  return `intent:group:${[...employeeIds].sort().join(',')}:${title.trim()}`
}

function demoMessagesForSession(sessionId: string): WorkMessage[] {
  const source = [...demoData.messages, ...demoTavernMessages]
  return source.filter((message) => message.sessionId === sessionId)
}

function mergeMessages(older: WorkMessage[], current: WorkMessage[]): WorkMessage[] {
  const byId = new Map<string, WorkMessage>()
  for (const message of [...older, ...current]) byId.set(message.id, message)
  return [...byId.values()].sort((left, right) => left.sequence - right.sequence)
}

function metadataText(value: JsonObject[string] | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function reconcileOutboxMessages(
  current: Record<string, WorkMessage[]>,
  queueKey: string,
  durableMessages: WorkMessage[],
): Record<string, WorkMessage[]> {
  const persistedTurnIds = new Set(durableMessages.flatMap((message) => {
    const clientTurnId = messageClientTurnId(message)
    return clientTurnId === undefined ? [] : [clientTurnId]
  }))
  const remaining = (current[queueKey] ?? []).filter((message) => {
    const clientTurnId = messageClientTurnId(message)
    return clientTurnId === undefined || !persistedTurnIds.has(clientTurnId)
  })
  if (remaining.length === (current[queueKey] ?? []).length) return current
  const next = { ...current }
  if (remaining.length === 0) delete next[queueKey]
  else next[queueKey] = remaining
  return next
}

function removeOutboxTurn(
  current: Record<string, WorkMessage[]>,
  queueKey: string,
  clientTurnId: string,
): Record<string, WorkMessage[]> {
  const remaining = (current[queueKey] ?? []).filter((message) => messageClientTurnId(message) !== clientTurnId)
  const next = { ...current }
  if (remaining.length === 0) delete next[queueKey]
  else next[queueKey] = remaining
  return next
}

function removeStreamingTurn(
  current: Record<string, StreamingChatReply>,
  clientTurnId: string,
): Record<string, StreamingChatReply> {
  const entries = Object.entries(current).filter(([, reply]) => reply.clientTurnId !== clientTurnId)
  return entries.length === Object.keys(current).length ? current : Object.fromEntries(entries)
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

function localizedPluginTrigger(packageId: string, trigger: string): string {
  const localized: Record<string, Record<string, string>> = {
    'official-decision-log': { '/decision-log': '/决策记录' },
    'official-meeting-notes': { '/meeting-summary': '/会议纪要' },
    'official-release-check': { '/release-check': '/发布检查' },
    'official-research-brief': { '/research-brief': '/研究简报' },
  }
  return localized[packageId]?.[trigger] ?? trigger
}

function toCyberEmployee(
  employee: EmployeeInstance,
  index: number,
  dossier?: EmployeeDossier,
  authority?: WorldCharacterAuthority,
): CyberEmployee {
  return {
    ...employee,
    avatarIndex: profileAvatarIndex(dossier) ?? stableAvatar(employee.id, index),
    summary: `${employee.role}独立 Agent，拥有自己的会话、记忆与成长记录。`,
    currentActivity: statusActivity(employee),
    ...(authority === undefined ? {} : {
      authorityRole: authority.role,
      worldPermissions: authority.permissionGrants,
    }),
  }
}

function demoAuthorities(world: World, employees: EmployeeInstance[]): WorldCharacterAuthority[] {
  const employeeId = world.administratorEmployeeId
    ?? employees.find((employee) => employee.blueprintId === 'core.butler')?.id
  if (employeeId === undefined) return []
  const timestamp = world.updatedAt
  return [{
    worldId: world.id,
    employeeId,
    role: 'administrator',
    permissionGrants: [...RECOMMENDED_ADMIN_PERMISSIONS],
    createdAt: timestamp,
    updatedAt: timestamp,
  }]
}

function applyAuthorityToEmployee(employee: CyberEmployee, authority: WorldCharacterAuthority | undefined): CyberEmployee {
  if (authority === undefined) {
    const next = { ...employee }
    delete next.authorityRole
    delete next.worldPermissions
    return next
  }
  return {
    ...employee,
    authorityRole: authority.role,
    worldPermissions: authority.permissionGrants,
  }
}

function isWorldCharacterAuthority(value: unknown): value is WorldCharacterAuthority {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.worldId === 'string'
    && typeof candidate.employeeId === 'string'
    && typeof candidate.createdAt === 'string'
    && typeof candidate.updatedAt === 'string'
    && typeof candidate.role === 'string'
    && isWorldCharacterRole(candidate.role)
    && Array.isArray(candidate.permissionGrants)
    && candidate.permissionGrants.every((permission) => typeof permission === 'string' && isWorldCharacterPermission(permission))
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

function activeWorldStorageKey(workspaceId: string): string {
  return `dsh-cyber.active-world:${workspaceId}`
}

function readRememberedWorldId(workspaceId: string): string | undefined {
  try {
    const value = window.localStorage.getItem(activeWorldStorageKey(workspaceId))
    return value === null || value.length === 0 ? undefined : value
  } catch {
    return undefined
  }
}

function rememberActiveWorld(workspaceId: string, worldId: string): void {
  try {
    window.localStorage.setItem(activeWorldStorageKey(workspaceId), worldId)
  } catch {
    // localStorage may be unavailable (private mode); restoring simply falls back to the first world.
  }
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

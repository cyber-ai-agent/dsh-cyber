import {
  Cube,
  GearSix,
  Pulse,
  SidebarSimple,
  Storefront,
} from '@phosphor-icons/react'
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react'
import type {
  AgentRuntimeEvent,
  CyberPackageManifest,
  EmployeeBlueprint,
  EmployeeDossier,
  EmployeeInstance,
  EmployeeRevision,
  InstalledPackage,
  ModelProfile,
  PackageInstallTransaction,
  PackagePermissionPreview,
  WorkMessage,
  WorkSession,
  Workspace,
  WorkspacePreferences,
  WorkspaceSnapshot,
  World,
  WorldSnapshot,
} from '@dsh-cyber/contracts'

import { api } from './api.js'
import { ArtifactDock } from './components/ArtifactDock.js'
import { ChatWorkbench } from './components/ChatWorkbench.js'
import { EmployeeManagementDialog } from './components/EmployeeManagementDialog.js'
import { NavigationPane } from './components/NavigationPane.js'
import { PackageMarketDialog } from './components/PackageMarketDialog.js'
import { RecruitmentDialog } from './components/RecruitmentDialog.js'
import { ResizableShell } from './components/ResizableShell.js'
import { SettingsDialog, type SettingsSection, type SystemAction, type SystemActionResult } from './components/SettingsDialog.js'
import { demoData } from './demo-data.js'
import type { CyberEmployee, DockTab, LiveAgentTurn } from './types.js'

const demoMode = new URLSearchParams(window.location.search).get('demo') === '1'

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
  const [messages, setMessages] = useState<WorkMessage[]>(demoMode ? demoData.messages : [])
  const [liveTurns, setLiveTurns] = useState<LiveAgentTurn[]>([])
  const [preferences, setPreferences] = useState<WorkspacePreferences | undefined>(demoMode ? demoData.preferences : undefined)
  const [models, setModels] = useState<ModelProfile[]>(demoMode ? demoData.modelProfiles : [])
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
  const [packageMarketOpen, setPackageMarketOpen] = useState(false)
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

  const activeSession = sessions.find((session) => session.id === activeSessionId)
  const selectedEmployee = employees.find((employee) => employee.id === selectedEmployeeId)
  const managingEmployee = employees.find((employee) => employee.id === managingEmployeeId)
  const managingDossier = managingEmployeeId === undefined ? undefined : dossiers[managingEmployeeId]
  const managingRevision = managingDossier?.revisions.find((revision) => revision.revision === managingEmployee?.currentRevision)

  const loadWorld = useCallback(async (world: World) => {
    setError(undefined)
    setActiveWorld(world)
    setActiveSessionId(undefined)
    setMessages([])
    setLiveTurns([])
    setDraft('')
    setSelectedEmployeeId(undefined)
    setDockTab('world')
    if (demoMode) {
      const isCompany = world.id === demoData.activeWorld.id
      setEmployees(isCompany ? demoData.employees : [])
      setSessions(isCompany ? demoData.sessions : [])
      setMessages(isCompany ? demoData.messages : [])
      setActiveSessionId(isCompany ? demoData.sessions[0]?.id : undefined)
      return
    }
    const snapshot = await api<WorldSnapshot>(`/api/worlds/${world.id}/snapshot`)
    const dossierResults = await Promise.all(snapshot.employees.map(async (employee) => {
      try {
        return await api<EmployeeDossier>(`/api/employees/${employee.id}/dossier`)
      } catch {
        return undefined
      }
    }))
    const nextDossiers: Record<string, EmployeeDossier> = {}
    for (const dossier of dossierResults) {
      if (dossier !== undefined) nextDossiers[dossier.employee.id] = dossier
    }
    setDossiers(nextDossiers)
    setEmployees(snapshot.employees.map((employee, index) => toCyberEmployee(employee, index, nextDossiers[employee.id])))
    setSessions(snapshot.openSessions)
  }, [])

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
          api<{ items: ModelProfile[] }>(`/api/workspaces/${first.id}/model-profiles`),
        ])
        if (cancelled) return
        setWorkspace(first)
        setWorlds(snapshot.worlds)
        setPreferences(preferenceResult.preferences)
        setModels(modelResult.items)
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
      .then((result) => { if (!cancelled) setMessages(result.items) })
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
        setLiveTurns((current) => reduceLiveTurn(current, envelope))
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
    setDockCollapsed(false)
    setDockTab('dossier')
    if (dossiers[employeeId] !== undefined || demoMode) return
    try {
      const dossier = await api<EmployeeDossier>(`/api/employees/${employeeId}/dossier`)
      setDossiers((current) => ({ ...current, [employeeId]: dossier }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '员工档案加载失败')
    }
  }, [dossiers])

  const directEmployee = useCallback((employee: CyberEmployee) => {
    setDraft((current) => `${current.replace(/\s*$/, '')}${current.trim() ? ' ' : ''}@${employee.displayName} `)
  }, [])

  const openRecruitment = useCallback(async () => {
    if (activeWorld === undefined) return
    setRecruitmentOpen(true)
    setCatalogLoading(true)
    setError(undefined)
    try {
      const result = await api<{ items: EmployeeBlueprint[] }>(`/api/catalog/blueprints?templateId=${encodeURIComponent(activeWorld.templateId)}`)
      setBlueprints(result.items)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '员工市场加载失败')
    } finally {
      setCatalogLoading(false)
    }
  }, [activeWorld])

  const loadPackages = useCallback(async () => {
    if (workspace === undefined || demoMode) return
    const result = await api<{ items: InstalledPackage[]; transactions: PackageInstallTransaction[] }>(`/api/workspaces/${workspace.id}/packages`)
    setInstalledPackages(result.items)
    setPackageTransactions(result.transactions)
  }, [workspace])

  const openPackageMarket = useCallback(async () => {
    setPackageMarketOpen(true)
    setPackageLoading(true)
    setError(undefined)
    try {
      await loadPackages()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '软件包清单加载失败')
    } finally {
      setPackageLoading(false)
    }
  }, [loadPackages])

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

  const recruitEmployee = useCallback(async (blueprint: EmployeeBlueprint, displayName?: string) => {
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
          body: JSON.stringify({ blueprintId: blueprint.id, blueprintVersion: blueprint.version, ...(displayName === undefined ? {} : { displayName }) }),
        })
        employee = result.employee
      }
      const mapped = toCyberEmployee(employee, employees.length)
      setEmployees((current) => [...current, mapped])
      setRecruitmentOpen(false)
      setDraft(`@${employee.displayName} `)
      if (!demoMode) {
        const dossier = await api<EmployeeDossier>(`/api/employees/${employee.id}/dossier`)
        setDossiers((current) => ({ ...current, [employee.id]: dossier }))
        setSelectedEmployeeId(employee.id)
        setDockTab('dossier')
        setDockCollapsed(false)
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

  const updateEmployeeProfile = useCallback(async (input: { displayName: string; avatarIndex: number }) => {
    if (managingEmployee === undefined) return
    setSavingEmployee(true)
    setError(undefined)
    try {
      const previous = dossiers[managingEmployee.id]?.profile
      let profile = previous
      if (demoMode) {
        profile = {
          employeeId: managingEmployee.id,
          revision: (previous?.revision ?? 0) + 1,
          background: previous?.background ?? managingEmployee.role,
          personalityTraits: previous?.personalityTraits ?? [],
          appearance: { ...(previous?.appearance ?? {}), avatarIndex: input.avatarIndex },
          reason: '更新员工名片与形象',
          createdAt: new Date().toISOString(),
          ...(previous?.birthday === undefined ? {} : { birthday: previous.birthday }),
        }
      } else {
        const result = await api<{ profile: EmployeeDossier['profile'] }>(`/api/employees/${managingEmployee.id}/profile`, {
          method: 'PUT',
          body: JSON.stringify({
            displayName: input.displayName,
            appearance: { ...(previous?.appearance ?? {}), avatarIndex: input.avatarIndex },
            reason: '更新员工名片与形象',
          }),
        })
        profile = result.profile
      }
      const updatedAt = profile?.createdAt ?? new Date().toISOString()
      setEmployees((current) => current.map((employee) => employee.id === managingEmployee.id
        ? { ...employee, displayName: input.displayName, avatarIndex: input.avatarIndex, updatedAt }
        : employee))
      setDossiers((current) => {
        const dossier = current[managingEmployee.id]
        return dossier === undefined
          ? current
          : { ...current, [managingEmployee.id]: { ...dossier, employee: { ...dossier.employee, displayName: input.displayName, updatedAt }, ...(profile === undefined ? {} : { profile }) } }
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '员工名片保存失败')
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
      setError(cause instanceof Error ? cause.message : '员工归档失败')
    } finally {
      setSavingEmployee(false)
    }
  }, [managingEmployee, selectedEmployeeId])

  const selectSession = useCallback((sessionId: string) => {
    setActiveSessionId(sessionId)
    if (demoMode) setMessages(sessionId === demoData.sessions[0]?.id ? demoData.messages : [])
  }, [])

  const send = useCallback(async (prompt: string) => {
    if (activeWorld === undefined) return
    setSending(true)
    setLiveTurns([])
    setError(undefined)
    try {
      if (demoMode) {
        const session = activeSession ?? makeDemoSession(activeWorld, prompt)
        const mentioned = employees.filter((employee) => prompt.includes(`@${employee.displayName}`))
        const targets = mentioned.length > 0 ? mentioned : employees.slice(0, 1)
        const ownerMessage = makeDemoMessage(session.id, messages.length + 1, 'owner', 'owner', 'user', prompt)
        setSessions((current) => current.some((item) => item.id === session.id) ? current : [session, ...current])
        setActiveSessionId(session.id)
        setMessages((current) => [...current, ownerMessage])
        setDraft('')
        await delay(650)
        const replies = targets.map((employee, index) => makeDemoMessage(
          session.id,
          messages.length + index + 2,
          employee.id,
          'employee',
          'assistant',
          `${employee.displayName}收到。我会以${employee.role}的职责独立处理“${compactPrompt(prompt)}”，完成后给出证据、产物和下一步。`,
        ))
        setMessages((current) => [...current, ...replies])
        return
      }
      const result = await api<ChatResult>(`/api/worlds/${activeWorld.id}/chat`, {
        method: 'POST',
        body: JSON.stringify({ prompt, ...(activeSessionId === undefined ? {} : { sessionId: activeSessionId }) }),
      })
      setDraft('')
      setActiveSessionId(result.session.id)
      setSessions((current) => [result.session, ...current.filter((item) => item.id !== result.session.id)])
      const transcript = await api<{ items: WorkMessage[] }>(`/api/sessions/${result.session.id}/messages`)
      setMessages(transcript.items)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '消息发送失败')
    } finally {
      setSending(false)
      setLiveTurns([])
    }
  }, [activeSession, activeSessionId, activeWorld, employees, messages.length])

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

  const saveModel = useCallback(async (profile: Omit<ModelProfile, 'id' | 'workspaceId' | 'createdAt' | 'updatedAt'>) => {
    if (workspace === undefined) return
    if (demoMode) {
      const timestamp = new Date().toISOString()
      setModels((current) => [...current, { ...profile, id: `demo-model-${current.length}`, workspaceId: workspace.id, createdAt: timestamp, updatedAt: timestamp }])
      return
    }
    const result = await api<{ profile: ModelProfile }>(`/api/workspaces/${workspace.id}/model-profiles`, {
      method: 'POST',
      body: JSON.stringify(profile),
    })
    setModels((current) => [...current.filter((item) => item.id !== result.profile.id), result.profile])
  }, [workspace])

  const runSystemAction = useCallback(async (action: SystemAction, input?: { candidateRoot?: string }): Promise<SystemActionResult> => {
    if (demoMode) {
      await delay(350)
      if (action === 'backup' || action === 'export') {
        return { ok: true, kind: action, output: `演示模式/${action === 'backup' ? 'dsh-cyber-demo.sqlite' : 'dsh-cyber-demo.json'}`, createdAt: new Date().toISOString() }
      }
      if (action === 'verify-update') {
        return { ok: true, version: '0.1.0-rc.7', supported: true, contractId: 'dsh-session-events-v1', checks: { packageVersions: true, isolatedProfile: true } }
      }
      return { ok: true, checkedAt: new Date().toISOString(), compatibility: { expectedVersion: '0.1.0-rc.7', errors: [] }, database: { schemaVersion: 5, integrity: ['ok'], errors: [] } }
    }
    if (action === 'status') return api<SystemActionResult>('/api/system/status')
    if (action === 'doctor') return api<SystemActionResult>('/api/system/doctor', { method: 'POST', body: '{}' })
    if (action === 'backup') return api<SystemActionResult>('/api/system/backup', { method: 'POST', body: '{}' })
    if (action === 'export') return api<SystemActionResult>('/api/system/export', { method: 'POST', body: '{}' })
    return api<SystemActionResult>('/api/system/update/verify', { method: 'POST', body: JSON.stringify({ candidateRoot: input?.candidateRoot }) })
  }, [])

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
        <div className="topbar__workspace"><span>当前工作区：</span><strong>{workspace.name}</strong><span className="topbar__chevron">⌄</span></div>
        <nav aria-label="全局功能">
          <button type="button" onClick={() => void openPackageMarket()}><Cube size={16} />软件包市场</button>
          <button type="button" onClick={() => void openRecruitment()}><Storefront size={16} />员工市场</button>
          <button type="button" onClick={() => { setSettingsSection('runtime'); setSettingsOpen(true) }}><Pulse size={16} /><span>运行时健康</span><i className="health-indicator" />良好</button>
          <button type="button" onClick={() => { setSettingsSection('appearance'); setSettingsOpen(true) }}><GearSix size={17} />设置</button>
        </nav>
      </header>
      {error === undefined ? null : <div className="error-banner" role="alert">{error}<button type="button" onClick={() => setError(undefined)}>关闭</button></div>}
      <ResizableShell
        leftWidth={preferences.leftPaneWidth}
        rightWidth={preferences.rightPaneWidth}
        rightCollapsed={dockCollapsed}
        onResize={resize}
        left={(
          <NavigationPane
            worlds={worlds}
            activeWorldId={activeWorld.id}
            sessions={sessions}
            {...(activeSessionId === undefined ? {} : { activeSessionId })}
            employees={employees}
            onSelectWorld={(worldId) => { const world = worlds.find((item) => item.id === worldId); if (world) void loadWorld(world) }}
            onSelectSession={selectSession}
            onSelectEmployee={(employeeId) => void openDossier(employeeId)}
            onDirectEmployee={directEmployee}
            onRecruit={() => void openRecruitment()}
            onCreateWorld={() => setError('世界创建向导将在主题市场阶段开放。')}
          />
        )}
        center={(
          <ChatWorkbench
            demoMode={demoMode}
            {...(activeSession === undefined ? {} : { session: activeSession })}
            messages={messages}
            employees={employees}
            liveTurns={liveTurns}
            sending={sending}
            draft={draft}
            onDraftChange={setDraft}
            onSend={send}
            onOpenDossier={(employeeId) => void openDossier(employeeId)}
            onOpenArtifact={() => { setDockCollapsed(false); setDockTab('preview') }}
            onRecruit={() => void openRecruitment()}
          />
        )}
        right={(
          <ArtifactDock
            demoMode={demoMode}
            activeTab={dockTab}
            {...(selectedEmployee === undefined ? {} : { selectedEmployee })}
            dossiers={dossiers}
            employees={employees}
            worldName={activeWorld.name}
            {...(backgroundImage === undefined ? {} : { sceneImage: backgroundImage })}
            onTabChange={setDockTab}
            onCollapse={() => setDockCollapsed(true)}
            onSelectEmployee={(employeeId) => void openDossier(employeeId)}
            onDirectEmployee={directEmployee}
            onManageEmployee={(employee) => setManagingEmployeeId(employee.id)}
            onShowAllDossiers={() => setSelectedEmployeeId(undefined)}
          />
        )}
      />
      {dockCollapsed ? <button className="dock-reopen" type="button" onClick={() => setDockCollapsed(false)} aria-label="展开侧边栏"><SidebarSimple size={18} /></button> : null}
      {settingsOpen ? (
        <SettingsDialog
          preferences={preferences}
          models={models}
          initialSection={settingsSection}
          saving={savingSettings}
          onClose={() => setSettingsOpen(false)}
          onSavePreferences={savePreferences}
          onUploadBackground={uploadBackground}
          onSaveModel={saveModel}
          onSystemAction={runSystemAction}
        />
      ) : null}
      {recruitmentOpen ? (
        <RecruitmentDialog
          blueprints={blueprints}
          loading={catalogLoading}
          recruiting={recruiting}
          onClose={() => setRecruitmentOpen(false)}
          onRecruit={recruitEmployee}
        />
      ) : null}
      {packageMarketOpen ? (
        <PackageMarketDialog
          installed={installedPackages}
          transactions={packageTransactions}
          loading={packageLoading}
          installing={packageInstalling}
          onClose={() => setPackageMarketOpen(false)}
          onPreview={previewPackage}
          onInstall={installPackage}
        />
      ) : null}
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

function LoadingScreen() {
  return <div className="loading-screen"><Cube size={28} weight="fill" /><strong>DSH Cyber</strong><span>正在恢复本地世界…</span></div>
}

function Onboarding({ error, onCreated }: { error?: string; onCreated(): Promise<void> }) {
  const [creating, setCreating] = useState(false)
  const create = async () => {
    setCreating(true)
    try {
      const workspaceResult = await api<{ workspace: Workspace }>('/api/workspaces', { method: 'POST', body: JSON.stringify({ name: '我的本地空间' }) })
      await api(`/api/workspaces/${workspaceResult.workspace.id}/worlds`, { method: 'POST', body: JSON.stringify({ name: '赛博公司', templateId: 'cyber-company' }) })
      await onCreated()
    } finally {
      setCreating(false)
    }
  }
  return (
    <main className="onboarding">
      <div className="brand-lockup brand-lockup--large"><Cube size={28} weight="fill" /><strong>DSH Cyber</strong></div>
      <h1>创建第一个本地世界</h1>
      <p>世界拥有独立角色、会话、记忆和成长档案。不会自动招聘员工。</p>
      {error === undefined ? null : <div className="onboarding__error">{error}</div>}
      <button className="primary-button" type="button" disabled={creating} onClick={() => void create()}>{creating ? '正在创建…' : '创建本地工作区'}</button>
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
  if (employee.status === 'blocked') return '等待依赖或老板推进'
  if (employee.status === 'waiting') return '等待下一步处理'
  return '可接新任务'
}

function makeDemoSession(world: World, prompt: string): WorkSession {
  const timestamp = new Date().toISOString()
  return { id: `session-${Date.now()}`, workspaceId: world.workspaceId, worldId: world.id, kind: 'direct', title: compactPrompt(prompt), status: 'open', createdAt: timestamp, updatedAt: timestamp }
}

function makeDemoMessage(sessionId: string, sequence: number, senderId: string, senderKind: WorkMessage['senderKind'], kind: WorkMessage['kind'], content: string): WorkMessage {
  const createdAt = new Date().toISOString()
  return { id: `message-${Date.now()}-${sequence}`, sessionId, sequence, senderId, senderKind, kind, content, metadata: { displayTime: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) }, createdAt }
}

function compactPrompt(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim()
  return compact.length > 36 ? `${compact.slice(0, 35)}…` : compact
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds))
}

function reduceLiveTurn(current: LiveAgentTurn[], envelope: RuntimeEnvelope): LiveAgentTurn[] {
  const key = (turn: LiveAgentTurn) => turn.agentId === envelope.agentId && turn.sessionId === envelope.sessionId
  const existing = current.find(key) ?? {
    agentId: envelope.agentId,
    sessionId: envelope.sessionId,
    status: 'thinking' as const,
    reasoning: '',
    text: '',
    tools: [],
  }
  const event = envelope.event
  let next = existing
  if (event.kind === 'turn.started') next = { ...next, status: 'thinking' }
  if (event.kind === 'reasoning.delta' && event.content) next = { ...next, reasoning: `${next.reasoning}${event.content}` }
  if (event.kind === 'assistant.reasoning' && event.content && !next.reasoning) next = { ...next, reasoning: event.content }
  if (event.kind === 'text.delta' && event.content) next = { ...next, text: `${next.text}${event.content}` }
  if (event.kind === 'assistant.message' && event.content && !next.text) next = { ...next, text: event.content }
  if (event.kind === 'tool.started') {
    const callId = event.callId ?? `tool-${next.tools.length}`
    const tool = { id: callId, label: event.toolName ?? '工具调用', target: event.toolName ?? 'unknown-tool', status: 'running' as const }
    next = { ...next, status: 'working', tools: [...next.tools.filter((item) => item.id !== callId), tool] }
  }
  if (event.kind === 'tool.completed') {
    const callId = event.callId ?? `tool-${next.tools.length}`
    const found = next.tools.find((item) => item.id === callId)
    const tool = { id: callId, label: found?.label ?? '工具调用', target: found?.target ?? 'unknown-tool', status: event.failed ? 'failed' as const : 'complete' as const }
    next = { ...next, status: event.failed ? 'failed' : 'thinking', tools: [...next.tools.filter((item) => item.id !== callId), tool] }
  }
  if (event.kind === 'turn.completed') next = { ...next, status: 'completed' }
  if (event.kind === 'turn.failed') next = { ...next, status: 'failed' }
  return [...current.filter((turn) => !key(turn)), next]
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

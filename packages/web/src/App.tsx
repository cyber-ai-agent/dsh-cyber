import {
  Cube,
  GearSix,
  Pulse,
  SidebarSimple,
  Storefront,
} from '@phosphor-icons/react'
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react'
import type {
  EmployeeDossier,
  EmployeeInstance,
  ModelProfile,
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
import { NavigationPane } from './components/NavigationPane.js'
import { ResizableShell } from './components/ResizableShell.js'
import { SettingsDialog } from './components/SettingsDialog.js'
import { demoData } from './demo-data.js'
import type { CyberEmployee, DockTab } from './types.js'

const demoMode = new URLSearchParams(window.location.search).get('demo') === '1'

interface ChatResult {
  session: WorkSession
}

export default function App() {
  const [workspace, setWorkspace] = useState<Workspace | undefined>(demoMode ? demoData.workspace : undefined)
  const [worlds, setWorlds] = useState<World[]>(demoMode ? demoData.worlds : [])
  const [activeWorld, setActiveWorld] = useState<World | undefined>(demoMode ? demoData.activeWorld : undefined)
  const [employees, setEmployees] = useState<CyberEmployee[]>(demoMode ? demoData.employees : [])
  const [sessions, setSessions] = useState<WorkSession[]>(demoMode ? demoData.sessions : [])
  const [activeSessionId, setActiveSessionId] = useState<string | undefined>(demoMode ? demoData.sessions[0]?.id : undefined)
  const [messages, setMessages] = useState<WorkMessage[]>(demoMode ? demoData.messages : [])
  const [preferences, setPreferences] = useState<WorkspacePreferences | undefined>(demoMode ? demoData.preferences : undefined)
  const [models, setModels] = useState<ModelProfile[]>(demoMode ? demoData.modelProfiles : [])
  const [dossiers, setDossiers] = useState<Record<string, EmployeeDossier>>(demoMode ? demoData.dossiers : {})
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string | undefined>()
  const [dockTab, setDockTab] = useState<DockTab>('world')
  const [dockCollapsed, setDockCollapsed] = useState(false)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [savingSettings, setSavingSettings] = useState(false)
  const [loading, setLoading] = useState(!demoMode)
  const [error, setError] = useState<string | undefined>()

  const activeSession = sessions.find((session) => session.id === activeSessionId)
  const selectedEmployee = employees.find((employee) => employee.id === selectedEmployeeId)
  const selectedDossier = selectedEmployeeId === undefined ? undefined : dossiers[selectedEmployeeId]

  const loadWorld = useCallback(async (world: World) => {
    setError(undefined)
    setActiveWorld(world)
    setActiveSessionId(undefined)
    setMessages([])
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
    const mapped = snapshot.employees.map(toCyberEmployee)
    setEmployees(mapped)
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

  const selectSession = useCallback((sessionId: string) => {
    setActiveSessionId(sessionId)
    if (demoMode) setMessages(sessionId === demoData.sessions[0]?.id ? demoData.messages : [])
  }, [])

  const send = useCallback(async (prompt: string) => {
    if (activeWorld === undefined) return
    setSending(true)
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
          <button type="button"><Storefront size={16} />软件包市场</button>
          <button type="button"><Pulse size={16} /><span>运行时健康</span><i className="health-indicator" />良好</button>
          <button type="button" onClick={() => setSettingsOpen(true)}><GearSix size={17} />设置</button>
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
            onCreateWorld={() => setError('世界创建向导将在主题市场阶段开放。')}
          />
        )}
        center={(
          <ChatWorkbench
            {...(activeSession === undefined ? {} : { session: activeSession })}
            messages={messages}
            employees={employees}
            sending={sending}
            draft={draft}
            onDraftChange={setDraft}
            onSend={send}
            onStop={() => setSending(false)}
            onOpenDossier={(employeeId) => void openDossier(employeeId)}
          />
        )}
        right={(
          <ArtifactDock
            activeTab={dockTab}
            {...(selectedEmployee === undefined ? {} : { selectedEmployee })}
            {...(selectedDossier === undefined ? {} : { dossier: selectedDossier })}
            employees={employees}
            worldName={activeWorld.name}
            onTabChange={setDockTab}
            onCollapse={() => setDockCollapsed(true)}
            onSelectEmployee={(employeeId) => void openDossier(employeeId)}
            onDirectEmployee={directEmployee}
          />
        )}
      />
      {dockCollapsed ? <button className="dock-reopen" type="button" onClick={() => setDockCollapsed(false)} aria-label="展开侧边栏"><SidebarSimple size={18} /></button> : null}
      {settingsOpen ? (
        <SettingsDialog
          preferences={preferences}
          models={models}
          saving={savingSettings}
          onClose={() => setSettingsOpen(false)}
          onSavePreferences={savePreferences}
          onUploadBackground={uploadBackground}
          onSaveModel={saveModel}
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

function toCyberEmployee(employee: EmployeeInstance, index: number): CyberEmployee {
  return {
    ...employee,
    avatarIndex: stableAvatar(employee.id, index),
    summary: `${employee.role}独立 Agent，拥有自己的会话、记忆与成长记录。`,
    currentActivity: statusActivity(employee),
  }
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

import {
  ArrowsOut,
  Buildings,
  ImageSquare,
  LightbulbFilament,
  MapTrifold,
  Minus,
  Plus,
  PuzzlePiece,
  PersonSimpleWalk,
} from '@phosphor-icons/react'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import type { EmployeeDossier, WorkSession, World, WorldInteractionAction, WorldRuntimeSnapshot, WorldZoomCommand } from '@dsh-cyber/contracts'

import { api } from '../../api.js'
import { PeerCollaborationDialog, type PeerCollaborationDraft } from '../../components/PeerCollaborationDialog.js'
import type { CyberEmployee } from '../../types.js'
import { AmbientLifeDialog } from './AmbientLifeDialog.js'
import { EmployeeFocusMode } from './avatar/focus/EmployeeFocusMode.js'
import { WorldExtensionsDialog } from './extensions/WorldExtensionsDialog.js'
import { readWorldExtensionEnabled, writeWorldExtensionEnabled } from './extensions/world-extension-preference.js'
import {
  readWorldView,
  viewForFocus,
  writeWorldView,
  type WorldRendererMode,
  type WorldViewState,
} from './runtime/world-view-mode.js'
import { WorldLocomotion } from './runtime/world-locomotion.js'
import { WorldCanvas } from './WorldCanvas.js'
import { EmployeeInteractionMenu, ObjectInteractionMenu } from './WorldInteractionMenu.js'
import { WorldSceneDialog } from './WorldSceneDialog.js'
import { useWorldClient } from './world-client-store.js'
import { createZoomCommand } from './zoom-command.js'

const SpatialWorldExtensionDialog = lazy(async () => ({
  default: (await import('./extensions/spatial-3d/SpatialWorldExtensionDialog.js')).SpatialWorldExtensionDialog,
}))

type WorldContextTarget = { kind: 'employee' | 'object'; id: string; position: { x: number; y: number } }

interface PeerCollaborationResponse {
  session: WorkSession
  participantIds: string[]
}

interface WorldRuntimeDockProps {
  demoMode: boolean
  world: World
  employees: CyberEmployee[]
  dossiers: Record<string, EmployeeDossier>
  liveEnabled?: boolean
  sessionId?: string
  sessionKind?: WorkSession['kind']
  selectedEmployeeId?: string
  conversationEmployeeIds: string[]
  latestUtterances: Array<{ messageId: string; employeeId: string; text: string; clientTurnId?: string }>
  onSelectEmployee(employeeId: string): void
  onStartGroup(employeeIds: string[], session?: WorkSession): void
  onManageAvatar(employeeId: string): void
  onVoiceFinal(text: string): Promise<void>
}

export function WorldRuntimeDock({ demoMode, world, employees, dossiers, liveEnabled = true, sessionId, sessionKind, selectedEmployeeId, conversationEmployeeIds, latestUtterances, onSelectEmployee, onStartGroup, onManageAvatar, onVoiceFinal }: WorldRuntimeDockProps) {
  const runtime = useWorldClient({ demoMode, world, employees, liveEnabled })
  const [fitRequest, setFitRequest] = useState(0)
  const [zoomCommand, setZoomCommand] = useState<WorldZoomCommand>()
  const [selectedObjectId, setSelectedObjectId] = useState<string>()
  const [activeEmployeeId, setActiveEmployeeId] = useState<string | undefined>(selectedEmployeeId)
  const [contextTarget, setContextTarget] = useState<WorldContextTarget>()
  const [ambientSettingsOpen, setAmbientSettingsOpen] = useState(false)
  const [sceneSettingsOpen, setSceneSettingsOpen] = useState(false)
  const [extensionsOpen, setExtensionsOpen] = useState(false)
  const [spatialExtensionEnabled, setSpatialExtensionEnabled] = useState(() => readWorldExtensionEnabled('spatial-3d'))
  const [spatialOpen, setSpatialOpen] = useState(false)
  const [peerInitiatorId, setPeerInitiatorId] = useState<string>()
  const [peerBusy, setPeerBusy] = useState(false)
  const [peerError, setPeerError] = useState<string>()
  const [focusCameraId, setFocusCameraId] = useState<string>()
  const focusTimerRef = useRef<number | undefined>(undefined)
  const [staticMode, setStaticMode] = useState(() => readStaticMode(world.id))
  const [view, setView] = useState<WorldViewState>(() => readWorldView(world.id))
  const [panelOpen, setPanelOpen] = useState(() => readWorldView(world.id).renderer === '2d')
  const locomotionRef = useRef(new WorldLocomotion())
  const autoFocusedEmployeeRef = useRef<string | undefined>('__none__')
  const settledRef = useRef(false)

  useEffect(() => {
    const latestSpeakerId = latestUtterances[0]?.employeeId
    const nextEmployeeId = sessionKind === 'direct'
      ? selectedEmployeeId ?? conversationEmployeeIds[0]
      : latestSpeakerId !== undefined && conversationEmployeeIds.includes(latestSpeakerId)
        ? latestSpeakerId
        : selectedEmployeeId ?? conversationEmployeeIds[0]
    setActiveEmployeeId(nextEmployeeId)
    if (nextEmployeeId === undefined || autoFocusedEmployeeRef.current === nextEmployeeId) return
    autoFocusedEmployeeRef.current = nextEmployeeId
    const arriving = !settledRef.current
    settledRef.current = true
    if (arriving) return
    // Conversation state no longer changes the renderer. If the user chose the
    // map, they stay on the map; choosing 2D makes the current speaker visible.
    setPanelOpen(true)
  }, [conversationEmployeeIds, latestUtterances, selectedEmployeeId, sessionId, sessionKind])
  useEffect(() => () => { if (focusTimerRef.current !== undefined) window.clearTimeout(focusTimerRef.current) }, [])
  useEffect(() => {
    if (typeof localStorage !== 'undefined') localStorage.setItem(`dsh-cyber-digital-static:${world.id}`, staticMode ? 'true' : 'false')
  }, [staticMode, world.id])
  useEffect(() => { writeWorldView(world.id, view) }, [view, world.id])

  if (runtime.loading || runtime.snapshot === undefined) {
    return <div className="world-runtime-dock world-runtime-dock--loading"><Buildings size={28} /><strong>正在恢复实时世界</strong><span>同步角色位置、任务状态和世界场景…</span></div>
  }

  const renderedSnapshot = withCharacterVisuals(runtime.snapshot, employees)
  const selectedEmployee = employees.find((employee) => employee.id === activeEmployeeId)
  const peerInitiator = employees.find((employee) => employee.id === peerInitiatorId)
  const selectedObject = renderedSnapshot.objects.find((object) => object.id === selectedObjectId)
  const selectedObjectManifest = runtime.manifest.scenes.find((scene) => scene.id === renderedSnapshot.sceneId)?.interactables.find((object) => object.id === selectedObjectId)
  const conversationEmployees = conversationEmployeeIds
    .map((employeeId) => employees.find((employee) => employee.id === employeeId))
    .filter((employee): employee is CyberEmployee => employee !== undefined)
  const focusedEmployee = employees.find((employee) => employee.id === activeEmployeeId)
  const focusedEntity = renderedSnapshot.entities.find((entity) => entity.id === activeEmployeeId)
  const focusedUtterance = latestUtterances.find((utterance) => utterance.employeeId === activeEmployeeId)
  const collaborators = conversationEmployees
    .filter((employee) => employee.id !== activeEmployeeId)
    .map((employee) => ({ employee, entity: renderedSnapshot.entities.find((entity) => entity.id === employee.id) }))
  const focused = panelOpen && view.renderer === '2d' && focusedEmployee !== undefined
  const showCharacterPanel = focused && focusedEmployee !== undefined

  const enterEmployeeFocus = (employeeId: string) => {
    if (focusTimerRef.current !== undefined) window.clearTimeout(focusTimerRef.current)
    setActiveEmployeeId(employeeId)
    setSelectedObjectId(undefined)
    setContextTarget(undefined)
    setFocusCameraId(employeeId)
    focusTimerRef.current = window.setTimeout(() => {
      setPanelOpen(true)
      setView({ renderer: '2d', camera: 'focus' })
      setFocusCameraId(undefined)
      focusTimerRef.current = undefined
    }, 190)
  }

  const selectRendererMode = (renderer: WorldRendererMode) => {
    if (focusTimerRef.current !== undefined) window.clearTimeout(focusTimerRef.current)
    if (renderer === 'map') {
      setPanelOpen(false)
      setFocusCameraId(undefined)
      setView({ renderer: 'map', camera: 'overview' })
      setFitRequest((value) => value + 1)
      return
    }
    const subject = activeEmployeeId ?? renderedSnapshot.entities.find((entity) => entity.kind === 'agent')?.id
    if (subject === undefined) {
      setView({ renderer: 'map', camera: 'overview' })
      setPanelOpen(false)
      return
    }
    setActiveEmployeeId(subject)
    setPanelOpen(true)
    setView(viewForFocus({ renderer: '2d', camera: 'focus' }, subject))
    setFocusCameraId(subject)
    focusTimerRef.current = window.setTimeout(() => {
      setFocusCameraId(undefined)
      focusTimerRef.current = undefined
    }, 190)
  }

  const setSpatialExtension = (enabled: boolean) => {
    setSpatialExtensionEnabled(enabled)
    writeWorldExtensionEnabled('spatial-3d', enabled)
    if (!enabled) setSpatialOpen(false)
  }

  const interactWithEmployee = async (action: 'talk' | 'assign-task' | 'start-meeting') => {
    if (selectedEmployee === undefined) return
    if (action === 'talk') {
      await runtime.interact({ action, actorId: 'owner', entityId: selectedEmployee.id })
      onSelectEmployee(selectedEmployee.id)
      return
    }
    if (action === 'assign-task') {
      await runtime.interact({ action, actorId: 'owner', entityId: selectedEmployee.id, objectId: 'workstation' })
      onSelectEmployee(selectedEmployee.id)
      return
    }
    const colleague = employees.find((employee) => employee.id !== selectedEmployee.id)
    const participantIds = colleague === undefined ? [selectedEmployee.id] : [selectedEmployee.id, colleague.id]
    if (participantIds.length < 2) return
    await runtime.interact({ action, actorId: 'owner', participantIds })
    onStartGroup(participantIds)
  }

  const startPeerCollaboration = async (draft: PeerCollaborationDraft) => {
    if (peerInitiator === undefined || peerBusy) return
    const participantIds = [peerInitiator.id, ...draft.participantIds]
    setPeerBusy(true)
    setPeerError(undefined)
    try {
      if (demoMode) {
        const now = new Date().toISOString()
        const session: WorkSession = {
          id: `demo-peer-${Date.now()}`,
          workspaceId: world.workspaceId,
          worldId: world.id,
          kind: 'meeting',
          title: draft.purpose.slice(0, 36),
          status: 'open',
          createdAt: now,
          updatedAt: now,
        }
        setPeerInitiatorId(undefined)
        onStartGroup(participantIds, session)
        return
      }
      const result = await api<PeerCollaborationResponse>(`/api/worlds/${encodeURIComponent(world.id)}/peer-conversations`, {
        method: 'POST',
        body: JSON.stringify({
          initiatorId: peerInitiator.id,
          participantIds: draft.participantIds,
          purpose: draft.purpose,
          maxRounds: draft.maxRounds,
        }),
      })
      setPeerInitiatorId(undefined)
      onStartGroup(result.participantIds, result.session)
    } catch (cause) {
      setPeerError(cause instanceof Error ? cause.message : '角色协作启动失败')
    } finally {
      setPeerBusy(false)
    }
  }

  const actOnObject = async (action: WorldInteractionAction) => {
    if (selectedObject === undefined) return
    const participantIds = action === 'start-meeting'
      ? (selectedEmployee === undefined
          ? employees.slice(0, 3)
          : [selectedEmployee, ...employees.filter((employee) => employee.id !== selectedEmployee.id).slice(0, 2)])
        .map((employee) => employee.id)
      : undefined
    if (action === 'start-meeting' && (participantIds?.length ?? 0) < 2) return
    await runtime.interact({
      action,
      actorId: 'owner',
      objectId: selectedObject.id,
      ...(selectedEmployee === undefined ? {} : { entityId: selectedEmployee.id }),
      ...(participantIds === undefined ? {} : { participantIds }),
    })
    if (action === 'assign-task' && selectedEmployee !== undefined) onSelectEmployee(selectedEmployee.id)
    if (action === 'start-meeting' && participantIds !== undefined) onStartGroup(participantIds)
  }

  return (
    <>
      <section className="world-runtime-dock" aria-label={`${world.name}实时世界`}>
        <div className="world-runtime-dock__canvas">
          <div className="world-runtime-dock__display-switch" role="tablist" aria-label="世界显示方式">
            <button type="button" role="tab" aria-selected={view.renderer === 'map'} className={view.renderer === 'map' ? 'is-active' : ''} onClick={() => selectRendererMode('map')}><MapTrifold size={15} aria-hidden="true" />平面</button>
            <button type="button" role="tab" aria-selected={view.renderer === '2d'} className={view.renderer === '2d' ? 'is-active' : ''} disabled={!renderedSnapshot.entities.some((entity) => entity.kind === 'agent')} onClick={() => selectRendererMode('2d')}><ImageSquare size={15} aria-hidden="true" />2D</button>
          </div>
          <div className={`world-runtime-dock__overview${showCharacterPanel ? ' is-focused' : focusCameraId !== undefined ? ' is-focusing' : ''}`}>
            <WorldCanvas
              manifest={runtime.manifest}
              locomotion={locomotionRef.current}
              cameraMode={view.camera}
              {...(activeEmployeeId === undefined ? {} : { cameraSubjectId: activeEmployeeId })}
              rendererIdentity={runtime.rendererIdentity}
              snapshot={renderedSnapshot}
              cues={runtime.cues}
              {...(activeEmployeeId === undefined ? {} : { selectedEntityId: activeEmployeeId })}
              {...(selectedObjectId === undefined ? {} : { selectedObjectId })}
              {...(focusCameraId === undefined ? {} : { focusEntityId: focusCameraId })}
              fitRequest={fitRequest}
              {...(zoomCommand === undefined ? {} : { zoomCommand })}
              onEntitySelect={enterEmployeeFocus}
              onObjectSelect={(objectId) => { setSelectedObjectId(objectId); setContextTarget(undefined) }}
              onEntityContext={(employeeId, position) => { setActiveEmployeeId(employeeId); setSelectedObjectId(undefined); setContextTarget({ kind: 'employee', id: employeeId, position }) }}
              onObjectContext={(objectId, position) => { setSelectedObjectId(objectId); setContextTarget({ kind: 'object', id: objectId, position }) }}
              onReady={() => undefined}
            />
          </div>
          {!showCharacterPanel ? null : <EmployeeFocusMode key={focusedEmployee.id} world={world} employee={focusedEmployee} {...(dossiers[focusedEmployee.id]?.profile === undefined ? {} : { profile: dossiers[focusedEmployee.id]!.profile })} {...(focusedEntity === undefined ? {} : { entity: focusedEntity })} collaborators={collaborators} connected={runtime.connected} staticMode={staticMode} rendererMode="2d" embedded={false} spatial3dEnabled={spatialExtensionEnabled} {...(focusedUtterance === undefined ? {} : { latestUtterance: focusedUtterance })} onFocusEmployee={setActiveEmployeeId} onManageAvatar={() => onManageAvatar(focusedEmployee.id)} onStaticModeChange={setStaticMode} onVoiceFinal={onVoiceFinal} />}

          {selectedEmployee === undefined || contextTarget?.kind !== 'employee' || contextTarget.id !== selectedEmployee.id ? null : <EmployeeInteractionMenu employee={selectedEmployee} position={contextTarget.position} onClose={() => setContextTarget(undefined)} onTalk={() => void interactWithEmployee('talk')} onAssignTask={() => void interactWithEmployee('assign-task')} onMeeting={() => void interactWithEmployee('start-meeting')} onPeerCollaboration={() => { setPeerError(undefined); setPeerInitiatorId(selectedEmployee.id) }} />}
          {selectedObject === undefined || selectedObjectManifest === undefined || contextTarget?.kind !== 'object' || contextTarget.id !== selectedObject.id ? null : <ObjectInteractionMenu object={selectedObject} manifest={selectedObjectManifest} position={contextTarget.position} {...(selectedEmployee === undefined ? {} : { selectedEmployee })} onClose={() => setContextTarget(undefined)} onAction={(action) => void actOnObject(action)} />}

          <div className="world-runtime-dock__controls" aria-label="世界视图控制">
            <button type="button" aria-label="缩小" onClick={() => setZoomCommand(createZoomCommand(-0.1))}><Minus size={15} /></button>
            <button type="button" aria-label="显示全景" title="适应窗口且不露出场景边界" onClick={() => { setView({ renderer: 'map', camera: 'overview' }); setPanelOpen(false); setFitRequest((value) => value + 1) }}><ArrowsOut size={15} /></button>
            <button type="button" aria-label="放大" onClick={() => setZoomCommand(createZoomCommand(0.1))}><Plus size={15} /></button>
            <button type="button" aria-label="世界场景" title="选择只属于当前世界的独立场景" onClick={() => setSceneSettingsOpen(true)}><MapTrifold size={16} /></button>
            <button type="button" aria-label="世界活力设置" title="配置角色有岗位逻辑的日常行为" onClick={() => setAmbientSettingsOpen(true)}><PersonSimpleWalk size={16} /></button>
            <button type="button" className={spatialExtensionEnabled ? 'is-active' : ''} aria-label="世界扩展" title="管理可选扩展；3D 不属于核心世界" onClick={() => setExtensionsOpen(true)}><PuzzlePiece size={16} /></button>
            <button type="button" className={runtime.snapshot.clock.lightsOn ? 'is-active' : ''} aria-label={runtime.snapshot.clock.lightsOn ? '关闭场景照明' : '打开场景照明'} onClick={() => void runtime.interact({ action: 'toggle-lights', actorId: 'owner' })}><LightbulbFilament size={16} /></button>
          </div>

          {ambientSettingsOpen ? <AmbientLifeDialog worldId={world.id} worldName={world.name} onClose={() => setAmbientSettingsOpen(false)} /> : null}
          {sceneSettingsOpen ? <WorldSceneDialog world={world} currentManifest={runtime.manifest} onClose={() => setSceneSettingsOpen(false)} onApplied={runtime.reloadScene} /> : null}
          {extensionsOpen ? <WorldExtensionsDialog worldName={world.name} spatialEnabled={spatialExtensionEnabled} onSpatialEnabledChange={setSpatialExtension} onOpenSpatial={() => { setExtensionsOpen(false); setSpatialOpen(true) }} onClose={() => setExtensionsOpen(false)} /> : null}

          {employees.length === 0 ? <div className="world-runtime-dock__empty"><strong>这个世界还没有角色</strong><span>请到右侧「角色」新增角色。世界视图只负责展示和互动，不再承担角色管理。</span></div> : null}
        </div>
      </section>

      {spatialOpen && spatialExtensionEnabled ? <Suspense fallback={<div className="modal-backdrop" role="status"><div className="world-runtime-dock world-runtime-dock--loading"><Buildings size={28} /><strong>正在加载 3D 扩展</strong><span>核心世界保持运行，Three.js 与 VRM 仅在此时加载…</span></div></div>}>
        <SpatialWorldExtensionDialog
          worldName={world.name}
          manifest={runtime.manifest}
          locomotion={locomotionRef.current}
          rendererIdentity={runtime.rendererIdentity}
          snapshot={renderedSnapshot}
          cues={runtime.cues}
          employees={employees}
          {...(activeEmployeeId === undefined ? {} : { selectedEmployeeId: activeEmployeeId })}
          {...(selectedObjectId === undefined ? {} : { selectedObjectId })}
          onSelectEmployee={(employeeId) => { setActiveEmployeeId(employeeId); setSelectedObjectId(undefined) }}
          onSelectObject={(objectId) => setSelectedObjectId(objectId)}
          onClose={() => setSpatialOpen(false)}
        />
      </Suspense> : null}

      {peerInitiator === undefined ? null : (
        <PeerCollaborationDialog
          initiator={peerInitiator}
          employees={employees}
          busy={peerBusy}
          {...(peerError === undefined ? {} : { error: peerError })}
          onClose={() => { if (!peerBusy) { setPeerInitiatorId(undefined); setPeerError(undefined) } }}
          onCreate={(draft) => void startPeerCollaboration(draft)}
        />
      )}
    </>
  )
}

function readStaticMode(worldId: string): boolean {
  if (typeof localStorage !== 'undefined') {
    const saved = localStorage.getItem(`dsh-cyber-digital-static:${worldId}`)
    if (saved !== null) return saved === 'true'
  }
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
}

function withCharacterVisuals(snapshot: WorldRuntimeSnapshot, employees: CyberEmployee[]): WorldRuntimeSnapshot {
  const visualIndex = new Map(employees.map((employee) => [employee.id, employee.avatarIndex]))
  const authorityRole = new Map(employees.map((employee) => [employee.id, employee.authorityRole]))
  return {
    ...snapshot,
    entities: snapshot.entities.map((entity) => {
      const rosterIndex = visualIndex.get(entity.id)
      const role = authorityRole.get(entity.id)
      return rosterIndex === undefined && role === undefined
        ? entity
        : withEntityVisuals(entity, rosterIndex, role)
    }),
  }
}

function withEntityVisuals(
  entity: WorldRuntimeSnapshot['entities'][number],
  rosterIndex: number | undefined,
  role: CyberEmployee['authorityRole'],
): WorldRuntimeSnapshot['entities'][number] {
  const next = { ...entity }
  if (rosterIndex !== undefined) next.visualState = { ...entity.visualState, rosterIndex }
  if (role === undefined) delete next.authorityRole
  else next.authorityRole = role
  return next
}

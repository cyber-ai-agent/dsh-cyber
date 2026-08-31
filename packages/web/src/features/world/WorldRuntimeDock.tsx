import {
  ArrowsOut,
  Buildings,
  Cube,
  ImageSquare,
  LightbulbFilament,
  MapTrifold,
  Minus,
  Plus,
  PersonSimpleWalk,
} from '@phosphor-icons/react'
import { useEffect, useRef, useState } from 'react'
import type { EmployeeDossier, WorkSession, World, WorldInteractionAction, WorldRuntimeSnapshot, WorldZoomCommand } from '@dsh-cyber/contracts'

import { api } from '../../api.js'
import { PeerCollaborationDialog, type PeerCollaborationDraft } from '../../components/PeerCollaborationDialog.js'
import type { CyberEmployee } from '../../types.js'
import { AmbientLifeDialog } from './AmbientLifeDialog.js'
import { EmployeeFocusMode } from './avatar/focus/EmployeeFocusMode.js'
import { threeDimensionalControl, type CharacterViewMode } from './avatar/avatar-view-mode.js'
import {
  cameraModesFor,
  readWorldView,
  reconcileView,
  rendererKindFor,
  viewForFocus,
  writeWorldView,
  type WorldCameraMode,
  type WorldRendererMode,
  type WorldViewState,
} from './runtime/world-view-mode.js'
import { WorldLocomotion } from './runtime/world-locomotion.js'
import { WorldCanvas } from './WorldCanvas.js'
import { EmployeeInteractionMenu, ObjectInteractionMenu } from './WorldInteractionMenu.js'
import { WorldSceneDialog } from './WorldSceneDialog.js'
import { useWorldClient } from './world-client-store.js'
import { createZoomCommand } from './zoom-command.js'

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
  latestUtterances: Array<{ messageId: string; employeeId: string; text: string }>
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
  const [peerInitiatorId, setPeerInitiatorId] = useState<string>()
  const [peerBusy, setPeerBusy] = useState(false)
  const [peerError, setPeerError] = useState<string>()
  const [focusCameraId, setFocusCameraId] = useState<string>()
  const focusTimerRef = useRef<number | undefined>(undefined)
  const [staticMode, setStaticMode] = useState(() => readStaticMode(world.id))
  const [view, setView] = useState<WorldViewState>(() => readWorldView(world.id))
  // Whether the character HUD is open is a different question from where the
  // camera points. Tying them meant a user who pulled back to the whole
  // company also lost the chat panel they were talking through.
  const [panelOpen, setPanelOpen] = useState(() => readWorldView(world.id).camera !== 'overview')
  // One store for the whole dock: the walk has to outlive whichever renderer
  // is mounted, or switching 2D to 3D restarts everybody's journey.
  const locomotionRef = useRef(new WorldLocomotion())
  // Keyed on who the conversation is with, not on the session id: a chat can
  // change who it is about without changing its id, and an id that is still
  // undefined on the first render would compare equal to any initial value.
  const autoFocusedEmployeeRef = useRef<string | undefined>('__none__')
  // Arriving at the world is not opening a conversation, and the conversation
  // arrives a render or two after the mount — so the marker is the first
  // character we ever learn about, not the first render. A stored overview
  // means the user last chose to see the whole company; only an actual change
  // of conversation overrules that.
  const settledRef = useRef(false)
  const [characterViewMode, setCharacterViewMode] = useState<CharacterViewMode>(() => readCharacterViewMode(world.id))

  useEffect(() => {
    const latestSpeakerId = latestUtterances[0]?.employeeId
    const nextEmployeeId = sessionKind === 'direct'
      ? selectedEmployeeId ?? conversationEmployeeIds[0]
      : latestSpeakerId !== undefined && conversationEmployeeIds.includes(latestSpeakerId)
        ? latestSpeakerId
        : selectedEmployeeId ?? conversationEmployeeIds[0]
    setActiveEmployeeId(nextEmployeeId)
    // Opening a conversation with somebody is asking to look at them. The
    // camera follows the conversation once per session rather than on every
    // update, so a user who deliberately pulls back to the whole company stays
    // there until they open a different chat.
    if (nextEmployeeId === undefined || autoFocusedEmployeeRef.current === nextEmployeeId) return
    autoFocusedEmployeeRef.current = nextEmployeeId
    const arriving = !settledRef.current
    settledRef.current = true
    if (arriving) return
    // Opening a conversation with somebody opens their panel. It does not move
    // the camera: a user watching the whole company while chatting is a
    // legitimate thing to want, and overruling it would be the old coupling
    // under a new name.
    setPanelOpen(true)
  }, [conversationEmployeeIds, latestUtterances, selectedEmployeeId, sessionId, sessionKind])
  useEffect(() => () => { if (focusTimerRef.current !== undefined) window.clearTimeout(focusTimerRef.current) }, [])
  useEffect(() => {
    if (typeof localStorage !== 'undefined') localStorage.setItem(`dsh-cyber-digital-static:${world.id}`, staticMode ? 'true' : 'false')
  }, [staticMode, world.id])
  useEffect(() => {
    writeWorldView(world.id, view)
  }, [view, world.id])
  useEffect(() => {
    if (typeof localStorage !== 'undefined') localStorage.setItem(`dsh-cyber-character-view:${world.id}`, characterViewMode)
  }, [characterViewMode, world.id])

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
  const threeDimensional = threeDimensionalControl(focusedEmployee)
  const collaborators = conversationEmployees
    .filter((employee) => employee.id !== activeEmployeeId)
    .map((employee) => ({ employee, entity: renderedSnapshot.entities.find((entity) => entity.id === employee.id) }))
  const focused = panelOpen && focusedEmployee !== undefined
  // The world is never torn down to look at somebody. In 3D the character is
  // already in the scene and the camera moves to them; in 2D the existing
  // character panel sits over a world that is still running underneath.
  const showCharacterPanel = focused && focusedEmployee !== undefined
  const embeddedPanel = view.renderer === '3d'

  const enterEmployeeFocus = (employeeId: string) => {
    if (focusTimerRef.current !== undefined) window.clearTimeout(focusTimerRef.current)
    setActiveEmployeeId(employeeId)
    setSelectedObjectId(undefined)
    setContextTarget(undefined)
    setFocusCameraId(employeeId)
    focusTimerRef.current = window.setTimeout(() => {
      setPanelOpen(true)
      setView((current) => viewForFocus({ ...current, camera: 'focus' }, employeeId))
      setFocusCameraId(undefined)
      focusTimerRef.current = undefined
    }, 190)
  }

  const selectRendererMode = (renderer: WorldRendererMode) => {
    setView((current) => reconcileView({ ...current, renderer }))
    if (renderer === '2d' || renderer === '3d') setCharacterViewMode(renderer)
  }

  const selectCameraMode = (camera: WorldCameraMode) => {
    // Asking for a close camera with nobody chosen means "somebody": falling
    // back to the whole company would make the control look broken, and
    // disabling it hides a mode the world can perfectly well offer.
    const subject = activeEmployeeId
      ?? renderedSnapshot.entities.find((entity) => entity.kind === 'agent')?.id
    if (camera !== 'overview' && subject !== undefined && activeEmployeeId === undefined) {
      setActiveEmployeeId(subject)
    }
    setPanelOpen(camera !== 'overview')
    setView((current) => viewForFocus(reconcileView({ ...current, camera }), subject))
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
            <button type="button" role="tab" aria-selected={view.renderer === '2d'} className={view.renderer === '2d' ? 'is-active' : ''} onClick={() => selectRendererMode('2d')}><ImageSquare size={15} aria-hidden="true" />2D</button>
            <button type="button" role="tab" {...(threeDimensional.available ? {} : { 'aria-label': threeDimensional.title })} aria-selected={view.renderer === '3d'} className={`${view.renderer === '3d' ? 'is-active' : ''}${threeDimensional.available ? '' : ' is-setup'}`} title={threeDimensional.title} onClick={() => selectRendererMode('3d')}><Cube size={15} aria-hidden="true" />{threeDimensional.label}</button>
          </div>
          <div className="world-runtime-dock__camera-switch" role="tablist" aria-label="世界镜头">
            {cameraModesFor(view.renderer).map((mode) => <button key={mode} type="button" role="tab" aria-selected={view.camera === mode} className={view.camera === mode ? 'is-active' : ''} disabled={mode !== 'overview' && !renderedSnapshot.entities.some((entity) => entity.kind === 'agent')} onClick={() => selectCameraMode(mode)}>{CAMERA_LABELS[mode]}</button>)}
          </div>
          <div className={`world-runtime-dock__overview${showCharacterPanel && !embeddedPanel ? ' is-focused' : focusCameraId !== undefined ? ' is-focusing' : ''}`}>
          <WorldCanvas
            manifest={runtime.manifest}
            rendererKind={rendererKindFor(view.renderer)}
            locomotion={locomotionRef.current}
            cameraMode={view.camera}
            resolveAvatarUrl={(entityId) => employees.find((employee) => employee.id === entityId)?.avatarAssetUrl}
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
          {!showCharacterPanel ? null : <EmployeeFocusMode key={focusedEmployee.id} world={world} employee={focusedEmployee} {...(dossiers[focusedEmployee.id]?.profile === undefined ? {} : { profile: dossiers[focusedEmployee.id]!.profile })} {...(focusedEntity === undefined ? {} : { entity: focusedEntity })} collaborators={collaborators} connected={runtime.connected} staticMode={staticMode} rendererMode={view.renderer} embedded={embeddedPanel} {...(focusedUtterance === undefined ? {} : { latestUtterance: focusedUtterance })} onFocusEmployee={setActiveEmployeeId} onManageAvatar={() => onManageAvatar(focusedEmployee.id)} onStaticModeChange={setStaticMode} onVoiceFinal={onVoiceFinal} />}

          {selectedEmployee === undefined || contextTarget?.kind !== 'employee' || contextTarget.id !== selectedEmployee.id ? null : <EmployeeInteractionMenu employee={selectedEmployee} position={contextTarget.position} onClose={() => setContextTarget(undefined)} onTalk={() => void interactWithEmployee('talk')} onAssignTask={() => void interactWithEmployee('assign-task')} onMeeting={() => void interactWithEmployee('start-meeting')} onPeerCollaboration={() => { setPeerError(undefined); setPeerInitiatorId(selectedEmployee.id) }} />}
          {selectedObject === undefined || selectedObjectManifest === undefined || contextTarget?.kind !== 'object' || contextTarget.id !== selectedObject.id ? null : <ObjectInteractionMenu object={selectedObject} manifest={selectedObjectManifest} position={contextTarget.position} {...(selectedEmployee === undefined ? {} : { selectedEmployee })} onClose={() => setContextTarget(undefined)} onAction={(action) => void actOnObject(action)} />}

          {<div className="world-runtime-dock__controls" aria-label="世界视图控制">
            <button type="button" aria-label="缩小" onClick={() => setZoomCommand(createZoomCommand(-0.1))}><Minus size={15} /></button>
            <button type="button" aria-label="显示全景" title="适应窗口且不露出场景边界" onClick={() => setFitRequest((value) => value + 1)}><ArrowsOut size={15} /></button>
            <button type="button" aria-label="放大" onClick={() => setZoomCommand(createZoomCommand(0.1))}><Plus size={15} /></button>
            <button type="button" aria-label="世界场景" title="选择只属于当前世界的独立场景" onClick={() => setSceneSettingsOpen(true)}><MapTrifold size={16} /></button>
            <button type="button" aria-label="世界活力设置" title="配置角色有岗位逻辑的日常行为" onClick={() => setAmbientSettingsOpen(true)}><PersonSimpleWalk size={16} /></button>
            <button type="button" className={runtime.snapshot.clock.lightsOn ? 'is-active' : ''} aria-label={runtime.snapshot.clock.lightsOn ? '关闭场景照明' : '打开场景照明'} onClick={() => void runtime.interact({ action: 'toggle-lights', actorId: 'owner' })}><LightbulbFilament size={16} /></button>
          </div>}

          {ambientSettingsOpen ? <AmbientLifeDialog worldId={world.id} worldName={world.name} onClose={() => setAmbientSettingsOpen(false)} /> : null}
          {sceneSettingsOpen ? <WorldSceneDialog world={world} currentManifest={runtime.manifest} onClose={() => setSceneSettingsOpen(false)} onApplied={runtime.reloadScene} /> : null}

          {employees.length === 0 ? <div className="world-runtime-dock__empty"><strong>这个世界还没有角色</strong><span>请到右侧「角色」新增角色。世界视图只负责展示和互动，不再承担角色管理。</span></div> : null}
        </div>
      </section>
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


function readCharacterViewMode(worldId: string): CharacterViewMode {
  if (typeof localStorage === 'undefined') return '2d'
  const value = localStorage.getItem(`dsh-cyber-character-view:${worldId}`)
  if (value === '2d' || value === '3d') return value
  const legacy = localStorage.getItem(`dsh-cyber-world-view:${worldId}`)
  return legacy === '3d' ? '3d' : '2d'
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

const CAMERA_LABELS: Record<WorldCameraMode, string> = {
  overview: '全景',
  focus: '聚焦',
  follow: '跟随',
}

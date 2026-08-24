import {
  ArrowsOut,
  Buildings,
  LightbulbFilament,
  Minus,
  Plus,
  PersonSimpleWalk,
} from '@phosphor-icons/react'
import { useEffect, useState } from 'react'
import type { WorkSession, World, WorldInteractionAction, WorldRuntimeSnapshot, WorldZoomCommand } from '@dsh-cyber/contracts'

import { api } from '../../api.js'
import { PeerCollaborationDialog, type PeerCollaborationDraft } from '../../components/PeerCollaborationDialog.js'
import type { CyberEmployee } from '../../types.js'
import { AmbientLifeDialog } from './AmbientLifeDialog.js'
import { WorldCanvas } from './WorldCanvas.js'
import { EmployeeInteractionMenu, ObjectInteractionMenu } from './WorldInteractionMenu.js'
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
  selectedEmployeeId?: string
  conversationEmployeeIds: string[]
  onSelectEmployee(employeeId: string): void
  onStartGroup(employeeIds: string[], session?: WorkSession): void
}

export function WorldRuntimeDock({ demoMode, world, employees, selectedEmployeeId, conversationEmployeeIds, onSelectEmployee, onStartGroup }: WorldRuntimeDockProps) {
  const runtime = useWorldClient({ demoMode, world, employees })
  const [fitRequest, setFitRequest] = useState(0)
  const [zoomCommand, setZoomCommand] = useState<WorldZoomCommand>()
  const [selectedObjectId, setSelectedObjectId] = useState<string>()
  const [activeEmployeeId, setActiveEmployeeId] = useState<string | undefined>(selectedEmployeeId)
  const [contextTarget, setContextTarget] = useState<WorldContextTarget>()
  const [ambientSettingsOpen, setAmbientSettingsOpen] = useState(false)
  const [peerInitiatorId, setPeerInitiatorId] = useState<string>()
  const [peerBusy, setPeerBusy] = useState(false)
  const [peerError, setPeerError] = useState<string>()

  useEffect(() => setActiveEmployeeId(selectedEmployeeId), [selectedEmployeeId])

  if (runtime.loading || runtime.snapshot === undefined) {
    return <div className="world-runtime-dock world-runtime-dock--loading"><Buildings size={28} /><strong>正在恢复实时世界</strong><span>同步角色位置、任务状态和场景主题…</span></div>
  }

  const renderedSnapshot = withCharacterVisuals(runtime.snapshot, employees)
  const selectedEmployee = employees.find((employee) => employee.id === activeEmployeeId)
  const peerInitiator = employees.find((employee) => employee.id === peerInitiatorId)
  const selectedObject = renderedSnapshot.objects.find((object) => object.id === selectedObjectId)
  const selectedObjectManifest = runtime.manifest.scenes.find((scene) => scene.id === renderedSnapshot.sceneId)?.interactables.find((object) => object.id === selectedObjectId)
  const focusedNames = conversationEmployeeIds.map((employeeId) => employees.find((employee) => employee.id === employeeId)?.displayName).filter((name): name is string => name !== undefined)

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
        <header className="world-runtime-dock__header">
          <div className="world-runtime-dock__identity"><span className="world-runtime-dock__mark"><Buildings size={17} weight="fill" /></span><span><strong>{world.name}</strong><small>{runtime.manifest.displayName}</small></span></div>
          <div className="world-runtime-dock__status"><i className={runtime.connected ? 'is-online' : 'is-offline'} /><span>{runtime.connected ? '实时同步' : '正在重连'}</span><b>{employees.length} 人</b></div>
        </header>

        <div className="world-runtime-dock__canvas">
          <WorldCanvas
            manifest={runtime.manifest}
            rendererIdentity={runtime.rendererIdentity}
            snapshot={renderedSnapshot}
            cues={runtime.cues}
            {...(activeEmployeeId === undefined ? {} : { selectedEntityId: activeEmployeeId })}
            {...(selectedObjectId === undefined ? {} : { selectedObjectId })}
            fitRequest={fitRequest}
            {...(zoomCommand === undefined ? {} : { zoomCommand })}
            onEntitySelect={(employeeId) => { setActiveEmployeeId(employeeId); setSelectedObjectId(undefined); setContextTarget(undefined) }}
            onObjectSelect={(objectId) => { setSelectedObjectId(objectId); setContextTarget(undefined) }}
            onEntityContext={(employeeId, position) => { setActiveEmployeeId(employeeId); setSelectedObjectId(undefined); setContextTarget({ kind: 'employee', id: employeeId, position }) }}
            onObjectContext={(objectId, position) => { setSelectedObjectId(objectId); setContextTarget({ kind: 'object', id: objectId, position }) }}
            onReady={() => undefined}
          />

          {focusedNames.length === 0 ? null : <div className="world-runtime-dock__focus" aria-label="当前会话成员"><span>当前会话</span><strong>{focusedNames.join('、')}</strong></div>}

          {selectedEmployee === undefined || contextTarget?.kind !== 'employee' || contextTarget.id !== selectedEmployee.id ? null : <EmployeeInteractionMenu employee={selectedEmployee} position={contextTarget.position} onClose={() => setContextTarget(undefined)} onTalk={() => void interactWithEmployee('talk')} onAssignTask={() => void interactWithEmployee('assign-task')} onMeeting={() => void interactWithEmployee('start-meeting')} onPeerCollaboration={() => { setPeerError(undefined); setPeerInitiatorId(selectedEmployee.id) }} />}
          {selectedObject === undefined || selectedObjectManifest === undefined || contextTarget?.kind !== 'object' || contextTarget.id !== selectedObject.id ? null : <ObjectInteractionMenu object={selectedObject} manifest={selectedObjectManifest} position={contextTarget.position} {...(selectedEmployee === undefined ? {} : { selectedEmployee })} onClose={() => setContextTarget(undefined)} onAction={(action) => void actOnObject(action)} />}

          <div className="world-runtime-dock__controls" aria-label="世界视图控制">
            <button type="button" aria-label="缩小" onClick={() => setZoomCommand(createZoomCommand(-0.1))}><Minus size={15} /></button>
            <button type="button" aria-label="显示全景" title="适应窗口且不露出场景边界" onClick={() => setFitRequest((value) => value + 1)}><ArrowsOut size={15} /></button>
            <button type="button" aria-label="放大" onClick={() => setZoomCommand(createZoomCommand(0.1))}><Plus size={15} /></button>
            <button type="button" aria-label="世界活力设置" title="配置角色有岗位逻辑的日常行为" onClick={() => setAmbientSettingsOpen(true)}><PersonSimpleWalk size={16} /></button>
            <button type="button" className={runtime.snapshot.clock.lightsOn ? 'is-active' : ''} aria-label={runtime.snapshot.clock.lightsOn ? '关闭场景照明' : '打开场景照明'} onClick={() => void runtime.interact({ action: 'toggle-lights', actorId: 'owner' })}><LightbulbFilament size={16} /></button>
          </div>

          {ambientSettingsOpen ? <AmbientLifeDialog worldId={world.id} worldName={world.name} onClose={() => setAmbientSettingsOpen(false)} /> : null}

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

function withCharacterVisuals(snapshot: WorldRuntimeSnapshot, employees: CyberEmployee[]): WorldRuntimeSnapshot {
  const visualIndex = new Map(employees.map((employee) => [employee.id, employee.avatarIndex]))
  return {
    ...snapshot,
    entities: snapshot.entities.map((entity) => {
      const rosterIndex = visualIndex.get(entity.id)
      return rosterIndex === undefined ? entity : { ...entity, visualState: { ...entity.visualState, rosterIndex } }
    }),
  }
}

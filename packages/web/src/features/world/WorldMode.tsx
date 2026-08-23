import {
  ArrowsOut,
  Buildings,
  ChatCircleDots,
  LightbulbFilament,
  Minus,
  Plus,
  Storefront,
  UsersThree,
  X,
} from '@phosphor-icons/react'
import { useMemo, useState } from 'react'
import type {
  ChatAttachment,
  WorkMessage,
  WorkSession,
  World,
  WorldInteractionAction,
  WorldZoomCommand,
} from '@dsh-cyber/contracts'

import { ChatWorkbench } from '../../components/ChatWorkbench.js'
import type { CyberEmployee } from '../../types.js'
import { WorldCanvas } from './WorldCanvas.js'
import { EmployeeInteractionMenu, ObjectInteractionMenu } from './WorldInteractionMenu.js'
import { useWorldClient } from './world-client-store.js'
import { createZoomCommand } from './zoom-command.js'

interface WorldModeProps {
  demoMode: boolean
  world: World
  employees: CyberEmployee[]
  session?: WorkSession
  messages: WorkMessage[]
  sending: boolean
  draft: string
  selectedEmployeeId?: string
  onDraftChange(value: string): void
  onSend(prompt: string, attachments: ChatAttachment[]): Promise<void>
  onUploadAttachment(file: File): Promise<ChatAttachment>
  onDirectEmployee(employee: CyberEmployee): void
  onSelectEmployee(employeeId?: string): void
  onOpenDossier(employeeId: string): void
  onOpenArtifact(): void
  onRecruit(): void
}

export function WorldMode({
  demoMode,
  world,
  employees,
  session,
  messages,
  sending,
  draft,
  selectedEmployeeId,
  onDraftChange,
  onSend,
  onUploadAttachment,
  onDirectEmployee,
  onSelectEmployee,
  onOpenDossier,
  onOpenArtifact,
  onRecruit,
}: WorldModeProps) {
  const runtime = useWorldClient({ demoMode, world, employees })
  const [selectedObjectId, setSelectedObjectId] = useState<string>()
  const [chatOpen, setChatOpen] = useState(false)
  const [fitRequest, setFitRequest] = useState(1)
  const [zoomCommand, setZoomCommand] = useState<WorldZoomCommand>()
  const [rendererMetrics, setRendererMetrics] = useState<{ initializationMs: number; assetBytesEstimate: number }>()

  const selectedEmployee = employees.find((employee) => employee.id === selectedEmployeeId)
  const selectedObject = runtime.snapshot?.objects.find((object) => object.id === selectedObjectId)
  const selectedObjectManifest = runtime.manifest.scenes
    .find((scene) => scene.id === runtime.snapshot?.sceneId)
    ?.interactables.find((object) => object.id === selectedObjectId)
  const workingCount = runtime.snapshot?.entities.filter((entity) => entity.status === 'working').length ?? 0
  const availableCount = runtime.snapshot?.entities.filter((entity) => entity.status === 'available').length ?? 0
  const activity = useMemo(() => runtime.snapshot?.entities
    .filter((entity) => entity.activity !== 'idle')
    .slice(0, 4) ?? [], [runtime.snapshot])

  const selectEmployee = (employeeId: string) => {
    onSelectEmployee(employeeId)
    setSelectedObjectId(undefined)
  }

  const talkToEmployee = async (employee: CyberEmployee) => {
    onDirectEmployee(employee)
    setChatOpen(true)
    await runtime.interact({ action: 'talk', actorId: 'owner', entityId: employee.id })
  }

  const assignEmployee = async (employee: CyberEmployee) => {
    onDirectEmployee(employee)
    onDraftChange(`@${employee.displayName} 任务：`)
    setChatOpen(true)
    await runtime.interact({ action: 'assign-task', actorId: 'owner', entityId: employee.id, objectId: 'workstation' })
  }

  const inviteAssistance = async (employee: CyberEmployee) => {
    const colleague = employees.find((candidate) => candidate.id !== employee.id)
    const participants = colleague === undefined ? [employee] : [employee, colleague]
    onDraftChange(`${participants.map((participant) => `@${participant.displayName}`).join(' ')} 请开一个短会，明确主责、协助项和交付标准。`)
    setChatOpen(true)
    await runtime.interact({
      action: 'start-meeting',
      actorId: 'owner',
      participantIds: participants.map((participant) => participant.id),
    })
  }

  const actOnObject = async (action: WorldInteractionAction) => {
    if (selectedObject === undefined) return
    if (action === 'start-meeting') {
      const participants = selectedEmployee === undefined
        ? employees.slice(0, 3)
        : [selectedEmployee, ...employees.filter((employee) => employee.id !== selectedEmployee.id).slice(0, 2)]
      if (participants.length > 0) {
        setChatOpen(true)
        onDraftChange(`${participants.map((participant) => `@${participant.displayName}`).join(' ')} 围绕当前任务开一个短会。`)
        await runtime.interact({ action, actorId: 'owner', objectId: selectedObject.id, participantIds: participants.map((participant) => participant.id) })
      }
      return
    }
    await runtime.interact({
      action,
      actorId: 'owner',
      objectId: selectedObject.id,
      ...(selectedEmployee === undefined ? {} : { entityId: selectedEmployee.id }),
    })
    if (action === 'assign-task' && selectedEmployee !== undefined) {
      onDirectEmployee(selectedEmployee)
      onDraftChange(`@${selectedEmployee.displayName} 任务：`)
      setChatOpen(true)
    }
  }

  if (runtime.loading || runtime.snapshot === undefined) {
    return (
      <main className="world-runtime world-runtime--loading">
        <Buildings size={32} />
        <strong>正在恢复世界运行状态</strong>
        <span>加载场景、角色位置和持久化事件…</span>
      </main>
    )
  }

  return (
    <main className="world-runtime" aria-label={`${world.name}互动世界`}>
      <WorldCanvas
        manifest={runtime.manifest}
        rendererIdentity={runtime.rendererIdentity}
        snapshot={runtime.snapshot}
        cues={runtime.cues}
        {...(selectedEmployeeId === undefined ? {} : { selectedEntityId: selectedEmployeeId })}
        {...(selectedObjectId === undefined ? {} : { selectedObjectId })}
        fitRequest={fitRequest}
        {...(zoomCommand === undefined ? {} : { zoomCommand })}
        onEntitySelect={selectEmployee}
        onObjectSelect={(objectId) => setSelectedObjectId(objectId)}
        onReady={setRendererMetrics}
      />

      <header className="world-hud world-hud--identity">
        <div className="world-hud__mark"><Buildings size={19} weight="fill" /></div>
        <div>
          <span>{runtime.manifest.displayName}</span>
          <strong>{world.name}</strong>
        </div>
        <i className={runtime.connected ? 'is-online' : 'is-offline'} />
        <small>{runtime.connected ? '实时连接' : '正在重连'}</small>
      </header>

      <section className="world-hud world-hud--stats" aria-label="世界状态">
        <div><strong>{employees.length}</strong><span>机器人</span></div>
        <div><strong>{workingCount}</strong><span>执行中</span></div>
        <div><strong>{availableCount}</strong><span>可接任务</span></div>
        <button type="button" onClick={onRecruit}><Storefront size={16} /><span>临时雇佣</span></button>
      </section>

      <div className="world-hud world-hud--camera" aria-label="世界视图控制">
        <button type="button" aria-label="缩小" onClick={() => setZoomCommand(createZoomCommand(-0.1))}><Minus size={15} /></button>
        <button type="button" aria-label="适应窗口" onClick={() => setFitRequest((value) => value + 1)}><ArrowsOut size={15} /></button>
        <button type="button" aria-label="放大" onClick={() => setZoomCommand(createZoomCommand(0.1))}><Plus size={15} /></button>
        <button
          type="button"
          className={runtime.snapshot.clock.lightsOn ? 'is-active' : ''}
          aria-label={runtime.snapshot.clock.lightsOn ? '关闭场景照明' : '打开场景照明'}
          onClick={() => void runtime.interact({ action: 'toggle-lights', actorId: 'owner' })}
        ><LightbulbFilament size={16} /></button>
      </div>

      <section className="world-hud world-hud--activity" aria-label="实时活动">
        <header><span>实时活动</span><strong>{workingCount > 0 ? `${workingCount} 项执行中` : '等待指派'}</strong></header>
        {activity.length === 0 ? <p>点击一名机器人，直接对话或安排任务。</p> : activity.map((entity) => (
          <button key={entity.id} type="button" onClick={() => selectEmployee(entity.id)}>
            <i className={`status-pip status-pip--${entity.status ?? 'waiting'}`} />
            <span><strong>{entity.displayName}</strong><small>{entity.activityLabel}</small></span>
          </button>
        ))}
      </section>

      <button className="world-chat-launcher" type="button" onClick={() => setChatOpen(true)}>
        <ChatCircleDots size={19} />
        <span><strong>{session?.title ?? '任务频道'}</strong><small>{messages.length} 条记录 · 独立 Agent 上下文</small></span>
      </button>

      {selectedEmployee === undefined ? null : (
        <EmployeeInteractionMenu
          employee={selectedEmployee}
          onClose={() => onSelectEmployee(undefined)}
          onTalk={() => void talkToEmployee(selectedEmployee)}
          onAssignTask={() => void assignEmployee(selectedEmployee)}
          onMeeting={() => void inviteAssistance(selectedEmployee)}
          onDossier={() => onOpenDossier(selectedEmployee.id)}
        />
      )}

      {selectedObject === undefined || selectedObjectManifest === undefined ? null : (
        <ObjectInteractionMenu
          object={selectedObject}
          manifest={selectedObjectManifest}
          {...(selectedEmployee === undefined ? {} : { selectedEmployee })}
          onClose={() => setSelectedObjectId(undefined)}
          onAction={(action) => void actOnObject(action)}
        />
      )}

      {employees.length === 0 ? (
        <section className="world-empty-roster">
          <Storefront size={30} />
          <strong>这个世界还没有机器人</strong>
          <p>按任务临时雇佣一名角色。每名角色拥有独立会话、记忆和成长档案。</p>
          <button className="primary-button" type="button" onClick={onRecruit}>打开角色市场</button>
        </section>
      ) : null}

      <aside className={`world-chat-drawer${chatOpen ? ' is-open' : ''}`} aria-hidden={!chatOpen}>
        <div className="world-chat-drawer__bar">
          <span><UsersThree size={16} />任务频道</span>
          <button type="button" aria-label="关闭任务频道" onClick={() => setChatOpen(false)}><X size={17} /></button>
        </div>
        <ChatWorkbench
          demoMode={demoMode}
          world={world}
          {...(session === undefined ? {} : { session })}
          messages={messages}
          employees={employees}
          sending={sending}
          draft={draft}
          permissionMode="read-only"
          onPermissionModeChange={() => undefined}
          onDraftChange={onDraftChange}
          onSend={onSend}
          onUploadAttachment={onUploadAttachment}
          onOpenDossier={onOpenDossier}
          onOpenArtifact={onOpenArtifact}
          onRecruit={onRecruit}
        />
      </aside>

      <footer className="world-runtime__telemetry">
        <span>事件 #{runtime.snapshot.sequence}</span>
        <span>{rendererMetrics === undefined ? '渲染器启动中' : `${Math.round(rendererMetrics.initializationMs)}ms 初始化`}</span>
        <span>{runtime.snapshot.clock.lightsOn ? '照明开启' : '夜间模式'}</span>
      </footer>
    </main>
  )
}

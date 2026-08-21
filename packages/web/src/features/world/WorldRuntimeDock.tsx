import {
  ArrowsOut,
  Buildings,
  LightbulbFilament,
  Minus,
  Plus,
  Storefront,
} from '@phosphor-icons/react'
import { useState } from 'react'
import type { World, WorldZoomCommand } from '@dsh-cyber/contracts'

import type { CyberEmployee } from '../../types.js'
import { WorldCanvas } from './WorldCanvas.js'
import { useWorldClient } from './world-client-store.js'
import { createZoomCommand } from './zoom-command.js'

interface WorldRuntimeDockProps {
  demoMode: boolean
  world: World
  employees: CyberEmployee[]
  selectedEmployeeId?: string
  conversationEmployeeIds: string[]
  onSelectEmployee(employeeId: string): void
  onRecruit(): void
}

export function WorldRuntimeDock({
  demoMode,
  world,
  employees,
  selectedEmployeeId,
  conversationEmployeeIds,
  onSelectEmployee,
  onRecruit,
}: WorldRuntimeDockProps) {
  const runtime = useWorldClient({ demoMode, world, employees })
  const [fitRequest, setFitRequest] = useState(0)
  const [zoomCommand, setZoomCommand] = useState<WorldZoomCommand>()
  const [selectedObjectId, setSelectedObjectId] = useState<string>()

  if (runtime.loading || runtime.snapshot === undefined) {
    return (
      <div className="world-runtime-dock world-runtime-dock--loading">
        <Buildings size={28} />
        <strong>正在恢复实时世界</strong>
        <span>同步角色位置、任务状态和场景主题…</span>
      </div>
    )
  }

  const focusedNames = conversationEmployeeIds
    .map((employeeId) => employees.find((employee) => employee.id === employeeId)?.displayName)
    .filter((name): name is string => name !== undefined)

  return (
    <section className="world-runtime-dock" aria-label={`${world.name}实时世界`}>
      <header className="world-runtime-dock__header">
        <div className="world-runtime-dock__identity">
          <span className="world-runtime-dock__mark"><Buildings size={17} weight="fill" /></span>
          <span><strong>{world.name}</strong><small>{runtime.manifest.displayName}</small></span>
        </div>
        <div className="world-runtime-dock__status">
          <i className={runtime.connected ? 'is-online' : 'is-offline'} />
          <span>{runtime.connected ? '实时同步' : '正在重连'}</span>
          <b>{employees.length} 人</b>
        </div>
      </header>

      <div className="world-runtime-dock__canvas">
        <WorldCanvas
          manifest={runtime.manifest}
          rendererIdentity={runtime.rendererIdentity}
          snapshot={runtime.snapshot}
          cues={runtime.cues}
          {...(selectedEmployeeId === undefined ? {} : { selectedEntityId: selectedEmployeeId })}
          {...(selectedObjectId === undefined ? {} : { selectedObjectId })}
          fitRequest={fitRequest}
          {...(zoomCommand === undefined ? {} : { zoomCommand })}
          onEntitySelect={onSelectEmployee}
          onObjectSelect={setSelectedObjectId}
          onReady={() => undefined}
        />

        {focusedNames.length === 0 ? null : (
          <div className="world-runtime-dock__focus" aria-label="当前会话成员">
            <span>当前会话</span>
            <strong>{focusedNames.join('、')}</strong>
          </div>
        )}

        <div className="world-runtime-dock__controls" aria-label="世界视图控制">
          <button type="button" aria-label="缩小" onClick={() => setZoomCommand(createZoomCommand(-0.1))}><Minus size={15} /></button>
          <button type="button" aria-label="显示全景" title="显示完整场景" onClick={() => setFitRequest((value) => value + 1)}><ArrowsOut size={15} /></button>
          <button type="button" aria-label="放大" onClick={() => setZoomCommand(createZoomCommand(0.1))}><Plus size={15} /></button>
          <button
            type="button"
            className={runtime.snapshot.clock.lightsOn ? 'is-active' : ''}
            aria-label={runtime.snapshot.clock.lightsOn ? '关闭场景照明' : '打开场景照明'}
            onClick={() => void runtime.interact({ action: 'toggle-lights', actorId: 'owner' })}
          ><LightbulbFilament size={16} /></button>
        </div>

        {employees.length === 0 ? (
          <div className="world-runtime-dock__empty">
            <Storefront size={25} />
            <strong>这个世界还没有员工</strong>
            <span>从人才市场添加第一名员工后，他会出现在这里。</span>
            <button className="primary-button" type="button" onClick={onRecruit}>打开人才市场</button>
          </div>
        ) : null}
      </div>
    </section>
  )
}

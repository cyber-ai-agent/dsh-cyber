import {
  ArrowsInSimple,
  ArrowsOutSimple,
  Lightbulb,
  Minus,
  Moon,
  Plus,
  Sun,
  UsersThree,
  X,
} from '@phosphor-icons/react'
import { useMemo, useState, type CSSProperties } from 'react'
import type { World } from '@dsh-cyber/contracts'

import type { CyberEmployee } from '../types.js'
import { worldExperience } from '../world-experience.js'
import { Avatar } from './Avatar.js'
import { AuthorityBadge } from './AuthorityBadge.js'
import { StatusDot } from './StatusDot.js'

interface WorldViewProps {
  world: World
  employees: CyberEmployee[]
  sceneImage?: string
  onSelectEmployee(employeeId: string): void
}

const companyPositions = [
  [22, 27], [49, 25], [77, 28], [22, 66], [50, 66], [78, 65], [66, 47], [36, 47],
] as const

const tavernPositions = [
  [23, 56], [43, 45], [64, 49], [79, 62], [57, 71], [35, 72], [17, 76], [84, 36],
] as const

export function WorldView({ world, employees, sceneImage, onSelectEmployee }: WorldViewProps) {
  const [lightsOn, setLightsOn] = useState(true)
  const [zoom, setZoom] = useState(1)
  const [expanded, setExpanded] = useState(false)
  const experience = worldExperience(world)
  const working = employees.filter((employee) => employee.status === 'working').length

  const scene = useMemo(() => (
    <WorldScene
      kind={experience.kind}
      employees={employees}
      {...(sceneImage === undefined ? {} : { sceneImage })}
      lightsOn={lightsOn}
      zoom={zoom}
      onSelectEmployee={onSelectEmployee}
    />
  ), [employees, experience.kind, lightsOn, onSelectEmployee, sceneImage, zoom])

  return (
    <div className={`world-view world-view--${experience.kind}`}>
      <header className="world-view__header">
        <div>
          <strong>{world.name} · {experience.sceneTitle}</strong>
          <span>{experience.sceneSubtitle}</span>
        </div>
        <div className="world-view__stats">
          <StatusDot status="healthy" label="实时运行" />
          <span><UsersThree size={14} />{employees.length} 名{experience.personLabel}</span>
          <span>{working} 名行动中</span>
        </div>
      </header>

      <div className="world-view__viewport">
        {scene}
        <WorldControls lightsOn={lightsOn} zoom={zoom} setLightsOn={setLightsOn} setZoom={setZoom} />
      </div>

      <footer className="world-view__footer">
        <span>点击角色进入对应会话 · 角色新增与管理统一在「角色」中完成</span>
        <button type="button" onClick={() => setExpanded(true)}><ArrowsOutSimple size={14} />沉浸模式</button>
      </footer>

      {expanded ? (
        <div className="world-expanded" role="dialog" aria-modal="true" aria-label={`${world.name}沉浸世界`}>
          <header>
            <div><strong>{world.name} · {experience.sceneTitle}</strong><span>{experience.sceneSubtitle}</span></div>
            <button type="button" onClick={() => setExpanded(false)}><X size={20} />关闭</button>
          </header>
          <div className="world-expanded__scene">{scene}</div>
          <div className="world-expanded__tools">
            <button type="button" onClick={() => setZoom(1)}><ArrowsInSimple size={15} />适应画面</button>
            <button type="button" onClick={() => setLightsOn((value) => !value)}><Lightbulb size={15} />{lightsOn ? '关闭场景灯' : '打开场景灯'}</button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function WorldControls({ lightsOn, zoom, setLightsOn, setZoom }: {
  lightsOn: boolean
  zoom: number
  setLightsOn(value: (current: boolean) => boolean): void
  setZoom(value: (current: number) => number): void
}) {
  return (
    <div className="world-controls" aria-label="世界显示控制">
      <button type="button" aria-label="缩小世界" disabled={zoom <= .8} onClick={() => setZoom((value) => Math.max(.8, value - .1))}><Minus size={14} /></button>
      <button type="button" aria-label="恢复世界缩放" onClick={() => setZoom(() => 1)}>{Math.round(zoom * 100)}%</button>
      <button type="button" aria-label="放大世界" disabled={zoom >= 1.6} onClick={() => setZoom((value) => Math.min(1.6, value + .1))}><Plus size={14} /></button>
      <button type="button" className={lightsOn ? 'is-active' : ''} onClick={() => setLightsOn((value) => !value)}>{lightsOn ? <Sun size={14} /> : <Moon size={14} />}{lightsOn ? '关灯' : '开灯'}</button>
    </div>
  )
}

function WorldScene({ kind, employees, sceneImage, lightsOn, zoom, onSelectEmployee }: {
  kind: 'personal' | 'company' | 'tavern' | 'studio' | 'observatory'
  employees: CyberEmployee[]
  sceneImage?: string
  lightsOn: boolean
  zoom: number
  onSelectEmployee(employeeId: string): void
}) {
  const isTavern = kind === 'tavern'
  const currentSkin = typeof document !== 'undefined' ? document.documentElement.dataset.skin : undefined
  const defaultScene = currentSkin === 'maid-atelier' ? '/assets/maid-palace-world.png' : (isTavern ? '/assets/moonlit-tavern-world.png' : '/assets/cyber-office-world-clean.png')
  const positions = isTavern ? tavernPositions : companyPositions
  const image = sceneImage ?? defaultScene
  const activeSpeaker = employees.find((employee) => employee.status === 'working')

  return (
    <div className={`world-stage world-stage--${kind}`}>
      <div className={`world-canvas world-canvas--${kind} ${lightsOn ? 'lights-on' : 'lights-off'}`} style={{ '--world-zoom': zoom } as CSSProperties}>
        <img src={image} alt={isTavern ? '月光下的奇幻酒馆场景' : '赛博公司的实时世界场景'} />
        {isTavern ? (
          <>
            <div className="tavern-scene-card">
              <span>当前场景</span>
              <strong>雨夜 · 壁炉旁的陌生委托</strong>
              <small>{activeSpeaker === undefined ? '等待角色入场' : `${activeSpeaker.displayName} 正在发言`}</small>
            </div>
            <div className="tavern-turn-order"><span>发言策略</span><strong>自然顺序</strong><small>@ 点名可强制下一位角色</small></div>
          </>
        ) : null}

        {employees.length === 0 ? (
          <div className="world-empty-cast">
            <strong>{isTavern ? '今夜尚无人登场' : '这个世界还没有角色'}</strong>
            <span>{isTavern ? '前往右侧「角色」邀请角色进入场景。' : '前往右侧「角色」新增角色后，真实任务状态会在这里发生。'}</span>
          </div>
        ) : employees.map((employee, index) => {
          const position = positions[index] ?? [50 + ((index % 3) - 1) * 15, 76 + (index % 2) * 6]
          return (
            <button
              key={employee.id}
              className={`world-agent world-agent--${employee.status}${activeSpeaker?.id === employee.id ? ' is-speaking' : ''}`}
              type="button"
              style={{ left: `${position[0]}%`, top: `${position[1]}%`, zIndex: Math.round(position[1]) }}
              onClick={() => onSelectEmployee(employee.id)}
              aria-label={`进入${employee.displayName}的会话`}
            >
              <span className="world-agent__sprite"><Avatar index={employee.avatarIndex} size="world" label={employee.displayName} authorityRole={employee.authorityRole} /></span>
              <span className="world-agent__label"><strong>{employee.displayName}<AuthorityBadge role={employee.authorityRole} /></strong><small>{activityLabel(employee, isTavern)}</small></span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function activityLabel(employee: CyberEmployee, roleplay: boolean): string {
  if (employee.status === 'blocked') return roleplay ? '剧情等待中' : '等待推进'
  if (employee.status === 'waiting') return roleplay ? '等待发言' : '等待任务'
  if (employee.status === 'available') return roleplay ? '可被点名' : '可接任务'
  return employee.currentActivity
}

import {
  ArrowsInSimple,
  ArrowsOutSimple,
  Buildings,
  Lightbulb,
  Minus,
  Moon,
  Plus,
  Sun,
  UsersThree,
  X,
} from '@phosphor-icons/react'
import { useEffect, useMemo, useState, type CSSProperties } from 'react'

import type { CyberEmployee } from '../types.js'
import { Avatar } from './Avatar.js'
import { StatusDot } from './StatusDot.js'

interface WorldViewProps {
  worldName: string
  employees: CyberEmployee[]
  sceneImage?: string
  onSelectEmployee(employeeId: string): void
}

const stationPositions = [
  [22, 25], [48, 24], [77, 27], [22, 65], [49, 66], [77, 66], [67, 46], [36, 46],
] as const

export function WorldView({ worldName, employees, sceneImage, onSelectEmployee }: WorldViewProps) {
  const [now, setNow] = useState(() => new Date())
  const [lightsOn, setLightsOn] = useState(true)
  const [zoom, setZoom] = useState(1)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1_000)
    return () => window.clearInterval(timer)
  }, [])

  const working = employees.filter((employee) => employee.status === 'working').length
  const blocked = employees.filter((employee) => employee.status === 'blocked').length
  const metrics = useMemo(() => ({
    queue: employees.filter((employee) => employee.status === 'waiting').length,
    healthy: Math.max(0, employees.length - blocked),
  }), [blocked, employees])

  const scene = (
    <WorldScene
      employees={employees}
      {...(sceneImage === undefined ? {} : { sceneImage })}
      lightsOn={lightsOn}
      now={now}
      zoom={zoom}
      working={working}
      metrics={metrics}
      onSelectEmployee={onSelectEmployee}
    />
  )

  return (
    <div className="world-view">
      <header className="world-view__header">
        <div>
          <strong>{worldName} · 总部办公区</strong>
          <StatusDot status="healthy" label="实时运行" />
        </div>
        <div className="world-view__stats">
          <span><UsersThree size={14} />{employees.length} 人</span>
          <span><Buildings size={14} />{working} 人工作中</span>
        </div>
      </header>
      <div className="world-view__viewport">
        {scene}
        <div className="world-activity-rail" aria-label="世界实时活动">
          <header><strong>实时活动</strong><span>{working > 0 ? `${working} 人正在执行` : '全员可接任务'}</span></header>
          <div>
            {employees.length === 0 ? <p>招聘员工后，这里会显示真实会话和工具状态。</p> : employees.map((employee) => (
              <button key={employee.id} type="button" onClick={() => onSelectEmployee(employee.id)}>
                <StatusDot status={employee.status} />
                <span><strong>{employee.displayName}</strong><small>{activityLabel(employee)}</small></span>
              </button>
            ))}
          </div>
        </div>
        <div className="world-controls" aria-label="世界显示控制">
          <button type="button" aria-label="缩小世界" disabled={zoom <= .8} onClick={() => setZoom((value) => Math.max(.8, value - .1))}><Minus size={14} /></button>
          <button type="button" onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button>
          <button type="button" aria-label="放大世界" disabled={zoom >= 1.6} onClick={() => setZoom((value) => Math.min(1.6, value + .1))}><Plus size={14} /></button>
          <button type="button" className={lightsOn ? 'is-active' : ''} onClick={() => setLightsOn((value) => !value)}>{lightsOn ? <Sun size={14} /> : <Moon size={14} />}{lightsOn ? '关灯' : '开灯'}</button>
        </div>
      </div>
      <footer className="world-view__footer">
        <span>点击员工查看档案；状态由真实会话驱动</span>
        <button type="button" onClick={() => setExpanded(true)}><ArrowsOutSimple size={14} />展开世界</button>
      </footer>
      {expanded ? (
        <div className="world-expanded" role="dialog" aria-modal="true" aria-label={`${worldName}全景世界`}>
          <header><div><strong>{worldName} · 实时世界</strong><span>{now.toLocaleString('zh-CN', { hour12: false })}</span></div><button type="button" onClick={() => setExpanded(false)}><X size={20} />关闭</button></header>
          <div className="world-expanded__scene">{scene}</div>
          <div className="world-expanded__tools">
            <button type="button" onClick={() => setZoom(1)}><ArrowsInSimple size={15} />适应画面</button>
            <button type="button" onClick={() => setLightsOn((value) => !value)}><Lightbulb size={15} />{lightsOn ? '关闭区域灯' : '打开区域灯'}</button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function WorldScene({
  employees,
  sceneImage,
  lightsOn,
  now,
  zoom,
  working,
  metrics,
  onSelectEmployee,
}: {
  employees: CyberEmployee[]
  sceneImage?: string
  lightsOn: boolean
  now: Date
  zoom: number
  working: number
  metrics: { queue: number; healthy: number }
  onSelectEmployee(employeeId: string): void
}) {
  return (
    <div className="world-stage">
      <div className={`world-canvas ${lightsOn ? 'lights-on' : 'lights-off'}`} style={{ '--world-zoom': zoom } as CSSProperties}>
        <img src={sceneImage ?? '/assets/cyber-office-world.png'} alt={sceneImage === undefined ? '赛博公司像素办公室俯视图' : '用户自定义的世界场景'} />
        <div className="world-light world-light--product" />
        <div className="world-light world-light--meeting" />
        <div className="world-light world-light--ops" />
        <div className="world-light world-light--lounge" />
        <div className="world-clock"><span>LOCAL TIME</span><strong>{now.toLocaleTimeString('zh-CN', { hour12: false })}</strong></div>
        <div className="world-slogan"><strong>把复杂留给系统</strong><span>把结果交给老板</span></div>
        <div className="world-screen-feed world-screen-feed--left"><i /><span>运行任务</span><strong>{working}/{employees.length}</strong></div>
        <div className="world-screen-feed world-screen-feed--right"><i /><span>健康角色</span><strong>{metrics.healthy}</strong></div>
        <div className="world-screen-feed world-screen-feed--bottom"><i /><span>等待队列</span><strong>{metrics.queue}</strong></div>
        {employees.map((employee, index) => {
          const position = stationPositions[index] ?? [50 + ((index % 3) - 1) * 16, 78 + (index % 2) * 5]
          const waitingOffset = employee.status === 'waiting' ? 5 : 0
          const blockedOffset = employee.status === 'blocked' ? -4 : 0
          return (
            <button
              key={employee.id}
              className={`world-agent world-agent--${employee.status}`}
              type="button"
              style={{ left: `${position[0] + waitingOffset}%`, top: `${position[1] + blockedOffset}%` }}
              onClick={() => onSelectEmployee(employee.id)}
              aria-label={`查看${employee.displayName}的工作状态和档案`}
            >
              <span className="world-agent__sprite"><Avatar index={employee.avatarIndex} size="world" label={employee.displayName} /></span>
              <span className="world-agent__label"><strong>{employee.displayName}</strong><small>{activityLabel(employee)}</small></span>
            </button>
          )
        })}
        <div className="world-zone world-zone--product">研发区</div>
        <div className="world-zone world-zone--meeting">会议区</div>
        <div className="world-zone world-zone--ops">运维区</div>
        <div className="world-zone world-zone--lounge">休息区</div>
      </div>
    </div>
  )
}

function activityLabel(employee: CyberEmployee): string {
  if (employee.status === 'blocked') return '等待推进'
  if (employee.status === 'waiting') return '等待任务'
  if (employee.status === 'available') return '可接任务'
  return employee.currentActivity
}

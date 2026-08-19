import { ArrowsOutSimple, Buildings, UsersThree } from '@phosphor-icons/react'

import type { CyberEmployee } from '../types.js'
import { Avatar } from './Avatar.js'
import { StatusDot } from './StatusDot.js'

interface WorldViewProps {
  worldName: string
  employees: CyberEmployee[]
  onSelectEmployee(employeeId: string): void
}

const stationPositions = [
  [20, 23], [48, 21], [77, 25], [23, 65], [49, 66], [76, 64], [65, 43], [37, 45],
] as const

export function WorldView({ worldName, employees, onSelectEmployee }: WorldViewProps) {
  const working = employees.filter((employee) => employee.status === 'working').length
  return (
    <div className="world-view">
      <header className="world-view__header">
        <div>
          <strong>{worldName} · 总部办公区</strong>
          <StatusDot status="healthy" label="运行中" />
        </div>
        <div className="world-view__stats">
          <span><UsersThree size={14} />{employees.length} 人</span>
          <span><Buildings size={14} />{working} 人工作中</span>
        </div>
      </header>
      <div className="world-canvas">
        <img src="/assets/cyber-office-world.png" alt="赛博公司像素办公室俯视图" />
        {employees.map((employee, index) => {
          const position = stationPositions[index] ?? stationPositions[0]
          const waitingOffset = employee.status === 'waiting' ? 12 : 0
          const blockedOffset = employee.status === 'blocked' ? -10 : 0
          return (
            <button
              key={employee.id}
              className={`world-agent world-agent--${employee.status}`}
              type="button"
              style={{ left: `${position[0] + waitingOffset}%`, top: `${position[1] + blockedOffset}%` }}
              onClick={() => onSelectEmployee(employee.id)}
              aria-label={`查看${employee.displayName}的工作状态和档案`}
            >
              <Avatar index={employee.avatarIndex} size="world" label={employee.displayName} />
              <span><strong>{employee.displayName}</strong><small>{activityLabel(employee)}</small></span>
            </button>
          )
        })}
        <div className="world-zone world-zone--meeting">会议区</div>
        <div className="world-zone world-zone--lounge">休息区</div>
      </div>
      <footer className="world-view__footer">
        <span>角色只按真实状态前往工位、会议区或等待区</span>
        <button type="button"><ArrowsOutSimple size={14} />展开世界</button>
      </footer>
    </div>
  )
}

function activityLabel(employee: CyberEmployee): string {
  if (employee.status === 'blocked') return '等待推进'
  if (employee.status === 'waiting') return '等待任务'
  if (employee.status === 'available') return '可接任务'
  return employee.currentActivity
}


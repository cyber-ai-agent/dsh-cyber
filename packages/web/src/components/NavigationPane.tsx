import {
  Buildings,
  ChatCircleDots,
  ClockCounterClockwise,
  MagnifyingGlass,
  Plus,
  UserFocus,
  Wine,
} from '@phosphor-icons/react'
import { useDeferredValue, useMemo, useState } from 'react'
import type { WorkSession, World } from '@dsh-cyber/contracts'

import type { CyberEmployee } from '../types.js'
import { Avatar } from './Avatar.js'

interface NavigationPaneProps {
  worlds: World[]
  activeWorldId: string
  sessions: WorkSession[]
  activeSessionId?: string
  employees: CyberEmployee[]
  onSelectWorld(worldId: string): void
  onSelectSession(sessionId: string): void
  onSelectEmployee(employeeId: string): void
  onDirectEmployee(employee: CyberEmployee): void
  onCreateWorld(): void
}

export function NavigationPane({
  worlds,
  activeWorldId,
  sessions,
  activeSessionId,
  employees,
  onSelectWorld,
  onSelectSession,
  onSelectEmployee,
  onDirectEmployee,
  onCreateWorld,
}: NavigationPaneProps) {
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query.trim().toLocaleLowerCase())
  const filteredEmployees = useMemo(() => {
    if (!deferredQuery) return employees
    return employees.filter((employee) =>
      `${employee.displayName} ${employee.role} ${employee.currentActivity}`
        .toLocaleLowerCase()
        .includes(deferredQuery),
    )
  }, [deferredQuery, employees])

  return (
    <div className="navigation-pane">
      <header className="pane-heading">
        <span>会话</span>
        <button className="icon-button" type="button" aria-label="新建世界" onClick={onCreateWorld}>
          <Plus size={17} weight="bold" />
        </button>
      </header>

      <section className="nav-section" aria-labelledby="worlds-title">
        <div className="nav-section__title" id="worlds-title">世界</div>
        <div className="world-list">
          {worlds.map((world) => {
            const WorldIcon = world.templateId.includes('tavern') ? Wine : Buildings
            return (
              <button
                key={world.id}
                className={`world-row${world.id === activeWorldId ? ' is-active' : ''}`}
                type="button"
                aria-current={world.id === activeWorldId ? 'page' : undefined}
                onClick={() => onSelectWorld(world.id)}
              >
                <WorldIcon size={19} />
                <span>{world.name}</span>
              </button>
            )
          })}
        </div>
        <p className="isolation-note">切换世界将开启新的会话上下文</p>
      </section>

      <section className="nav-section nav-section--sessions" aria-labelledby="sessions-title">
        <div className="nav-section__title nav-section__title--inline" id="sessions-title">
          <span>当前世界的会话</span>
          <ClockCounterClockwise size={15} />
        </div>
        <div className="session-list">
          {sessions.length === 0 ? (
            <div className="compact-empty">还没有会话，直接 @ 一名员工开始。</div>
          ) : sessions.map((session) => (
            <button
              key={session.id}
              className={`session-row${session.id === activeSessionId ? ' is-active' : ''}`}
              type="button"
              onClick={() => onSelectSession(session.id)}
            >
              <ChatCircleDots size={14} />
              <span className="session-row__title">{session.title}</span>
              <time>{formatSessionTime(session.updatedAt)}</time>
            </button>
          ))}
        </div>
      </section>

      <section className="nav-section nav-section--roles" aria-labelledby="roles-title">
        <div className="nav-section__title nav-section__title--inline" id="roles-title">
          <span>角色（当前世界）</span>
          <span>{employees.length}</span>
        </div>
        <label className="nav-search">
          <MagnifyingGlass size={15} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索角色或任务"
            aria-label="搜索角色或任务"
          />
        </label>
        <div className="employee-list">
          {filteredEmployees.map((employee) => (
            <button
              key={employee.id}
              className="employee-row"
              type="button"
              onClick={() => onSelectEmployee(employee.id)}
              onDoubleClick={() => onDirectEmployee(employee)}
              title="单击查看数字档案，双击直接 @ 本人"
            >
              <Avatar index={employee.avatarIndex} label={employee.displayName} status={employee.status} />
              <span className="employee-row__copy">
                <span className="employee-row__identity">
                  <strong>{employee.displayName}</strong>
                  <span>{employee.role}</span>
                </span>
                <span className="employee-row__activity">{employee.currentActivity}</span>
              </span>
              <UserFocus className="employee-row__action" size={16} />
            </button>
          ))}
        </div>
      </section>
    </div>
  )
}

function formatSessionTime(value: string): string {
  const date = new Date(value)
  const today = new Date()
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  }
  return `${date.getMonth() + 1}-${String(date.getDate()).padStart(2, '0')}`
}


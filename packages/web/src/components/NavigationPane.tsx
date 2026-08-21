import {
  ChatCircleDots,
  ClockCounterClockwise,
  MagnifyingGlass,
  Plus,
  UsersThree,
  UserFocus,
  GearSix,
} from '@phosphor-icons/react'
import { useDeferredValue, useMemo, useState } from 'react'
import type { WorkSession, World } from '@dsh-cyber/contracts'

import type { CyberEmployee, SessionParticipantMap } from '../types.js'
import { worldExperience } from '../world-experience.js'
import { Avatar } from './Avatar.js'

interface NavigationPaneProps {
  world: World
  sessions: WorkSession[]
  activeSessionId?: string
  activeEmployeeIds: string[]
  sessionParticipants: SessionParticipantMap
  employees: CyberEmployee[]
  onSelectSession(sessionId: string): void
  onSelectEmployee(employeeId: string): void
  onDirectEmployee(employee: CyberEmployee): void
  onRecruit(): void
  onCreateGroup(): void
  onWorldSettings(): void
}

export function NavigationPane({
  world,
  sessions,
  activeSessionId,
  activeEmployeeIds,
  sessionParticipants,
  employees,
  onSelectSession,
  onSelectEmployee,
  onDirectEmployee,
  onRecruit,
  onCreateGroup,
  onWorldSettings,
}: NavigationPaneProps) {
  const [query, setQuery] = useState('')
  const experience = worldExperience(world)
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
        <span>会话与通讯录</span>
        <button className="icon-button" type="button" aria-label="创建群聊" title="创建群聊" onClick={onCreateGroup}>
          <UsersThree size={18} weight="bold" />
        </button>
      </header>

      <section className="nav-section nav-section--sessions" aria-labelledby="sessions-title">
        <div className="nav-section__title nav-section__title--inline" id="sessions-title">
          <span>当前世界的会话</span>
          <ClockCounterClockwise size={15} />
        </div>
        <div className="session-list">
          {sessions.length === 0 ? (
            <div className="compact-empty">还没有会话，直接 @ 一名{experience?.personLabel ?? '角色'}开始。</div>
          ) : sessions.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              employees={employees}
              participantIds={sessionParticipants[session.id] ?? []}
              active={session.id === activeSessionId}
              onClick={() => onSelectSession(session.id)}
            />
          ))}
        </div>
      </section>

      <section className="nav-section nav-section--roles" aria-labelledby="roles-title">
        <div className="nav-section__title nav-section__title--inline" id="roles-title">
          <span>{experience?.peopleLabel ?? '角色'}（当前世界）</span>
          <span className="nav-section__summary"><span>{employees.length}</span><button type="button" aria-label={`添加${experience?.personLabel ?? '角色'}`} title={`添加${experience?.personLabel ?? '角色'}`} onClick={onRecruit}><Plus size={14} /></button></span>
        </div>
        <label className="nav-search">
          <MagnifyingGlass size={15} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={`搜索${experience?.personLabel ?? '角色'}或${experience?.actionLabel ?? '活动'}`}
            aria-label={`搜索${experience?.personLabel ?? '角色'}或${experience?.actionLabel ?? '活动'}`}
          />
        </label>
        <div className="employee-list">
          {employees.length === 0 ? (
            <div className="employee-list-empty">
              <p>{experience?.emptyCopy ?? '当前世界从 0 开始，还没有角色。'}</p>
              <button className="secondary-button" type="button" onClick={onRecruit}><Plus size={14} />{experience?.marketLabel ?? '角色市场'}</button>
            </div>
          ) : null}
          {filteredEmployees.map((employee) => (
            <div key={employee.id} className={`employee-row${activeEmployeeIds.includes(employee.id) ? ' is-active' : ''}`}>
              <button className="employee-row__main" type="button" onClick={() => onDirectEmployee(employee)} aria-label={`与${employee.displayName}私聊`}>
                <Avatar index={employee.avatarIndex} label={employee.displayName} status={employee.status} />
                <span className="employee-row__copy">
                  <span className="employee-row__identity">
                    <strong>{employee.displayName}</strong>
                    <span>{employee.role}</span>
                  </span>
                  <span className="employee-row__activity">{employee.currentActivity}</span>
                </span>
              </button>
              <button className="employee-row__dossier" type="button" aria-label={`查看${employee.displayName}档案`} title="查看档案" onClick={() => onSelectEmployee(employee.id)}>
                <UserFocus size={16} />
              </button>
            </div>
          ))}
        </div>
      </section>
      <footer className="world-settings-entry"><button type="button" onClick={onWorldSettings}><GearSix size={17} /><span>世界设置</span></button></footer>
    </div>
  )
}

function SessionRow({
  session,
  employees,
  participantIds,
  active,
  onClick,
}: {
  session: WorkSession
  employees: CyberEmployee[]
  participantIds: string[]
  active: boolean
  onClick(): void
}) {
  const participants = participantIds
    .map((id) => employees.find((employee) => employee.id === id))
    .filter((employee): employee is CyberEmployee => employee !== undefined)
  const subtitle = session.kind === 'group'
    ? `群聊 · ${participants.length || participantIds.length} 名成员`
    : participants[0]?.role ?? '私聊'
  return (
    <button className={`session-row${active ? ' is-active' : ''}`} type="button" onClick={onClick}>
      <span className="session-row__avatar" aria-hidden="true">
        {participants.length === 0
          ? session.kind === 'group' ? <UsersThree size={16} /> : <ChatCircleDots size={16} />
          : participants.slice(0, 2).map((employee) => <Avatar key={employee.id} index={employee.avatarIndex} size="sm" label={employee.displayName} />)}
      </span>
      <span className="session-row__copy"><strong>{session.title}</strong><small>{subtitle}</small></span>
      <time>{formatSessionTime(session.updatedAt)}</time>
    </button>
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

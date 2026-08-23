import {
  ChatCircleDots,
  GearSix,
  PushPin,
  PushPinSlash,
  Trash,
  UsersThree,
} from '@phosphor-icons/react'
import { useEffect, useMemo, useState } from 'react'
import type { WorkSession, World } from '@dsh-cyber/contracts'
import type { ConversationHubItem } from '@dsh-cyber/contracts/creative-platform'

import { api } from '../api.js'
import type { CyberEmployee, SessionParticipantMap } from '../types.js'
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
  sessionParticipants,
  employees,
  onSelectSession,
  onDirectEmployee,
  onCreateGroup,
  onWorldSettings,
}: NavigationPaneProps) {
  const [hubItems, setHubItems] = useState<ConversationHubItem[]>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    let cancelled = false
    setHubItems(undefined)
    void api<{ items: ConversationHubItem[] }>(`/api/worlds/${encodeURIComponent(world.id)}/conversation-hub`)
      .then((result) => { if (!cancelled) { setHubItems(result.items); setError(undefined) } })
      .catch((cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : '会话列表加载失败') })
    return () => { cancelled = true }
  }, [world.id, sessions.length, employees.length])

  useEffect(() => {
    if (activeSessionId === undefined || hubItems === undefined) return
    const selected = hubItems.find((item) => item.session.id === activeSessionId)
    if (selected?.hidden !== true) return
    void updatePreference(activeSessionId, { hidden: false }).then(setHubItems).catch(() => undefined)
  }, [activeSessionId, hubItems])

  const fallbackItems = useMemo((): ConversationHubItem[] => {
    const sessionItems: ConversationHubItem[] = sessions.map((session) => ({
      session,
      participantIds: sessionParticipants[session.id] ?? [],
      pinned: false,
      hidden: false,
    }))
    const directOwners = new Set(
      sessionItems
        .filter((item) => item.session.kind === 'direct' && item.participantIds.length === 1)
        .map((item) => item.participantIds[0]!),
    )
    const directContacts = employees
      .filter((employee) => employee.status !== 'archived' && !directOwners.has(employee.id))
      .map((employee): ConversationHubItem => ({
        session: {
          id: `contact:${world.id}:${employee.id}`,
          workspaceId: world.workspaceId,
          worldId: world.id,
          kind: 'direct',
          title: `与 ${employee.displayName} 对话`,
          status: 'open',
          createdAt: employee.createdAt,
          updatedAt: employee.updatedAt,
        },
        participantIds: [employee.id],
        pinned: employee.blueprintId === 'core.butler',
        hidden: false,
        canonicalCharacterId: employee.id,
      }))
    return [...sessionItems, ...directContacts].sort((left, right) => {
      if (left.pinned !== right.pinned) return left.pinned ? -1 : 1
      return right.session.updatedAt.localeCompare(left.session.updatedAt)
    })
  }, [employees, sessionParticipants, sessions, world.id, world.workspaceId])

  const items = useMemo(() => {
    const source = hubItems ?? fallbackItems
    return source.filter((item) => !item.hidden || item.session.id === activeSessionId)
  }, [activeSessionId, fallbackItems, hubItems])

  const updatePreference = async (sessionId: string, value: { pinned?: boolean; hidden?: boolean }) => {
    const result = await api<{ items: ConversationHubItem[] }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/conversation-preferences`,
      { method: 'PUT', body: JSON.stringify(value) },
    )
    return result.items
  }

  const openItem = (item: ConversationHubItem) => {
    if (item.session.kind === 'direct') {
      const employeeId = item.canonicalCharacterId ?? item.participantIds[0]
      const employee = employees.find((candidate) => candidate.id === employeeId)
      if (employee !== undefined) {
        onDirectEmployee(employee)
        return
      }
    }
    onSelectSession(item.session.id)
  }

  return (
    <div className="navigation-pane navigation-pane--conversations" role="region" aria-label="当前世界的会话">
      <header className="pane-heading">
        <span>会话</span>
        <button className="icon-button" type="button" aria-label="创建群聊" title="创建群聊" onClick={onCreateGroup}>
          <UsersThree size={18} weight="bold" />
        </button>
      </header>

      <section className="nav-section nav-section--sessions nav-section--conversation-only" aria-labelledby="sessions-title">
        <div className="nav-section__title nav-section__title--inline" id="sessions-title">
          <span>当前世界</span>
          <small>{items.length} 个会话</small>
        </div>
        {error === undefined || fallbackItems.length > 0 ? null : <div className="compact-empty" role="status">{error}</div>}
        <div className="session-list">
          {items.length === 0 ? (
            <div className="compact-empty">还没有会话。新增角色后会自动生成唯一私聊，也可以创建群聊。</div>
          ) : items.map((item) => {
            const synthetic = item.session.id.startsWith('contact:')
            return (
              <SessionRow
                key={item.session.id}
                item={item}
                employees={employees}
                active={item.session.id === activeSessionId || (item.session.kind === 'direct' && item.participantIds.some((id) => id === sessionParticipants[activeSessionId ?? '']?.[0]))}
                onClick={() => openItem(item)}
                {...(synthetic ? {} : {
                  onPin: () => void updatePreference(item.session.id, { pinned: !item.pinned }).then(setHubItems).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : '置顶失败')),
                  onDelete: () => void updatePreference(item.session.id, { hidden: true }).then((next) => {
                    setHubItems(next)
                    if (item.session.id === activeSessionId) {
                      const fallback = next.find((candidate) => !candidate.hidden)
                      if (fallback !== undefined) onSelectSession(fallback.session.id)
                    }
                  }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : '删除会话失败')),
                })}
              />
            )
          })}
        </div>
      </section>

      <footer className="world-settings-entry">
        <button type="button" onClick={onWorldSettings}><GearSix size={17} /><span>世界设置</span></button>
      </footer>
    </div>
  )
}

function SessionRow({
  item,
  employees,
  active,
  onClick,
  onPin,
  onDelete,
}: {
  item: ConversationHubItem
  employees: CyberEmployee[]
  active: boolean
  onClick(): void
  onPin?: () => void
  onDelete?: () => void
}) {
  const { session, participantIds } = item
  const participants = participantIds
    .map((id) => employees.find((employee) => employee.id === id))
    .filter((employee): employee is CyberEmployee => employee !== undefined)
  const subtitle = session.kind === 'group' || session.kind === 'meeting'
    ? `群聊 · ${participants.length || participantIds.length} 名成员`
    : participants[0]?.role ?? '私聊'
  return (
    <div className={`session-row-wrap${active ? ' is-active' : ''}${item.pinned ? ' is-pinned' : ''}`}>
      <button className="session-row session-row--hub" type="button" onClick={onClick} aria-label={session.kind === 'direct' && participants[0] !== undefined ? `与${participants[0].displayName}私聊` : directTitle(session, participants)}>
        <span className="session-row__avatar" aria-hidden="true">
          {participants.length === 0
            ? session.kind === 'group' || session.kind === 'meeting' ? <UsersThree size={16} /> : <ChatCircleDots size={16} />
            : participants.slice(0, 2).map((employee) => <Avatar key={employee.id} index={employee.avatarIndex} size="sm" label={employee.displayName} />)}
        </span>
        <span className="session-row__copy"><strong>{directTitle(session, participants)}</strong><small>{subtitle}</small></span>
        <time>{formatSessionTime(session.updatedAt)}</time>
      </button>
      {onPin === undefined || onDelete === undefined ? null : (
        <span className="session-row-actions">
          <button type="button" aria-label={item.pinned ? '取消置顶' : '置顶会话'} title={item.pinned ? '取消置顶' : '置顶会话'} onClick={onPin}>
            {item.pinned ? <PushPinSlash size={14} /> : <PushPin size={14} />}
          </button>
          <button type="button" aria-label="删除会话" title="从列表删除" onClick={onDelete}><Trash size={14} /></button>
        </span>
      )}
    </div>
  )
}

function directTitle(session: WorkSession, participants: CyberEmployee[]): string {
  return session.kind === 'direct' && participants[0] !== undefined ? participants[0].displayName : session.title
}

function formatSessionTime(value: string): string {
  const date = new Date(value)
  const today = new Date()
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  }
  return `${date.getMonth() + 1}-${String(date.getDate()).padStart(2, '0')}`
}

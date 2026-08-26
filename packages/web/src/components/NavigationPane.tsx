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
import { Avatar, GroupAvatar } from './Avatar.js'
import { AuthorityBadge } from './AuthorityBadge.js'
import { ContextMenu, type ContextMenuPosition } from './ContextMenu.js'

interface NavigationPaneProps {
  world: World
  sessions: WorkSession[]
  activeSessionId?: string
  activeEmployeeIds: string[]
  sessionParticipants: SessionParticipantMap
  employees: CyberEmployee[]
  /** Bumped whenever the transcript of the open session changes, so previews stay fresh. */
  activityPulse: number
  onSelectSession(sessionId: string, session?: WorkSession, participantIds?: string[]): void
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
  activityPulse,
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
  }, [world.id, sessions.length, employees.length, activityPulse])

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
    if (item.session.id.startsWith('contact:') && item.session.kind === 'direct') {
      const employeeId = item.canonicalCharacterId ?? item.participantIds[0]
      const employee = employees.find((candidate) => candidate.id === employeeId)
      if (employee !== undefined) {
        onDirectEmployee(employee)
        return
      }
    }
    onSelectSession(item.session.id, item.session, item.participantIds)
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
                active={item.session.id === activeSessionId || (synthetic && item.participantIds.some((id) => id === sessionParticipants[activeSessionId ?? '']?.[0]))}
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
  const [menuPosition, setMenuPosition] = useState<ContextMenuPosition>()
  const { session, participantIds } = item
  const participants = participantIds
    .map((id) => employees.find((employee) => employee.id === id))
    .filter((employee): employee is CyberEmployee => employee !== undefined)
  const lastPrompt = item.lastPrompt !== undefined && item.lastPrompt.trim().length > 0
    ? item.lastPrompt.trim().length > 20 ? `${item.lastPrompt.trim().slice(0, 20)}…` : item.lastPrompt.trim()
    : undefined
  const subtitle = lastPrompt ?? (session.kind === 'group' || session.kind === 'meeting'
    ? `群聊 · ${participants.length || participantIds.length} 名成员`
    : participants[0]?.role ?? '私聊')
  const openMenu = (position: ContextMenuPosition) => { if (onPin !== undefined && onDelete !== undefined) setMenuPosition(position) }
  return (
    <div className={`session-row-wrap${active ? ' is-active' : ''}${item.pinned ? ' is-pinned' : ''}`}>
      <button className="session-row session-row--hub" type="button" onClick={onClick} onContextMenu={(event) => { event.preventDefault(); openMenu({ x: event.clientX, y: event.clientY }) }} onKeyDown={(event) => { if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return; event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect(); openMenu({ x: rect.left + 28, y: rect.top + 28 }) }} aria-label={session.kind === 'direct' && participants[0] !== undefined ? `与${participants[0].displayName}私聊` : directTitle(session, participants)}>
        <span className={`session-row__avatar${session.kind === 'group' || session.kind === 'meeting' ? ' session-row__avatar--group' : ''}`} aria-hidden="true">
          {participants.length === 0
            ? session.kind === 'group' || session.kind === 'meeting' ? <UsersThree size={16} /> : <ChatCircleDots size={16} />
            : session.kind === 'group' || session.kind === 'meeting'
              ? <GroupAvatar participants={participants} size="sm" />
              : <Avatar index={participants[0]!.avatarIndex} size="sm" label={participants[0]!.displayName} authorityRole={participants[0]!.authorityRole} />}
        </span>
        <span className="session-row__copy"><strong>{directTitle(session, participants)}{session.kind === 'direct' ? <AuthorityBadge role={participants[0]?.authorityRole} /> : null}</strong><small>{subtitle}</small></span>
        <time>{formatSessionTime(session.updatedAt)}</time>
      </button>
      {menuPosition === undefined || onPin === undefined || onDelete === undefined ? null : <ContextMenu label={`${directTitle(session, participants)}会话操作`} position={menuPosition} onClose={() => setMenuPosition(undefined)} items={[
        { id: 'pin', label: item.pinned ? '取消置顶' : '置顶会话', description: item.pinned ? '恢复按最近消息排序' : '固定在会话列表顶部', icon: item.pinned ? <PushPinSlash size={17} /> : <PushPin size={17} />, onSelect: onPin },
        { id: 'delete', label: '从列表移除', description: '历史消息仍会保留', icon: <Trash size={17} />, danger: true, onSelect: onDelete },
      ]} />}
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

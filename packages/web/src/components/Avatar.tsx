import type { CSSProperties } from 'react'
import type { WorldCharacterRole } from '@dsh-cyber/contracts'

interface AvatarProps {
  index: number
  size?: 'sm' | 'md' | 'lg' | 'world'
  label: string
  status?: string
  authorityRole?: WorldCharacterRole | undefined
}

export interface GroupAvatarParticipant {
  id: string
  avatarIndex: number
  displayName: string
  authorityRole?: WorldCharacterRole | undefined
}

export function Avatar({ index, size = 'md', label, status, authorityRole }: AvatarProps) {
  const column = index % 4
  const row = Math.floor(index / 4)
  const style = {
    '--avatar-x': `${column * 33.3333}%`,
    '--avatar-y': `${row * 100}%`,
  } as CSSProperties
  void authorityRole
  return (
    <span className={`avatar avatar--${size}`} style={style} aria-label={label} role="img">
      {status === undefined ? null : <span className={`avatar__status status--${status}`} />}
    </span>
  )
}

export function GroupAvatar({ participants, size = 'sm' }: { participants: GroupAvatarParticipant[]; size?: 'sm' | 'md' }) {
  const overflowCount = Math.max(0, participants.length - 4)
  const tiles = overflowCount > 0
    ? [...participants.slice(0, 3), undefined]
    : participants.slice(0, 4)
  const countClass = tiles.length === 1 ? 'group-avatar--count-1' : tiles.length === 2 ? 'group-avatar--count-2' : 'group-avatar--count-grid'
  const names = participants.map((participant) => participant.displayName).join('、')
  return (
    <span className={`group-avatar group-avatar--${size} ${countClass}`} role="img" aria-label={`群聊头像：${names}`}>
      {tiles.map((participant) => participant === undefined
        ? <span key="more" className="group-avatar__more" aria-hidden="true">+{overflowCount}</span>
        : <span key={participant.id} className="group-avatar__tile" aria-hidden="true"><Avatar index={participant.avatarIndex} size="sm" label={participant.displayName} authorityRole={participant.authorityRole} /></span>)}
    </span>
  )
}

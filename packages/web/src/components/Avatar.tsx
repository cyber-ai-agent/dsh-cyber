import type { CSSProperties } from 'react'
import type { WorldCharacterRole } from '@dsh-cyber/contracts'

interface AvatarProps {
  index: number
  size?: 'sm' | 'md' | 'lg' | 'world'
  label: string
  status?: string
  authorityRole?: WorldCharacterRole | undefined
}

export function Avatar({ index, size = 'md', label, status, authorityRole }: AvatarProps) {
  const column = index % 4
  const row = Math.floor(index / 4)
  const style = {
    '--avatar-x': `${column * 33.3333}%`,
    '--avatar-y': `${row * 100}%`,
  } as CSSProperties
  const accessibleLabel = authorityRole === 'administrator' ? `${label}，世界管理员` : label
  return (
    <span className={`avatar avatar--${size}`} style={style} aria-label={accessibleLabel} role="img">
      {status === undefined ? null : <span className={`avatar__status status--${status}`} />}
    </span>
  )
}

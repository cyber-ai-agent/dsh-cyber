import type { CSSProperties } from 'react'

interface AvatarProps {
  index: number
  size?: 'sm' | 'md' | 'lg' | 'world'
  label: string
  status?: string
}

export function Avatar({ index, size = 'md', label, status }: AvatarProps) {
  const column = index % 4
  const row = Math.floor(index / 4)
  const style = {
    '--avatar-x': `${column * 33.3333}%`,
    '--avatar-y': `${row * 100}%`,
  } as CSSProperties
  return (
    <span className={`avatar avatar--${size}`} style={style} aria-label={label} role="img">
      {status === undefined ? null : <span className={`avatar__status status--${status}`} />}
    </span>
  )
}


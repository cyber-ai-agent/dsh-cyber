import { CrownSimple } from '@phosphor-icons/react'
import type { WorldCharacterRole } from '@dsh-cyber/contracts'

interface AuthorityBadgeProps {
  role?: WorldCharacterRole | undefined
  size?: 'sm' | 'md'
  className?: string
}

/**
 * 世界管理员只在姓名后显示一个克制的皇冠标识。
 * 头像、计数和其他装饰位置不得重复显示。
 */
export function AuthorityBadge({ role, size = 'sm', className = '' }: AuthorityBadgeProps) {
  if (role !== 'administrator') return null
  const classes = ['authority-badge', `authority-badge--${size}`, className].filter(Boolean).join(' ')
  return (
    <span className={classes} role="img" aria-label="世界管理员" title="世界管理员">
      <CrownSimple aria-hidden="true" weight="fill" />
    </span>
  )
}

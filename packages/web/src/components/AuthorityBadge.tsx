import { CrownSimple, ShieldCheck } from '@phosphor-icons/react'
import type { WorldCharacterRole } from '@dsh-cyber/contracts'

interface AuthorityBadgeProps {
  role?: WorldCharacterRole | undefined
  size?: 'sm' | 'md'
  className?: string
}

/**
 * The single visual identity for a world administrator.
 *
 * Keep this compact and deliberately quieter than availability/status markers:
 * authority is a world-scoped fact, not an activity state.
 */
export function AuthorityBadge({ role, size = 'sm', className = '' }: AuthorityBadgeProps) {
  if (role !== 'administrator') return null
  const classes = ['authority-badge', `authority-badge--${size}`, className].filter(Boolean).join(' ')
  return (
    <span className={classes} role="img" aria-label="世界管理员" title="世界管理员">
      <CrownSimple aria-hidden="true" weight="fill" />
      <ShieldCheck className="authority-badge__shield" aria-hidden="true" weight="duotone" />
    </span>
  )
}

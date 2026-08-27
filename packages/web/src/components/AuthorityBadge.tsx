import type { WorldCharacterRole } from '@dsh-cyber/contracts'

interface AuthorityBadgeProps {
  role?: WorldCharacterRole | undefined
  size?: 'sm' | 'md'
  className?: string
}

export function AuthorityBadge({ role, size = 'sm', className = '' }: AuthorityBadgeProps) {
  void role
  void size
  void className
  return null
}

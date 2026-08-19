interface StatusDotProps {
  status: 'available' | 'working' | 'waiting' | 'blocked' | 'archived' | 'healthy'
  label?: string
}

export function StatusDot({ status, label }: StatusDotProps) {
  return (
    <span className="status-inline">
      <span className={`status-dot status--${status}`} aria-hidden="true" />
      {label === undefined ? null : <span>{label}</span>}
    </span>
  )
}


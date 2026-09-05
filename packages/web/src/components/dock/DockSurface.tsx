import type { ReactNode } from 'react'

/**
 * The shape every pinned dock surface shares.
 *
 * The dock rule is one main title, one primary action and a clear list; a
 * path, an id, a hash, a full parameter set or a secondary explanation goes
 * into the details fold instead of the row. Role dossiers, the task list, the
 * schedule and the artifact list each used to carry their own version of that
 * header, empty state and row, which is why the four drifted apart. These are
 * layout primitives only — no surface hands over what it does, and no surface
 * gets a design system it did not ask for.
 */

export function DockSurfaceHeader({ mark, title, summary, meta, action }: {
  mark?: ReactNode
  title: string
  /** One line. Anything longer belongs in the surface's own details. */
  summary?: string
  /** A short count or status for this surface, never a second action. */
  meta?: ReactNode
  /** The single primary action for the whole surface. */
  action?: ReactNode
}) {
  return <header className="dock-surface__header">
    {mark === undefined ? null : <span className="dock-surface__mark" aria-hidden="true">{mark}</span>}
    <div className="dock-surface__heading">
      <h2>{title}</h2>
      {summary === undefined ? null : <p>{summary}</p>}
    </div>
    {meta === undefined ? null : <span className="dock-surface__meta">{meta}</span>}
    {action === undefined ? null : <div className="dock-surface__action">{action}</div>}
  </header>
}

/**
 * An empty dock list says what is empty and what would fill it. It never
 * stands in as decoration, and it never implies work that has not happened.
 */
export function DockEmptyState({ mark, title, description, action, label }: {
  mark?: ReactNode
  title: string
  description: string
  action?: ReactNode
  label?: string
}) {
  return <div className="dock-empty-state" {...(label === undefined ? {} : { 'aria-label': label })}>
    {mark === undefined ? null : <span className="dock-empty-state__mark" aria-hidden="true">{mark}</span>}
    <strong className="dock-empty-state__title">{title}</strong>
    <p className="dock-empty-state__description">{description}</p>
    {action === undefined ? null : <div className="dock-empty-state__action">{action}</div>}
  </div>
}

export function DockRow({ mark, title, secondary, badge, selected = false, actions, fold, onOpen, openLabel }: {
  mark?: ReactNode
  title: ReactNode
  /** Exactly one line. The rest of the record belongs in `fold`. */
  secondary: ReactNode
  badge?: ReactNode
  selected?: boolean
  actions?: ReactNode
  /** A `DockDetailFold`, when the row has more to show than its one line. */
  fold?: ReactNode
  /** The row's own primary action: opening it. Omit for a row with no detail view. */
  onOpen?(): void
  openLabel?: string
}) {
  const copy = <>
    <span className="dock-row__title">{title}</span>
    <span className="dock-row__secondary">{secondary}</span>
  </>
  return <article className={`dock-row${selected ? ' is-selected' : ''}`}>
    <div className="dock-row__body">
      {mark === undefined ? null : <span className="dock-row__mark">{mark}</span>}
      {onOpen === undefined
        ? <span className="dock-row__main">{copy}</span>
        : <button
          type="button"
          className="dock-row__main dock-row__open"
          {...(openLabel === undefined ? {} : { 'aria-label': openLabel })}
          {...(selected ? { 'aria-current': 'true' as const } : {})}
          onClick={onOpen}
        >{copy}</button>}
      {badge === undefined ? null : <span className="dock-row__badge">{badge}</span>}
      {actions === undefined ? null : <div className="dock-row__actions">{actions}</div>}
    </div>
    {fold}
  </article>
}

/** The one disclosure a dock surface uses, so details never grow a per-surface widget. */
export function DockDetailFold({ label, meta, children }: { label: string; meta?: ReactNode; children: ReactNode }) {
  return <details className="dock-detail-fold">
    <summary>{label}{meta === undefined ? null : <span> · {meta}</span>}</summary>
    {children}
  </details>
}

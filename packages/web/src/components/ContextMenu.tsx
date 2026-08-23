import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'

export interface ContextMenuPosition { x: number; y: number }

export interface ContextMenuItem {
  id: string
  label: string
  description?: string
  icon: ReactNode
  danger?: boolean
  disabled?: boolean
  onSelect(): void
}

interface ContextMenuProps {
  label: string
  position: ContextMenuPosition
  items: ContextMenuItem[]
  onClose(): void
}

export function ContextMenu({ label, position, items, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [placement, setPlacement] = useState(position)

  useLayoutEffect(() => {
    const menu = menuRef.current
    if (menu === null) return
    const margin = 12
    setPlacement({
      x: Math.max(margin, Math.min(position.x, window.innerWidth - menu.offsetWidth - margin)),
      y: Math.max(margin, Math.min(position.y, window.innerHeight - menu.offsetHeight - margin)),
    })
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }, [position])

  useEffect(() => {
    const close = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) onClose() }
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); return }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
      event.preventDefault()
      const buttons = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
      const offset = event.key === 'ArrowDown' ? 1 : -1
      buttons[(index + offset + buttons.length) % buttons.length]?.focus()
    }
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', keyboard)
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', keyboard) }
  }, [onClose])

  return createPortal(
    <div ref={menuRef} className="context-menu" role="menu" aria-label={label} style={{ left: placement.x, top: placement.y }}>
      {items.map((item) => <button key={item.id} type="button" role="menuitem" className={item.danger ? 'is-danger' : ''} disabled={item.disabled} onClick={() => { item.onSelect(); onClose() }}><span className="context-menu__icon" aria-hidden="true">{item.icon}</span><span><strong>{item.label}</strong>{item.description === undefined ? null : <small>{item.description}</small>}</span></button>)}
    </div>,
    document.body,
  )
}

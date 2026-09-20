import { CaretDown, Wrench } from '@phosphor-icons/react'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'

/** Keeps the existing launchers mounted while their portal dialogs are open. */
export function WorkbenchToolsMenu({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const id = useId()
  useEffect(() => {
    if (!open) return
    const pointer = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setOpen(false); trigger.current?.focus() }
    }
    window.addEventListener('pointerdown', pointer)
    window.addEventListener('keydown', key)
    return () => { window.removeEventListener('pointerdown', pointer); window.removeEventListener('keydown', key) }
  }, [open])
  return <div className="workbench-tools" ref={root}>
    <button ref={trigger} type="button" aria-label="工具" aria-expanded={open} aria-controls={id} aria-haspopup="dialog" onClick={() => setOpen((value) => !value)} onKeyDown={(event) => { if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); requestAnimationFrame(() => panel.current?.querySelector<HTMLButtonElement>('button')?.focus()) } }}><Wrench size={18} /><span>工具</span><CaretDown size={12} /></button>
    <div ref={panel} id={id} className="workbench-tools__panel" role="dialog" aria-label="工作台工具" hidden={!open} onClick={(event) => { const button = (event.target as HTMLElement).closest('button'); if (button !== null && panel.current?.contains(button) && button.closest('.topbar-world-theme-container') === null) setOpen(false) }}>{children}</div>
  </div>
}

import { useEffect, useRef, type RefObject } from 'react'

/** Minimal native focus contract shared by settings overlays. */
export function useDialogFocusTrap(containerRef: RefObject<HTMLElement | null>, onClose: () => void): void {
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    const container = containerRef.current
    if (container === null) return
    const focusable = () => [...container.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')]
    ;(container.querySelector<HTMLElement>('[data-dialog-initial-focus]') ?? focusable()[0])?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      const topmost = [...document.querySelectorAll<HTMLElement>('[aria-modal="true"]')].at(-1)
      if (topmost !== container) return
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); return }
      if (event.key !== 'Tab') return
      const items = focusable()
      if (items.length === 0) return
      const first = items[0]!
      const last = items.at(-1)!
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [containerRef])
}

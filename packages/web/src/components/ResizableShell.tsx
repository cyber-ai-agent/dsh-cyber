import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'

interface ResizableShellProps {
  left: ReactNode
  center: ReactNode
  right: ReactNode
  leftWidth: number
  rightWidth: number
  rightCollapsed: boolean
  onResize(leftWidth: number, rightWidth: number): void
}

export function ResizableShell({
  left,
  center,
  right,
  leftWidth,
  rightWidth,
  rightCollapsed,
  onResize,
}: ResizableShellProps) {
  const shellRef = useRef<HTMLDivElement>(null)
  const widthsRef = useRef({ leftWidth, rightWidth })

  useEffect(() => {
    widthsRef.current = { leftWidth, rightWidth }
  }, [leftWidth, rightWidth])

  const beginResize = useCallback((side: 'left' | 'right', startEvent: ReactPointerEvent) => {
    startEvent.currentTarget.setPointerCapture(startEvent.pointerId)
    const originX = startEvent.clientX
    const initial = widthsRef.current
    const shellWidth = shellRef.current?.clientWidth ?? window.innerWidth
    const onMove = (event: PointerEvent) => {
      const delta = event.clientX - originX
      const nextLeft = side === 'left'
        ? clamp(initial.leftWidth + delta, 220, Math.min(520, shellWidth - 700))
        : initial.leftWidth
      const nextRight = side === 'right'
        ? clamp(initial.rightWidth - delta, 300, Math.min(760, shellWidth - 700))
        : initial.rightWidth
      onResize(nextLeft, nextRight)
    }
    const onEnd = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onEnd)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onEnd, { once: true })
  }, [onResize])

  return (
    <div
      ref={shellRef}
      className={`workbench-shell${rightCollapsed ? ' workbench-shell--dock-collapsed' : ''}`}
      style={{ gridTemplateColumns: `${leftWidth}px 5px minmax(460px, 1fr) ${rightCollapsed ? '0 0' : `5px ${rightWidth}px`}` }}
    >
      <aside className="left-pane">{left}</aside>
      <button
        className="resize-handle"
        type="button"
        aria-label="调整导航栏宽度"
        onPointerDown={(event) => beginResize('left', event)}
      />
      <main className="center-pane">{center}</main>
      {rightCollapsed ? null : (
        <>
          <button
            className="resize-handle"
            type="button"
            aria-label="调整右侧面板宽度"
            onPointerDown={(event) => beginResize('right', event)}
          />
          <aside className="right-pane">{right}</aside>
        </>
      )}
    </div>
  )
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum))
}

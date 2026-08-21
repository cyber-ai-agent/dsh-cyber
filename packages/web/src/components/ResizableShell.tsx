import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'

interface ResizableShellProps {
  left: ReactNode
  center: ReactNode
  right: ReactNode
  leftWidth: number
  rightWidth: number
  rightCollapsed: boolean
  rightPrimary?: boolean
  onResize(leftWidth: number, rightWidth: number): void
}

export function ResizableShell({
  left,
  center,
  right,
  leftWidth,
  rightWidth,
  rightCollapsed,
  rightPrimary = false,
  onResize,
}: ResizableShellProps) {
  const shellRef = useRef<HTMLDivElement>(null)
  const widthsRef = useRef({ leftWidth, rightWidth })
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth)
  const paneScale = viewportWidth >= 3_200 ? 1.35 : viewportWidth >= 2_200 ? 1.18 : 1

  useEffect(() => {
    widthsRef.current = { leftWidth, rightWidth }
  }, [leftWidth, rightWidth])

  useEffect(() => {
    const updateViewport = () => setViewportWidth(window.innerWidth)
    window.addEventListener('resize', updateViewport)
    return () => window.removeEventListener('resize', updateViewport)
  }, [])

  const beginResize = useCallback((side: 'left' | 'right', startEvent: ReactPointerEvent) => {
    startEvent.currentTarget.setPointerCapture(startEvent.pointerId)
    const originX = startEvent.clientX
    const initial = widthsRef.current
    const shellWidth = (shellRef.current?.clientWidth ?? window.innerWidth) / paneScale
    const onMove = (event: PointerEvent) => {
      const delta = (event.clientX - originX) / paneScale
      const nextLeft = side === 'left'
        ? clamp(initial.leftWidth + delta, 220, Math.min(520, shellWidth - 700))
        : initial.leftWidth
      const nextRight = side === 'right'
        ? clamp(initial.rightWidth - delta, 300, Math.min(1_440, shellWidth - 700))
        : initial.rightWidth
      onResize(nextLeft, nextRight)
    }
    const onEnd = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onEnd)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onEnd, { once: true })
  }, [onResize, paneScale])

  const handleWidth = Math.round(5 * paneScale)
  const minimumCenterWidth = Math.round(440 * paneScale)
  const displayedLeftWidth = Math.round(leftWidth * paneScale)
  const displayedRightWidth = Math.round(rightWidth * paneScale)

  return (
    <div
      ref={shellRef}
      className={`workbench-shell${rightCollapsed ? ' workbench-shell--dock-collapsed' : ''}${rightPrimary ? ' workbench-shell--right-primary' : ''}`}
      style={{
        gridTemplateColumns: `${displayedLeftWidth}px ${handleWidth}px minmax(${minimumCenterWidth}px, 1fr) ${rightCollapsed ? '0 0' : `${handleWidth}px ${displayedRightWidth}px`}`,
      }}
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

import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { WORKSPACE_PREFERENCES_LIMITS } from '@dsh-cyber/contracts'

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
  const resizeCleanupRef = useRef<(() => void) | null>(null)
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth)
  const paneScale = viewportWidth >= 3_200 ? 1.35 : viewportWidth >= 2_200 ? 1.18 : 1
  const handleWidth = Math.round(5 * paneScale)
  const displayedLeftWidth = Math.min(Math.round(leftWidth * paneScale), Math.floor(viewportWidth * .22))
  const minimumCenterWidth = Math.min(Math.round(700 * paneScale), Math.max(440, viewportWidth - displayedLeftWidth - 310))
  const displayedRightWidth = Math.max(300, Math.min(Math.round(rightWidth * paneScale), viewportWidth - displayedLeftWidth - handleWidth * 2 - minimumCenterWidth))

  useEffect(() => {
    widthsRef.current = { leftWidth: displayedLeftWidth / paneScale, rightWidth: displayedRightWidth / paneScale }
  }, [displayedLeftWidth, displayedRightWidth, paneScale])

  useEffect(() => {
    const updateViewport = () => setViewportWidth(window.innerWidth)
    window.addEventListener('resize', updateViewport)
    return () => window.removeEventListener('resize', updateViewport)
  }, [])

  // A removed handle can send lostpointercapture to document rather than
  // itself. Explicitly end the session on unmount and layout changes too.
  useEffect(() => () => resizeCleanupRef.current?.(), [rightCollapsed, paneScale])

  const beginResize = useCallback((side: 'left' | 'right', startEvent: ReactPointerEvent) => {
    if (startEvent.button !== 0 || resizeCleanupRef.current !== null) return
    const handle = startEvent.currentTarget
    const pointerId = startEvent.pointerId
    handle.setPointerCapture(pointerId)
    const originX = startEvent.clientX
    const initial = widthsRef.current
    const shellWidth = (shellRef.current?.clientWidth ?? window.innerWidth) / paneScale
    const onMove = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return
      const delta = (event.clientX - originX) / paneScale
      const nextLeft = side === 'left'
        ? clamp(
            initial.leftWidth + delta,
            WORKSPACE_PREFERENCES_LIMITS.leftPaneWidth.minimum,
            Math.min(WORKSPACE_PREFERENCES_LIMITS.leftPaneWidth.maximum, shellWidth - 700),
          )
        : initial.leftWidth
      const nextRight = side === 'right'
        ? clamp(
            initial.rightWidth - delta,
            WORKSPACE_PREFERENCES_LIMITS.rightPaneWidth.minimum,
            Math.min(WORKSPACE_PREFERENCES_LIMITS.rightPaneWidth.maximum, shellWidth - initial.leftWidth - minimumCenterWidth / paneScale - 10),
          )
        : initial.rightWidth
      onResize(nextLeft, nextRight)
    }
    const cleanup = () => {
      if (resizeCleanupRef.current !== cleanup) return
      resizeCleanupRef.current = null
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onEnd)
      window.removeEventListener('pointercancel', onEnd)
      window.removeEventListener('blur', cleanup)
      window.removeEventListener('lostpointercapture', onEnd)
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId)
    }
    const onEnd = (event: PointerEvent) => {
      if (event.pointerId === pointerId) cleanup()
    }
    resizeCleanupRef.current = cleanup
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onEnd)
    window.addEventListener('pointercancel', onEnd)
    window.addEventListener('blur', cleanup)
    window.addEventListener('lostpointercapture', onEnd)
  }, [minimumCenterWidth, onResize, paneScale])

  return (
    <div
      ref={shellRef}
      className={`workbench-shell${rightCollapsed ? ' workbench-shell--dock-collapsed' : ''}${rightPrimary ? ' workbench-shell--right-primary' : ''}`}
      style={{
        gridTemplateColumns: `${displayedLeftWidth}px ${handleWidth}px minmax(${minimumCenterWidth}px, 1fr) ${rightCollapsed ? '0 0' : `${handleWidth}px ${displayedRightWidth}px`}`,
        '--workbench-columns': `${displayedLeftWidth}px ${handleWidth}px minmax(${minimumCenterWidth}px, 1fr) ${rightCollapsed ? '0 0' : `${handleWidth}px ${displayedRightWidth}px`}`,
      } as CSSProperties}
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

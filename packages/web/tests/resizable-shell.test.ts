import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ResizableShell } from '../src/components/ResizableShell.js'

let container: HTMLDivElement
let root: Root | undefined
const onResize = vi.fn<(left: number, right: number) => void>()
const initialViewport = Object.getOwnPropertyDescriptor(window, 'innerWidth')

function renderShell(rightCollapsed = false): void {
  act(() => root!.render(createElement(ResizableShell, {
    left: '导航', center: '聊天', right: '世界',
    leftWidth: 280, rightWidth: 480, rightCollapsed, onResize,
  })))
  Object.defineProperty(container.querySelector('.workbench-shell')!, 'clientWidth', {
    configurable: true, value: window.innerWidth,
  })
}

function handle(side: 'left' | 'right' = 'left'): HTMLButtonElement {
  const label = side === 'left' ? '调整导航栏宽度' : '调整右侧面板宽度'
  const element = container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!
  // happy-dom dispatches pointer events but does not implement browser capture.
  // Model ownership explicitly; browser-level capture still needs E2E coverage.
  const captured = new Set<number>()
  Object.defineProperties(element, {
    setPointerCapture: { configurable: true, value: vi.fn((id: number) => captured.add(id)) },
    hasPointerCapture: { configurable: true, value: (id: number) => captured.has(id) },
    releasePointerCapture: { configurable: true, value: vi.fn((id: number) => captured.delete(id)) },
  })
  return element
}

function pointer(target: EventTarget, type: string, pointerId = 1, clientX = 300, button = 0): void {
  act(() => {
    target.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId, clientX, button, isPrimary: true }))
  })
}

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 })
  onResize.mockClear()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  renderShell()
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = undefined
  container.remove()
  vi.restoreAllMocks()
  if (initialViewport) Object.defineProperty(window, 'innerWidth', initialViewport)
  else Reflect.deleteProperty(window, 'innerWidth')
})

describe('ResizableShell resize lifecycle', () => {
  it.each(['pointerup', 'pointercancel', 'lostpointercapture', 'document-lostpointercapture', 'blur'])(
    'ends the session and removes every global listener on %s', (ending) => {
      const element = handle()
      const added = vi.spyOn(window, 'addEventListener')
      const removed = vi.spyOn(window, 'removeEventListener')
      pointer(element, 'pointerdown')
      pointer(window, 'pointermove', 1, 340)
      expect(onResize).toHaveBeenCalledOnce()

      if (ending === 'blur') act(() => { window.dispatchEvent(new Event('blur')) })
      else if (ending === 'document-lostpointercapture') pointer(document, 'lostpointercapture')
      else pointer(ending === 'lostpointercapture' ? element : window, ending)

      onResize.mockClear()
      pointer(window, 'pointermove', 1, 380)
      expect(onResize).not.toHaveBeenCalled()
      expect(element.releasePointerCapture).toHaveBeenCalledExactlyOnceWith(1)
      const sessionEvents = ['pointermove', 'pointerup', 'pointercancel', 'blur', 'lostpointercapture']
      for (const [type, listener] of added.mock.calls) {
        if (sessionEvents.includes(type)) expect(removed).toHaveBeenCalledWith(type, listener)
      }
    },
  )

  it('ignores moves and end events belonging to another pointer', () => {
    const element = handle()
    pointer(element, 'pointerdown')
    pointer(window, 'pointermove', 2, 340)
    pointer(window, 'pointerup', 2)
    pointer(window, 'pointercancel', 2)
    pointer(element, 'lostpointercapture', 2)
    expect(onResize).not.toHaveBeenCalled()
    pointer(window, 'pointermove', 1, 340)
    expect(onResize).toHaveBeenCalledOnce()
  })

  it('does not start a second resize while one pointer owns the session', () => {
    const left = handle()
    const right = handle('right')
    pointer(left, 'pointerdown')
    pointer(right, 'pointerdown', 2)
    expect(right.setPointerCapture).not.toHaveBeenCalled()
    pointer(window, 'pointermove', 2, 340)
    expect(onResize).not.toHaveBeenCalled()
    pointer(window, 'pointermove', 1, 340)
    expect(onResize).toHaveBeenCalledOnce()
  })

  it('cleans up an active resize when the component unmounts', () => {
    const element = handle()
    pointer(element, 'pointerdown')
    act(() => root!.unmount())
    root = undefined
    pointer(window, 'pointermove', 1, 340)
    expect(onResize).not.toHaveBeenCalled()
    expect(element.releasePointerCapture).toHaveBeenCalledExactlyOnceWith(1)
  })

  it('cleans up the right resize when its dock is collapsed', () => {
    const element = handle('right')
    pointer(element, 'pointerdown')
    renderShell(true)
    pointer(window, 'pointermove', 1, 340)
    expect(onResize).not.toHaveBeenCalled()
    expect(element.releasePointerCapture).toHaveBeenCalledExactlyOnceWith(1)
  })

  it('ends a resize when the viewport changes the pane scale', () => {
    const element = handle()
    pointer(element, 'pointerdown')
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 3840 })
    act(() => { window.dispatchEvent(new Event('resize')) })
    pointer(window, 'pointermove', 1, 340)
    expect(onResize).not.toHaveBeenCalled()
  })

  it('can start a fresh session after cancellation without duplicate callbacks', () => {
    const element = handle()
    pointer(element, 'pointerdown')
    pointer(window, 'pointercancel')
    pointer(element, 'pointerdown', 3)
    pointer(window, 'pointermove', 3, 340)
    expect(onResize).toHaveBeenCalledOnce()
    pointer(window, 'pointerup', 3)
    pointer(window, 'pointermove', 3, 380)
    expect(onResize).toHaveBeenCalledOnce()
  })

  it.each([1, 2])('does not start a resize for mouse button %s', (button) => {
    const element = handle()
    pointer(element, 'pointerdown', 1, 300, button)
    pointer(window, 'pointermove', 1, 340)
    expect(element.setPointerCapture).not.toHaveBeenCalled()
    expect(onResize).not.toHaveBeenCalled()
  })
})

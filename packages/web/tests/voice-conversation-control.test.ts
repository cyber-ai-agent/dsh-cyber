import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { VoiceConversationControl } from '../src/features/voice/VoiceConversationControl.js'

const originalWebSocket = globalThis.WebSocket
const originalAudioContext = globalThis.AudioContext
const originalAudioWorkletNode = globalThis.AudioWorkletNode
const originalMediaDevices = navigator.mediaDevices

let host: HTMLElement
let root: ReturnType<typeof createRoot>
let trackStop: ReturnType<typeof vi.fn>

beforeEach(() => {
  MockWebSocket.instances.length = 0
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  trackStop = vi.fn()

  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: MockWebSocket })
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: MockAudioContext })
  Object.defineProperty(globalThis, 'AudioWorkletNode', { configurable: true, value: MockAudioWorkletNode })
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: vi.fn().mockResolvedValue({
        getTracks: () => [{ stop: trackStop }],
      }),
    },
  })
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  restoreGlobal('WebSocket', originalWebSocket)
  restoreGlobal('AudioContext', originalAudioContext)
  restoreGlobal('AudioWorkletNode', originalAudioWorkletNode)
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: originalMediaDevices })
})

describe('VoiceConversationControl capture lifecycle', () => {
  it('does not resurrect listening when a stopped turn finishes sending late', async () => {
    const final = deferred<void>()
    const onFinal = vi.fn(() => final.promise)

    await act(async () => {
      root.render(createElement(VoiceConversationControl, { employeeName: '管家', onFinal }))
    })

    await act(async () => {
      button('开始语音对话').click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(button('结束语音对话')).toBeTruthy()

    const socket = MockWebSocket.instances[0]!
    await act(async () => {
      socket.emit({ type: 'final', text: '帮我检查昨天的服务日志' })
      await Promise.resolve()
    })
    expect(onFinal).toHaveBeenCalledWith('帮我检查昨天的服务日志')
    expect(button('结束语音对话')).toBeTruthy()

    await act(async () => {
      button('结束语音对话').click()
      await Promise.resolve()
    })
    expect(button('开始语音对话')).toBeTruthy()
    expect(trackStop).toHaveBeenCalledTimes(1)

    await act(async () => {
      final.resolve()
      await final.promise
      await Promise.resolve()
    })

    expect(button('开始语音对话')).toBeTruthy()
    expect(host.querySelector('[aria-label="结束语音对话"]')).toBeNull()
  })

  it('drops active capture state when the voice socket closes unexpectedly', async () => {
    await act(async () => {
      root.render(createElement(VoiceConversationControl, { employeeName: '管家', onFinal: vi.fn().mockResolvedValue(undefined) }))
    })
    await act(async () => {
      button('开始语音对话').click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(button('结束语音对话')).toBeTruthy()

    await act(async () => {
      MockWebSocket.instances[0]!.closeFromServer()
      await Promise.resolve()
    })

    expect(button('开始语音对话')).toBeTruthy()
    expect(trackStop).toHaveBeenCalledTimes(1)
  })
})

function button(label: string): HTMLButtonElement {
  const found = host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  if (found === null) throw new Error(`missing button: ${label}`)
  return found
}

class MockWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static readonly instances: MockWebSocket[] = []

  readonly url: string
  readyState = MockWebSocket.OPEN
  binaryType = 'blob'
  onopen: ((event: Event) => unknown) | null = null
  onmessage: ((event: MessageEvent) => unknown) | null = null
  onerror: ((event: Event) => unknown) | null = null
  onclose: ((event: CloseEvent) => unknown) | null = null
  readonly sent: unknown[] = []

  constructor(url: string | URL) {
    this.url = String(url)
    MockWebSocket.instances.push(this)
  }

  send(value: unknown): void {
    this.sent.push(value)
  }

  addEventListener(_type: string, _listener: EventListenerOrEventListenerObject, _options?: boolean | AddEventListenerOptions): void {}

  close(): void {
    this.readyState = MockWebSocket.CLOSED
  }

  emit(value: unknown): void {
    this.onmessage?.({ data: JSON.stringify(value) } as MessageEvent)
  }

  closeFromServer(): void {
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.(new Event('close') as CloseEvent)
  }
}

class MockAudioContext {
  readonly audioWorklet = { addModule: vi.fn().mockResolvedValue(undefined) }
  readonly destination = {}

  createMediaStreamSource(_stream: MediaStream): MediaStreamAudioSourceNode {
    return { connect: vi.fn(), disconnect: vi.fn() } as unknown as MediaStreamAudioSourceNode
  }

  createGain(): GainNode {
    return { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() } as unknown as GainNode
  }

  close(): Promise<void> {
    return Promise.resolve()
  }
}

class MockAudioWorkletNode {
  readonly port = { onmessage: null as ((event: MessageEvent<ArrayBuffer>) => void) | null }
  constructor(_context: AudioContext, _name: string) {}
  connect(): this { return this }
  disconnect(): void {}
}

function deferred<T>(): { promise: Promise<T>; resolve(value?: T): void } {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((next) => { resolve = next })
  return { promise, resolve: (value?: T) => resolve(value as T) }
}

function restoreGlobal(name: 'WebSocket' | 'AudioContext' | 'AudioWorkletNode', value: unknown): void {
  if (value === undefined) Reflect.deleteProperty(globalThis, name)
  else Object.defineProperty(globalThis, name, { configurable: true, value })
}

import { act } from 'react'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ComposerReplySpeaker } from '../src/features/voice/ComposerReplySpeaker.js'
import { claimSpeech, resetSpeechCoordinatorForTest } from '../src/features/voice/SpeechCoordinator.js'
import { publishStreamingSpeech } from '../src/features/voice/streaming-speech-bus.js'

const spoken: Array<{ employeeId: string; text: string }> = []
const stopped = vi.fn()
let pendingSpeak: Promise<void> | undefined

vi.mock('../src/features/voice/speak-as-character.js', () => ({
  speakAsCharacter: async (input: { employeeId: string; text: string }) => { spoken.push(input); await pendingSpeak },
  stopCharacterSpeech: () => stopped(),
}))

let host: HTMLElement
let root: ReturnType<typeof createRoot>

async function mount(employeeId: string | undefined, sessionId?: string, conversationKey?: string) {
  await act(async () => {
    root.render(createElement(ComposerReplySpeaker, { employeeId, sessionId, conversationKey, dossiers: {} }))
  })
}

async function reply(employeeId: string, turnId: string, chunks: string[], extra: { sessionId?: string; conversationKey?: string } = {}) {
  await act(async () => {
    const context = { source: 'voice' as const, surface: 'composer' as const, clientTurnId: turnId, ...extra }
    publishStreamingSpeech({ kind: 'start', employeeId, turnId, ...context })
    for (const content of chunks) publishStreamingSpeech({ kind: 'delta', employeeId, turnId, content, ...context })
    publishStreamingSpeech({ kind: 'complete', employeeId, turnId, ...context })
    await Promise.resolve()
  })
}

async function typedReply(employeeId: string, turnId: string, content: string) {
  await act(async () => {
    publishStreamingSpeech({ kind: 'start', employeeId, turnId })
    publishStreamingSpeech({ kind: 'delta', employeeId, turnId, content })
    publishStreamingSpeech({ kind: 'complete', employeeId, turnId })
  })
}

beforeEach(() => {
  spoken.length = 0
  stopped.mockClear()
  pendingSpeak = undefined
  resetSpeechCoordinatorForTest()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

describe('ComposerReplySpeaker', () => {
  it('speaks a reply once the user has spoken', async () => {
    // The composer has a microphone but nothing there subscribed to the
    // speech bus, so a character answered a spoken question in silence.
    await mount('employee-1')
    await reply('employee-1', 'turn-1', ['你好，', '我在。'])
    expect(spoken).toEqual([{ employeeId: 'employee-1', text: '你好，我在。' }])
  })

  it('stays quiet for somebody who is typing', async () => {
    await mount('employee-1')
    await typedReply('employee-1', 'turn-1', '你好')
    expect(spoken).toEqual([])
  })

  it('ignores replies from other characters', async () => {
    await mount('employee-1')
    await reply('employee-2', 'turn-1', ['不是我'])
    expect(spoken).toEqual([])
  })

  it('reads a reply once, however many times the turn completes', async () => {
    // A reconnect can replay a completion, and hearing the same answer twice
    // is worse than not hearing it.
    await mount('employee-1')
    await reply('employee-1', 'turn-1', ['只说一次'])
    await act(async () => { publishStreamingSpeech({ kind: 'complete', employeeId: 'employee-1', turnId: 'turn-1', source: 'voice', surface: 'composer', clientTurnId: 'turn-1' }) })
    expect(spoken).toHaveLength(1)
  })

  it('says nothing for an empty reply', async () => {
    await mount('employee-1')
    await reply('employee-1', 'turn-1', ['   '])
    expect(spoken).toEqual([])
  })

  it('stops the previous reply when a new one begins', async () => {
    await mount('employee-1')
    let release!: () => void
    pendingSpeak = new Promise<void>((resolve) => { release = resolve })
    await reply('employee-1', 'turn-1', ['第一条'])
    stopped.mockClear()
    await act(async () => { publishStreamingSpeech({ kind: 'start', employeeId: 'employee-1', turnId: 'turn-2', source: 'voice', surface: 'composer', clientTurnId: 'turn-2' }) })
    expect(stopped).toHaveBeenCalled()
    release()
    await act(async () => { await Promise.resolve() })
  })

  it('drops a cancelled reply instead of reading it', async () => {
    await mount('employee-1')
    await act(async () => {
      const context = { source: 'voice' as const, surface: 'composer' as const, clientTurnId: 'turn-1' }
      publishStreamingSpeech({ kind: 'start', employeeId: 'employee-1', turnId: 'turn-1', ...context })
      publishStreamingSpeech({ kind: 'delta', employeeId: 'employee-1', turnId: 'turn-1', content: '半句', ...context })
      publishStreamingSpeech({ kind: 'cancel', employeeId: 'employee-1', turnId: 'turn-1', ...context })
      publishStreamingSpeech({ kind: 'complete', employeeId: 'employee-1', turnId: 'turn-1', ...context })
      await Promise.resolve()
    })
    expect(spoken).toEqual([])
  })

  it('does nothing when the conversation has no single character', async () => {
    await mount(undefined)
    await reply('employee-1', 'turn-1', ['群聊不播报'])
    expect(spoken).toEqual([])
  })

  it('stays quiet after a voice turn when the next turn is typed', async () => {
    await mount('employee-1')
    await reply('employee-1', 'voice-turn', ['语音回复'])
    await act(async () => {
      publishStreamingSpeech({ kind: 'start', employeeId: 'employee-1', turnId: 'typed-turn' })
      publishStreamingSpeech({ kind: 'delta', employeeId: 'employee-1', turnId: 'typed-turn', content: '键盘回复' })
      publishStreamingSpeech({ kind: 'complete', employeeId: 'employee-1', turnId: 'typed-turn' })
    })
    expect(spoken).toEqual([{ employeeId: 'employee-1', text: '语音回复' }])
  })

  it('does not compete with a focused streaming owner for the same turn', async () => {
    await mount('employee-1')
    const focusClaim = claimSpeech({ employeeId: 'employee-1', turnId: 'turn-1', owner: 'focus-stream' })
    expect(focusClaim).toBeDefined()
    await reply('employee-1', 'turn-1', ['焦点正在播报'])
    expect(spoken).toEqual([])
    focusClaim?.release()
  })

  it('ignores a late reply after the conversation changes', async () => {
    await mount('employee-1', 'session-1', 'direct:employee-1')
    await mount('employee-1', 'session-2', 'direct:employee-1')
    await reply('employee-1', 'turn-old', ['旧会话'], { sessionId: 'session-1', conversationKey: 'direct:employee-1' })
    expect(spoken).toEqual([])
  })

  it('releases owned playback when the focused employee changes', async () => {
    await mount('employee-1')
    let release!: () => void
    pendingSpeak = new Promise<void>((resolve) => { release = resolve })
    await reply('employee-1', 'turn-active', ['正在播放'])
    stopped.mockClear()
    await mount('employee-2')
    expect(stopped).toHaveBeenCalled()
    release()
    await act(async () => { await Promise.resolve() })
  })

  it('can speak a final-only event when no text deltas were emitted', async () => {
    await mount('employee-1')
    await act(async () => {
      publishStreamingSpeech({ kind: 'complete', employeeId: 'employee-1', turnId: 'turn-final', clientTurnId: 'turn-final', source: 'voice', surface: 'composer', content: '只有最终消息' })
      await Promise.resolve()
    })
    expect(spoken).toEqual([{ employeeId: 'employee-1', text: '只有最终消息' }])
  })
})

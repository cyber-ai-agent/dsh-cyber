import { act } from 'react'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ComposerReplySpeaker } from '../src/features/voice/ComposerReplySpeaker.js'
import { publishStreamingSpeech } from '../src/features/voice/streaming-speech-bus.js'

const spoken: Array<{ employeeId: string; text: string }> = []
const stopped = vi.fn()

vi.mock('../src/features/voice/speak-as-character.js', () => ({
  speakAsCharacter: async (input: { employeeId: string; text: string }) => { spoken.push(input) },
  stopCharacterSpeech: () => stopped(),
}))

let host: HTMLElement
let root: ReturnType<typeof createRoot>

async function mount(employeeId: string | undefined, enabled: boolean) {
  await act(async () => {
    root.render(createElement(ComposerReplySpeaker, { employeeId, dossiers: {}, enabled }))
  })
}

async function reply(employeeId: string, turnId: string, chunks: string[]) {
  await act(async () => {
    publishStreamingSpeech({ kind: 'start', employeeId, turnId })
    for (const content of chunks) publishStreamingSpeech({ kind: 'delta', employeeId, turnId, content })
    publishStreamingSpeech({ kind: 'complete', employeeId, turnId })
    await Promise.resolve()
  })
}

beforeEach(() => {
  spoken.length = 0
  stopped.mockClear()
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
    await mount('employee-1', true)
    await reply('employee-1', 'turn-1', ['你好，', '我在。'])
    expect(spoken).toEqual([{ employeeId: 'employee-1', text: '你好，我在。' }])
  })

  it('stays quiet for somebody who is typing', async () => {
    await mount('employee-1', false)
    await reply('employee-1', 'turn-1', ['你好'])
    expect(spoken).toEqual([])
  })

  it('ignores replies from other characters', async () => {
    await mount('employee-1', true)
    await reply('employee-2', 'turn-1', ['不是我'])
    expect(spoken).toEqual([])
  })

  it('reads a reply once, however many times the turn completes', async () => {
    // A reconnect can replay a completion, and hearing the same answer twice
    // is worse than not hearing it.
    await mount('employee-1', true)
    await reply('employee-1', 'turn-1', ['只说一次'])
    await act(async () => { publishStreamingSpeech({ kind: 'complete', employeeId: 'employee-1', turnId: 'turn-1' }) })
    expect(spoken).toHaveLength(1)
  })

  it('says nothing for an empty reply', async () => {
    await mount('employee-1', true)
    await reply('employee-1', 'turn-1', ['   '])
    expect(spoken).toEqual([])
  })

  it('stops the previous reply when a new one begins', async () => {
    await mount('employee-1', true)
    await reply('employee-1', 'turn-1', ['第一条'])
    stopped.mockClear()
    await act(async () => { publishStreamingSpeech({ kind: 'start', employeeId: 'employee-1', turnId: 'turn-2' }) })
    expect(stopped).toHaveBeenCalled()
  })

  it('drops a cancelled reply instead of reading it', async () => {
    await mount('employee-1', true)
    await act(async () => {
      publishStreamingSpeech({ kind: 'start', employeeId: 'employee-1', turnId: 'turn-1' })
      publishStreamingSpeech({ kind: 'delta', employeeId: 'employee-1', turnId: 'turn-1', content: '半句' })
      publishStreamingSpeech({ kind: 'cancel', employeeId: 'employee-1', turnId: 'turn-1' })
      publishStreamingSpeech({ kind: 'complete', employeeId: 'employee-1', turnId: 'turn-1' })
      await Promise.resolve()
    })
    expect(spoken).toEqual([])
  })

  it('does nothing when the conversation has no single character', async () => {
    await mount(undefined, true)
    await reply('employee-1', 'turn-1', ['群聊不播报'])
    expect(spoken).toEqual([])
  })
})

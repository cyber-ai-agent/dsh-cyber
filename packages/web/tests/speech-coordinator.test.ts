import { afterEach, describe, expect, it } from 'vitest'

import {
  activeSpeechOwner,
  claimSpeech,
  forgetVoiceTurn,
  registerVoiceTurn,
  releaseSpeechForEmployee,
  resetSpeechCoordinatorForTest,
  speechContextForTurn,
} from '../src/features/voice/SpeechCoordinator.js'

afterEach(() => resetSpeechCoordinatorForTest())

describe('SpeechCoordinator', () => {
  it('keeps one owner per employee and turn and gives Focus priority', () => {
    const composer = claimSpeech({ employeeId: 'employee-1', turnId: 'turn-1', owner: 'composer-fallback' })
    expect(composer).toBeDefined()
    expect(activeSpeechOwner('employee-1', 'turn-1')).toBe('composer-fallback')

    let replaced = 0
    const focus = claimSpeech({ employeeId: 'employee-1', turnId: 'turn-1', owner: 'focus-stream', onReplaced: () => { replaced += 1 } })
    expect(focus).toBeDefined()
    expect(activeSpeechOwner('employee-1', 'turn-1')).toBe('focus-stream')
    expect(composer?.isActive()).toBe(false)
    expect(replaced).toBe(0)

    expect(claimSpeech({ employeeId: 'employee-1', turnId: 'turn-1', owner: 'manual' })).toBeUndefined()
    focus?.release()
    expect(activeSpeechOwner('employee-1', 'turn-1')).toBeUndefined()
  })

  it('fires replacement cleanup when a higher-priority claim takes over', () => {
    let stopped = 0
    const manual = claimSpeech({ employeeId: 'employee-1', turnId: 'turn-2', owner: 'manual', onReplaced: () => { stopped += 1 } })
    expect(manual?.isActive()).toBe(true)
    const focus = claimSpeech({ employeeId: 'employee-1', turnId: 'turn-2', owner: 'focus-stream' })
    expect(focus).toBeDefined()
    expect(stopped).toBe(1)
    expect(manual?.isActive()).toBe(false)
  })

  it('releases all claims when an employee leaves the focused surface', () => {
    const first = claimSpeech({ employeeId: 'employee-1', turnId: 'turn-1', owner: 'focus-stream' })
    const second = claimSpeech({ employeeId: 'employee-1', turnId: 'turn-2', owner: 'composer-fallback' })
    const other = claimSpeech({ employeeId: 'employee-2', turnId: 'turn-1', owner: 'focus-stream' })
    releaseSpeechForEmployee('employee-1')
    expect(first?.isActive()).toBe(false)
    expect(second?.isActive()).toBe(false)
    expect(other?.isActive()).toBe(true)
  })

  it('records voice origin and removes it at turn termination', () => {
    registerVoiceTurn({ clientTurnId: 'client-1', worldId: 'world-1', conversationKey: 'direct:employee-1', surface: 'composer' })
    expect(speechContextForTurn('client-1')).toEqual({
      source: 'voice',
      surface: 'composer',
      clientTurnId: 'client-1',
      worldId: 'world-1',
      conversationKey: 'direct:employee-1',
    })
    forgetVoiceTurn('client-1')
    expect(speechContextForTurn('client-1')).toBeUndefined()
  })
})

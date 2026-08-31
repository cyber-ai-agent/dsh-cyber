import { useEffect, useRef } from 'react'
import type { EmployeeDossier } from '@dsh-cyber/contracts'

import { subscribeStreamingSpeech } from './streaming-speech-bus.js'
import { speakAsCharacter, stopCharacterSpeech } from './speak-as-character.js'

/**
 * Speaks replies for somebody talking through the chat composer.
 *
 * The composer has a microphone, so a user can talk to a character from the
 * chat surface — but nothing there ever subscribed to the streaming speech
 * bus, so the character answered in silence. Only the world's character panel
 * did, which meant a spoken conversation worked in one place and half-worked
 * in the other.
 *
 * Deliberately simpler than the panel's pipeline: it speaks a reply when the
 * reply is finished, rather than streaming sentence by sentence as it arrives.
 * That costs the time between the first word and the last, and it avoids a
 * second copy of the chunking, generation-counting and barge-in bookkeeping
 * that would then have to be kept in step with the original. The panel remains
 * the place to go for a low-latency spoken conversation.
 *
 * Renders nothing.
 */

interface ComposerReplySpeakerProps {
  /** The character being spoken to, when the conversation has exactly one. */
  employeeId: string | undefined
  dossiers: Record<string, EmployeeDossier>
  /** Off unless the user has actually spoken; typing does not want audio. */
  enabled: boolean
}

export function ComposerReplySpeaker({ employeeId, dossiers, enabled }: ComposerReplySpeakerProps) {
  const spokenTurnsRef = useRef(new Set<string>())
  const bufferRef = useRef(new Map<string, string>())

  useEffect(() => {
    if (!enabled || employeeId === undefined) return
    return subscribeStreamingSpeech((event) => {
      if (event.employeeId !== employeeId) return
      if (event.kind === 'start') {
        bufferRef.current.set(event.turnId, '')
        // A new reply supersedes whatever was still being read out.
        stopCharacterSpeech()
        return
      }
      if (event.kind === 'cancel') {
        bufferRef.current.delete(event.turnId)
        stopCharacterSpeech()
        return
      }
      if (event.kind === 'delta' && event.content !== undefined) {
        bufferRef.current.set(event.turnId, (bufferRef.current.get(event.turnId) ?? '') + event.content)
        return
      }
      if (event.kind !== 'complete') return
      const text = bufferRef.current.get(event.turnId) ?? event.content ?? ''
      bufferRef.current.delete(event.turnId)
      // A turn can complete more than once across reconnects; reading the same
      // reply twice is worse than not reading it.
      if (text.trim() === '' || spokenTurnsRef.current.has(event.turnId)) return
      spokenTurnsRef.current.add(event.turnId)
      if (spokenTurnsRef.current.size > 64) {
        spokenTurnsRef.current.delete(spokenTurnsRef.current.values().next().value as string)
      }
      void speakAsCharacter({
        employeeId,
        text,
        ...(dossiers[employeeId]?.profile === undefined ? {} : { profile: dossiers[employeeId]!.profile }),
      }).catch(() => undefined)
    })
  }, [dossiers, employeeId, enabled])

  useEffect(() => () => stopCharacterSpeech(), [])

  return null
}

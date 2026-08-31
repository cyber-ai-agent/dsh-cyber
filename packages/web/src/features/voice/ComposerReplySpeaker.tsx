import { useEffect, useRef } from 'react'
import type { EmployeeDossier } from '@dsh-cyber/contracts'

import { claimSpeech, type SpeechClaim } from './SpeechCoordinator.js'
import { subscribeStreamingSpeech } from './streaming-speech-bus.js'
import { speakAsCharacter, stopCharacterSpeech } from './speak-as-character.js'

/**
 * Speaks replies for a voice turn started in the chat composer.
 *
 * This is deliberately a fallback owner. The focused character panel claims
 * the same turn when it is streaming, so this component can stay mounted in
 * the hidden chat drawer without creating a second playback pipeline.
 */

interface ComposerReplySpeakerProps {
  /** The character being spoken to, when the conversation has exactly one. */
  employeeId: string | undefined
  /** Current durable session, used to reject a late event from another chat. */
  sessionId?: string
  /** Queue identity also covers a newly-created session before it is durable. */
  conversationKey?: string
  dossiers: Record<string, EmployeeDossier>
}

export function ComposerReplySpeaker({ employeeId, sessionId, conversationKey, dossiers }: ComposerReplySpeakerProps) {
  const spokenTurnsRef = useRef(new Set<string>())
  const bufferRef = useRef(new Map<string, string>())
  const claimsRef = useRef(new Map<string, SpeechClaim>())
  const dossiersRef = useRef(dossiers)
  dossiersRef.current = dossiers

  const stopOwnedSpeech = () => {
    if (claimsRef.current.size === 0) return
    for (const claim of claimsRef.current.values()) claim.release()
    claimsRef.current.clear()
    stopCharacterSpeech()
  }

  useEffect(() => {
    if (employeeId === undefined) return
    return subscribeStreamingSpeech((event) => {
      if (event.employeeId !== employeeId || event.source !== 'voice' || event.surface !== 'composer') return
      if (sessionId !== undefined && event.sessionId !== undefined && event.sessionId !== sessionId) return
      if (conversationKey !== undefined && event.conversationKey !== undefined && event.conversationKey !== conversationKey) return

      if (event.kind === 'start') {
        bufferRef.current.set(event.turnId, '')
        // A later voice turn supersedes a composer fallback that is still
        // playing. The coordinator keeps this scoped to our own claim.
        stopOwnedSpeech()
        return
      }
      if (event.kind === 'cancel') {
        bufferRef.current.delete(event.turnId)
        const claim = claimsRef.current.get(event.turnId)
        if (claim !== undefined) {
          claim.release()
          claimsRef.current.delete(event.turnId)
          stopCharacterSpeech()
        }
        return
      }
      if (event.kind === 'delta' && event.content !== undefined) {
        bufferRef.current.set(event.turnId, (bufferRef.current.get(event.turnId) ?? '') + event.content)
        return
      }
      if (event.kind !== 'complete') return
      const text = bufferRef.current.get(event.turnId) ?? event.content ?? ''
      bufferRef.current.delete(event.turnId)
      if (text.trim() === '' || spokenTurnsRef.current.has(event.turnId)) return

      const claim = claimSpeech({
        employeeId,
        turnId: event.clientTurnId ?? event.turnId,
        owner: 'composer-fallback',
      })
      // Focus streaming owns this turn when it is present. Do not start a
      // second full-reply playback just because the composer also saw it.
      if (claim === undefined) return
      spokenTurnsRef.current.add(event.turnId)
      if (spokenTurnsRef.current.size > 128) {
        const oldest = spokenTurnsRef.current.values().next().value
        if (typeof oldest === 'string') spokenTurnsRef.current.delete(oldest)
      }
      claimsRef.current.set(event.turnId, claim)
      void speakAsCharacter({
        employeeId,
        text,
        ...(dossiersRef.current[employeeId]?.profile === undefined ? {} : { profile: dossiersRef.current[employeeId]!.profile }),
      }).catch(() => undefined).finally(() => {
        claim.release()
        if (claimsRef.current.get(event.turnId)?.token === claim.token) claimsRef.current.delete(event.turnId)
      })
    })
  }, [conversationKey, employeeId, sessionId])

  useEffect(() => () => {
    stopOwnedSpeech()
    bufferRef.current.clear()
  }, [conversationKey, employeeId, sessionId])

  return null
}

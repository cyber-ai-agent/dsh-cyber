import { normalizeMossVoiceId, type EmployeeProfile, type VoiceModelDescriptor } from '@dsh-cyber/contracts'

import { api } from '../../api.js'
import { playKokoroSpeech, playMossSpeech, stopKokoroSpeech } from '../world/avatar/speech/KokoroSpeechAdapter.js'
import { speechTextFromMessage } from '../world/digital-human-motion.js'
import { resolveEmployeeVoiceProfile } from './employee-voice-profile.js'

/**
 * Says something in a character's own voice.
 *
 * Lifted out of the per-message play button so the composer can speak replies
 * too. The engine ladder is the point and is why this is worth sharing: a
 * system voice if one was chosen, then the local natural engine, then the fast
 * one — each falling through to the next rather than failing, because a
 * character that says nothing is indistinguishable from a broken one.
 */

export interface SpeakAsCharacterInput {
  employeeId: string
  text: string
  profile?: EmployeeProfile
  onStart?(): void
  onEnd?(): void
}

export function stopCharacterSpeech(): void {
  stopKokoroSpeech()
  if (typeof window !== 'undefined') window.speechSynthesis?.cancel()
}

export async function speakAsCharacter(input: SpeakAsCharacterInput): Promise<void> {
  const spokenText = speechTextFromMessage(input.text)
  if (spokenText.length === 0) throw new Error('这条回复没有可播报的文字')
  const voice = resolveEmployeeVoiceProfile(input.employeeId, input.profile?.gender, input.profile?.voiceProfile)

  let provider = voice.provider
  if (provider === 'auto') {
    try {
      const catalog = await api<{ models: VoiceModelDescriptor[] }>('/api/local-tts/models')
      provider = catalog.models.some((model) => model.provider === 'moss' && model.state === 'ready') ? 'moss' : 'kokoro'
    } catch {
      provider = 'kokoro'
    }
  }

  if (voice.voiceId.startsWith('system:') && typeof window !== 'undefined' && 'speechSynthesis' in window) {
    const voiceUri = voice.voiceId.slice('system:'.length)
    const systemVoice = window.speechSynthesis.getVoices()
      .find((item) => item.voiceURI === voiceUri && /^zh(?:-|_)/iu.test(item.lang))
    if (systemVoice !== undefined) {
      const utterance = new SpeechSynthesisUtterance(spokenText)
      utterance.voice = systemVoice
      utterance.lang = systemVoice.lang
      utterance.rate = voice.speed
      utterance.pitch = voice.pitch
      await new Promise<void>((resolve) => {
        utterance.onstart = () => input.onStart?.()
        utterance.onend = () => { input.onEnd?.(); resolve() }
        utterance.onerror = () => { input.onEnd?.(); resolve() }
        window.speechSynthesis.cancel()
        window.speechSynthesis.speak(utterance)
      })
      return
    }
  }

  if (provider === 'moss') {
    try {
      await playMossSpeech({
        text: spokenText,
        voiceId: normalizeMossVoiceId(voice.voiceId),
        speed: voice.speed,
        onStatus: () => undefined,
        onStart: () => input.onStart?.(),
        onEnd: () => input.onEnd?.(),
      })
      return
    } catch {
      // The natural engine is the nicer answer, not the only one.
      provider = 'kokoro'
    }
  }

  const localVoice = voice.voiceId.startsWith('kokoro:')
    ? voice
    : resolveEmployeeVoiceProfile(input.employeeId, input.profile?.gender, { ...voice, provider: 'kokoro', voiceId: '' })
  await playKokoroSpeech({
    text: spokenText,
    voiceId: localVoice.voiceId,
    speed: localVoice.speed,
    onStatus: () => undefined,
    onStart: () => input.onStart?.(),
    onEnd: () => input.onEnd?.(),
  })
}

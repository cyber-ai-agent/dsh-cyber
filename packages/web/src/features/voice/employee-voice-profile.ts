import { normalizeMossVoiceId, type CharacterGender, type EmployeeVoiceProfile } from '@dsh-cyber/contracts'

import { KOKORO_CHINESE_VOICES } from '../world/avatar/speech/KokoroSpeechAdapter.js'

export const DEFAULT_VOICE_SPEED = 1.1
/**
 * How fast a character may be asked to speak.
 *
 * The ceiling was 1.3x, which is barely above conversational and is the reason
 * playback read as slow: a user who wanted to move through a long answer had
 * nowhere left to go. 2x is where speech stops being comfortably followable,
 * so that is the bound; the floor stays low enough to be useful for listening
 * carefully to something.
 */
export const MIN_VOICE_SPEED = 0.7
export const MAX_VOICE_SPEED = 2

export function resolveEmployeeVoiceProfile(
  employeeId: string,
  gender: CharacterGender = 'neutral',
  profile?: EmployeeVoiceProfile,
): EmployeeVoiceProfile {
  const voiceId = profile?.voiceId && (profile.voiceId.startsWith('system:') || profile.voiceId.startsWith('moss:') || KOKORO_CHINESE_VOICES.some((voice) => voice.id === profile.voiceId)) && voiceMatchesGender(profile.voiceId, gender)
    ? profile.voiceId
    : stableVoiceId(employeeId, gender)
  return {
    provider: profile?.provider ?? 'auto',
    voiceId: voiceId.startsWith('moss:') ? normalizeMossVoiceId(voiceId) : voiceId,
    speed: normalizeVoiceSpeed(profile?.speed),
    pitch: normalizeVoicePitch(profile?.pitch),
  }
}

export function stableVoiceId(employeeId: string, gender: CharacterGender): string {
  const candidates = gender === 'female'
    ? KOKORO_CHINESE_VOICES.filter((voice) => voice.gender === '女声')
    : gender === 'male'
      ? KOKORO_CHINESE_VOICES.filter((voice) => voice.gender === '男声')
      : KOKORO_CHINESE_VOICES
  let hash = 0
  for (const character of employeeId) hash = (hash * 31 + character.charCodeAt(0)) >>> 0
  return candidates[hash % candidates.length]!.id
}

export function voiceMatchesGender(voiceId: string, gender: CharacterGender): boolean {
  if (gender === 'neutral' || voiceId.startsWith('system:')) return true
  const option = KOKORO_CHINESE_VOICES.find((voice) => voice.id === voiceId)
  return option?.gender === (gender === 'female' ? '女声' : '男声')
}

export function normalizeVoiceSpeed(value: number | undefined): number {
  return Number.isFinite(value) ? Math.min(MAX_VOICE_SPEED, Math.max(MIN_VOICE_SPEED, Math.round(value! * 20) / 20)) : DEFAULT_VOICE_SPEED
}

function normalizeVoicePitch(value: number | undefined): number {
  return Number.isFinite(value) ? Math.min(1.2, Math.max(0.8, Math.round(value! * 20) / 20)) : 1
}

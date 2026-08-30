import type { CharacterGender, EmployeeVoiceProfile } from '@dsh-cyber/contracts'

import { KOKORO_CHINESE_VOICES } from '../world/avatar/speech/KokoroSpeechAdapter.js'

export const DEFAULT_VOICE_SPEED = 1.1

export function resolveEmployeeVoiceProfile(
  employeeId: string,
  gender: CharacterGender = 'neutral',
  profile?: EmployeeVoiceProfile,
): EmployeeVoiceProfile {
  const voiceId = profile?.voiceId && (profile.voiceId.startsWith('system:') || KOKORO_CHINESE_VOICES.some((voice) => voice.id === profile.voiceId)) && voiceMatchesGender(profile.voiceId, gender)
    ? profile.voiceId
    : stableVoiceId(employeeId, gender)
  return {
    provider: profile?.provider ?? 'auto',
    voiceId,
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
  return Number.isFinite(value) ? Math.min(1.3, Math.max(0.8, Math.round(value! * 20) / 20)) : DEFAULT_VOICE_SPEED
}

function normalizeVoicePitch(value: number | undefined): number {
  return Number.isFinite(value) ? Math.min(1.2, Math.max(0.8, Math.round(value! * 20) / 20)) : 1
}

export interface SpeechVoiceOption {
  voiceURI: string
  name: string
  lang: string
  localService: boolean
  default: boolean
}

export function normalizeSpeechVoices(voices: readonly SpeechSynthesisVoice[]): SpeechSynthesisVoice[] {
  const unique = new Map<string, SpeechSynthesisVoice>()
  for (const voice of voices) {
    const key = `${voice.voiceURI}\u0000${voice.lang}`
    if (!unique.has(key)) unique.set(key, voice)
  }
  return [...unique.values()].sort(compareSpeechVoices)
}

export function compareSpeechVoices(left: Pick<SpeechSynthesisVoice, 'lang' | 'name' | 'localService'>, right: Pick<SpeechSynthesisVoice, 'lang' | 'name' | 'localService'>): number {
  const leftChinese = /^zh(?:-|_)/iu.test(left.lang) ? 0 : 1
  const rightChinese = /^zh(?:-|_)/iu.test(right.lang) ? 0 : 1
  return leftChinese - rightChinese
    || Number(!left.localService) - Number(!right.localService)
    || left.lang.localeCompare(right.lang)
    || left.name.localeCompare(right.name)
}

export function resolveSpeechVoice(voices: readonly SpeechSynthesisVoice[], voiceId: string): SpeechSynthesisVoice | undefined {
  if (voiceId.length === 0) return undefined
  return voices.find((voice) => voice.voiceURI === voiceId)
}

let amplitude: number | undefined
const listeners = new Set<() => void>()

export function currentSpeechAmplitude(): number | undefined { return amplitude }
export function subscribeSpeechAmplitude(listener: () => void): () => void { listeners.add(listener); return () => listeners.delete(listener) }
export function setSpeechAmplitude(value: number | undefined): void {
  if (value === amplitude) return
  amplitude = value
  for (const listener of listeners) listener()
}

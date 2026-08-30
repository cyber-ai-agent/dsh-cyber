export interface StreamingSpeechEvent {
  kind: 'start' | 'delta' | 'complete' | 'cancel'
  employeeId: string
  turnId: string
  content?: string
}

const listeners = new Set<(event: StreamingSpeechEvent) => void>()
export function publishStreamingSpeech(event: StreamingSpeechEvent): void { for (const listener of listeners) listener(event) }
export function subscribeStreamingSpeech(listener: (event: StreamingSpeechEvent) => void): () => void { listeners.add(listener); return () => listeners.delete(listener) }

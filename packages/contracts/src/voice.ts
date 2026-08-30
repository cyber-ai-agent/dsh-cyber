export type VoiceRuntimeState = 'cold' | 'warming' | 'ready' | 'busy' | 'failed'
export type VoicePerformanceProfile = 'fast' | 'balanced' | 'quality'
export type VoicePrewarmPolicy = 'off' | 'on-demand' | 'smart'
export type VoiceProviderKind = 'system' | 'kokoro' | 'cosyvoice' | 'paraformer' | 'sensevoice' | 'fun-asr'

export interface TranscriptEvent {
  sessionId: string
  utteranceId: string
  text: string
  final: boolean
  startedAt: number
  completedAt?: number
  confidence?: number
  language?: string
}

export interface SpeechToTextCapabilities {
  streaming: boolean
  partial: boolean
  vad: boolean
  timestamps: boolean
  languageDetection: boolean
  diarization: boolean
}

export interface SttSessionOptions {
  sessionId: string
  language: string
  sampleRate: number
  frameDurationMs: 20 | 40
  endpointSilenceMs: number
}

export interface SttSession {
  pushAudio(pcm: Int16Array, timestamp: number): void
  end(): Promise<void>
  cancel(): void
  onPartial(callback: (event: TranscriptEvent) => void): () => void
  onFinal(callback: (event: TranscriptEvent) => void): () => void
}

export interface SpeechToTextProvider {
  id: string
  kind: VoiceProviderKind
  capabilities: SpeechToTextCapabilities
  prepare(): Promise<void>
  createSession(options: SttSessionOptions): Promise<SttSession>
  dispose(): Promise<void>
}

export interface TextToSpeechCapabilities {
  streaming: boolean
  pcm: boolean
  viseme: boolean
  voiceClone: boolean
}

export interface VisemeFrame {
  atMs: number
  durationMs: number
  viseme: 'aa' | 'ih' | 'ou' | 'ee' | 'oh' | 'sil'
  weight: number
}

export interface AudioChunk {
  sequence: number
  pcm?: Float32Array
  encoded?: Uint8Array
  sampleRate: number
  durationMs: number
  visemes?: VisemeFrame[]
  final: boolean
}

export interface TtsRequest {
  requestId: string
  text: string
  voiceId: string
  speed: number
  pitch?: number
  signal?: AbortSignal
}

export interface TextToSpeechProvider {
  id: string
  kind: VoiceProviderKind
  capabilities: TextToSpeechCapabilities
  prepare(): Promise<void>
  synthesize(request: TtsRequest): AsyncIterable<AudioChunk>
  cancel(requestId?: string): void
  dispose(): Promise<void>
}

export interface VoiceModelDescriptor {
  id: string
  provider: VoiceProviderKind
  displayName: string
  version: string
  license: string
  byteLength: number
  state: 'not-installed' | 'downloading' | 'installed' | 'loading' | 'ready' | 'error'
  installedPath?: string
  sha256?: string
  error?: string
}

export interface VoicePerformanceMetrics {
  provider: string
  device: string
  coldStartMs: number
  firstPartialMs?: { p50: number; p95: number }
  finalMs?: { p50: number; p95: number }
  firstAudioMs?: { p50: number; p95: number }
  realtimeFactor?: { p50: number; p95: number }
  memoryMb: number
  cpuPercent?: { p50: number; p95: number }
  blocksMainThread: boolean
}

export interface EmployeeVoiceProfile {
  provider: 'auto' | 'system' | 'kokoro' | 'cosyvoice'
  voiceId: string
  speed: number
  pitch: number
}

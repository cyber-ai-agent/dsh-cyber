import { createRequire } from 'node:module'
import { parentPort, workerData } from 'node:worker_threads'
import { join } from 'node:path'

interface SherpaModule {
  OnlineRecognizer: new (config: unknown) => OnlineRecognizer
  Vad: new (config: unknown, bufferSeconds: number) => Vad
}
interface OnlineRecognizer {
  createStream(): OnlineStream
  isReady(stream: OnlineStream): boolean
  decode(stream: OnlineStream): void
  getResult(stream: OnlineStream): { text: string }
}
interface OnlineStream { acceptWaveform(input: { samples: Float32Array; sampleRate: number }): void; inputFinished(): void }
interface Vad { acceptWaveform(samples: Float32Array): void; isDetected(): boolean; isEmpty(): boolean; front(external?: boolean): { start: number; samples: Float32Array }; pop(): void; flush(): void }
interface SessionState { stream: OnlineStream; vad: Vad; pendingVad: Float32Array; previous: string; utterance: number; speech: boolean; energeticFrames: number }

const port = parentPort
if (port === null) throw new Error('Voice worker requires parentPort')
const root = (workerData as { modelRoot: string }).modelRoot
const require = createRequire(import.meta.url)
let sherpa: SherpaModule | undefined
let recognizer: OnlineRecognizer | undefined
const sessions = new Map<string, SessionState>()

port.on('message', (message: WorkerCommand) => {
  try {
    if (message.type === 'prepare') { prepare(); emit({ type: 'prepared', requestId: message.requestId }); return }
    if (message.type === 'start') { prepare(); sessions.set(message.sessionId, createSession(message.endpointSilenceMs)); emit({ type: 'listening', sessionId: message.sessionId }); return }
    if (message.type === 'audio') { acceptAudio(message); return }
    if (message.type === 'stop') { finish(message.sessionId); return }
    if (message.type === 'cancel') { sessions.delete(message.sessionId); emit({ type: 'cancelled', sessionId: message.sessionId }); return }
  } catch (error) {
    emit({
      type: 'error',
      ...('requestId' in message ? { requestId: message.requestId } : {}),
      ...('sessionId' in message ? { sessionId: message.sessionId } : {}),
      message: error instanceof Error ? error.message : String(error),
    })
  }
})

function prepare(): void {
  if (recognizer !== undefined) return
  sherpa = require('sherpa-onnx-node') as SherpaModule
  recognizer = new sherpa.OnlineRecognizer({
    featConfig: { sampleRate: 16_000, featureDim: 80 },
    modelConfig: {
      paraformer: { encoder: join(root, 'encoder.int8.onnx'), decoder: join(root, 'decoder.int8.onnx') },
      tokens: join(root, 'tokens.txt'), numThreads: 2, provider: 'cpu', debug: false,
    },
    enableEndpoint: true, rule1MinTrailingSilence: 2.4, rule2MinTrailingSilence: 0.65, rule3MinUtteranceLength: 20,
  })
}

function createSession(endpointSilenceMs: number): SessionState {
  if (recognizer === undefined || sherpa === undefined) throw new Error('Voice recognizer is not prepared')
  return {
    stream: recognizer.createStream(),
    vad: new sherpa.Vad({
      sileroVad: {
        model: join(root, 'silero_vad.int8.onnx'), threshold: 0.42,
        minSilenceDuration: Math.max(0.45, Math.min(0.9, endpointSilenceMs / 1_000)),
        minSpeechDuration: 0.05, windowSize: 512, maxSpeechDuration: 30,
      },
      sampleRate: 16_000, numThreads: 1, provider: 'cpu', debug: false,
    }, 60),
    pendingVad: new Float32Array(0), previous: '', utterance: 0, speech: false, energeticFrames: 0,
  }
}

function acceptAudio(message: Extract<WorkerCommand, { type: 'audio' }>): void {
  const session = sessions.get(message.sessionId)
  if (session === undefined || recognizer === undefined) return
  const int16 = new Int16Array(message.pcm)
  const pcm = new Float32Array(int16.length)
  let energy = 0
  for (let index = 0; index < int16.length; index += 1) { pcm[index] = int16[index]! / 32_768; energy += pcm[index]! * pcm[index]! }
  const rms = Math.sqrt(energy / Math.max(1, pcm.length))
  session.energeticFrames = rms >= 0.008 ? session.energeticFrames + 1 : 0
  if (session.energeticFrames >= 3 && !session.speech) {
    session.speech = true
    emit({ type: 'speech-start', sessionId: message.sessionId, utteranceId: `${message.sessionId}:${session.utterance}` })
  }
  session.stream.acceptWaveform({ samples: pcm, sampleRate: 16_000 })
  while (recognizer.isReady(session.stream)) recognizer.decode(session.stream)
  const text = recognizer.getResult(session.stream).text.trim()
  if (text && text !== session.previous) {
    session.previous = text
    emit({ type: 'partial', sessionId: message.sessionId, utteranceId: `${message.sessionId}:${session.utterance}`, text, receivedAt: message.timestamp })
  }
  session.pendingVad = concatenate(session.pendingVad, pcm)
  while (session.pendingVad.length >= 512) {
    session.vad.acceptWaveform(session.pendingVad.slice(0, 512))
    session.pendingVad = session.pendingVad.slice(512)
    if (session.vad.isDetected() && !session.speech) {
      session.speech = true
      emit({ type: 'speech-start', sessionId: message.sessionId, utteranceId: `${message.sessionId}:${session.utterance}` })
    }
    drainVad(message.sessionId, session)
  }
}

function drainVad(sessionId: string, session: SessionState): void {
  while (!session.vad.isEmpty()) {
    const segment = session.vad.front(false)
    session.vad.pop()
    finalize(sessionId, session, segment.samples.length)
  }
}

function finalize(sessionId: string, session: SessionState, sampleCount: number): void {
  if (recognizer === undefined) return
  session.stream.acceptWaveform({ samples: new Float32Array(6_400), sampleRate: 16_000 })
  while (recognizer.isReady(session.stream)) recognizer.decode(session.stream)
  const text = recognizer.getResult(session.stream).text.trim() || session.previous
  if (text) emit({ type: 'final', sessionId, utteranceId: `${sessionId}:${session.utterance}`, text, audioDurationMs: sampleCount / 16_000 * 1_000 })
  emit({ type: 'speech-end', sessionId, utteranceId: `${sessionId}:${session.utterance}` })
  session.utterance += 1; session.previous = ''; session.speech = false; session.energeticFrames = 0; session.stream = recognizer.createStream()
}

function finish(sessionId: string): void {
  const session = sessions.get(sessionId)
  if (session === undefined) return
  session.vad.flush(); drainVad(sessionId, session)
  if (session.previous) finalize(sessionId, session, 0)
  sessions.delete(sessionId)
  emit({ type: 'stopped', sessionId })
}

function concatenate(left: Float32Array, right: Float32Array): Float32Array {
  const value = new Float32Array(left.length + right.length); value.set(left); value.set(right, left.length); return value
}

function emit(event: WorkerEvent): void { port!.postMessage(event) }

type WorkerCommand =
  | { type: 'prepare'; requestId: string }
  | { type: 'start'; sessionId: string; endpointSilenceMs: number }
  | { type: 'audio'; sessionId: string; pcm: ArrayBuffer; timestamp: number }
  | { type: 'stop' | 'cancel'; sessionId: string }
type WorkerEvent =
  | { type: 'prepared'; requestId: string }
  | { type: 'listening' | 'cancelled' | 'stopped'; sessionId: string }
  | { type: 'speech-start' | 'speech-end'; sessionId: string; utteranceId: string }
  | { type: 'partial'; sessionId: string; utteranceId: string; text: string; receivedAt: number }
  | { type: 'final'; sessionId: string; utteranceId: string; text: string; audioDurationMs: number }
  | { type: 'error'; requestId?: string; sessionId?: string; message: string }

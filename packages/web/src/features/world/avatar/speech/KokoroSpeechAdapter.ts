export interface KokoroVoiceOption {
  id: `kokoro:${number}`
  speakerId: number
  label: string
  gender: '女声' | '男声'
}

export const KOKORO_CHINESE_VOICES: readonly KokoroVoiceOption[] = [
  ...Array.from({ length: 55 }, (_, index): KokoroVoiceOption => ({
    id: `kokoro:${index + 3}`,
    speakerId: index + 3,
    label: `中文女声 ${String(index + 1).padStart(2, '0')}`,
    gender: '女声',
  })),
  ...Array.from({ length: 45 }, (_, index): KokoroVoiceOption => ({
    id: `kokoro:${index + 58}`,
    speakerId: index + 58,
    label: `中文男声 ${String(index + 1).padStart(2, '0')}`,
    gender: '男声',
  })),
]

let audioContext: AudioContext | undefined
let analyser: AnalyserNode | undefined
const activeSources = new Set<AudioBufferSourceNode>()
const activeRequests = new Set<AbortController>()
let playbackCursor = 0
let amplitudeFrame: number | undefined
let generation = 0

export async function playKokoroSpeech(input: {
  text: string
  voiceId: string
  onStatus(message: string): void
  onStart(): void
  onEnd(): void
}): Promise<void> {
  const option = KOKORO_CHINESE_VOICES.find((voice) => voice.id === input.voiceId)
  if (option === undefined) throw new Error('所选本地中文声音不存在')
  stopKokoroSpeech()
  return appendKokoroSpeech(input)
}

export async function appendKokoroSpeech(input: {
  text: string
  voiceId: string
  onStatus(message: string): void
  onStart(): void
  onEnd(): void
}): Promise<void> {
  const option = KOKORO_CHINESE_VOICES.find((voice) => voice.id === input.voiceId)
  if (option === undefined) throw new Error('所选本地中文声音不存在')
  const context = getAudioContext()
  const resumePromise = context.state === 'suspended' ? context.resume() : Promise.resolve()
  const requestGeneration = generation
  const controller = new AbortController()
  activeRequests.add(controller)
  input.onStatus('正在由本地 sherpa-onnx 生成中文语音…')
  const response = await fetch('/api/local-tts/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: input.text, speakerId: option.speakerId, speed: 0.96 }),
    signal: controller.signal,
  })
  if (!response.ok) {
    const payload = await response.json().catch(() => undefined) as { error?: { message?: string } } | undefined
    throw new Error(payload?.error?.message ?? '本地语音服务生成失败')
  }
  await resumePromise
  if (requestGeneration !== generation) return
  if (context.state !== 'running') throw new Error('浏览器暂停了音频输出，请再次点击播放')
  if (response.body === null) throw new Error('本地语音服务没有返回音频流')
  let nextStartAt = Math.max(context.currentTime + 0.03, playbackCursor)
  let totalDuration = 0
  let started = false
  for await (const frame of readPcmFrames(response.body)) {
    if (requestGeneration !== generation) return
    const buffer = context.createBuffer(1, frame.pcm.length, frame.sampleRate)
    buffer.getChannelData(0).set(frame.pcm)
    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(getAnalyser(context))
    const startAt = Math.max(context.currentTime + 0.02, nextStartAt)
    nextStartAt = startAt + buffer.duration
    playbackCursor = nextStartAt
    totalDuration += buffer.duration
    activeSources.add(source)
    source.onended = () => {
      activeSources.delete(source)
      source.disconnect()
      if (frame.final && requestGeneration === generation) input.onEnd()
      if (activeSources.size === 0) stopAmplitudeMonitor()
    }
    source.start(startAt)
    if (!started) {
      started = true
      startAmplitudeMonitor(context)
      input.onStart()
      input.onStatus('正在播放本地流式中文语音，回复内容不会上传。')
    } else {
      input.onStatus(`正在播放本地流式中文语音（已排队 ${totalDuration.toFixed(1)} 秒）。`)
    }
  }
  activeRequests.delete(controller)
  if (!started) throw new Error('本地语音服务没有生成可播放音频')
}

export function stopKokoroSpeech(): void {
  generation += 1
  for (const request of activeRequests) request.abort()
  activeRequests.clear()
  for (const source of activeSources) {
    source.onended = null
    try { source.stop() } catch { /* source may already have ended */ }
    source.disconnect()
  }
  cleanupAudio()
}

function cleanupAudio(): void {
  activeSources.clear()
  playbackCursor = 0
  stopAmplitudeMonitor()
}

function getAnalyser(context: AudioContext): AnalyserNode {
  if (analyser !== undefined) return analyser
  analyser = context.createAnalyser(); analyser.fftSize = 512; analyser.smoothingTimeConstant = 0.32; analyser.connect(context.destination)
  return analyser
}

function startAmplitudeMonitor(context: AudioContext): void {
  if (amplitudeFrame !== undefined || analyser === undefined) return
  const samples = new Float32Array(analyser.fftSize)
  const update = () => {
    if (activeSources.size === 0 || analyser === undefined) { stopAmplitudeMonitor(); return }
    analyser.getFloatTimeDomainData(samples)
    let energy = 0
    for (const sample of samples) energy += sample * sample
    setSpeechAmplitude(Math.sqrt(energy / samples.length))
    amplitudeFrame = requestAnimationFrame(update)
  }
  amplitudeFrame = requestAnimationFrame(update)
  void context.resume()
}

function stopAmplitudeMonitor(): void {
  if (amplitudeFrame !== undefined) cancelAnimationFrame(amplitudeFrame)
  amplitudeFrame = undefined
  setSpeechAmplitude(undefined)
}

function getAudioContext(): AudioContext {
  audioContext ??= new AudioContext()
  return audioContext
}

interface PcmFrame { sequence: number; sampleRate: number; pcm: Float32Array; final: boolean }

async function* readPcmFrames(stream: ReadableStream<Uint8Array>): AsyncIterable<PcmFrame> {
  const reader = stream.getReader()
  let pending = new Uint8Array(0)
  for (;;) {
    const result = await reader.read()
    if (result.done) break
    const combined = new Uint8Array(pending.length + result.value.length)
    combined.set(pending); combined.set(result.value, pending.length); pending = combined
    while (pending.length >= 20) {
      const header = new DataView(pending.buffer, pending.byteOffset, 20)
      if (String.fromCharCode(...pending.subarray(0, 4)) !== 'DSHV') throw new Error('本地语音流格式无效')
      const sampleCount = header.getUint32(12, true)
      const frameBytes = 20 + sampleCount * 4
      if (pending.length < frameBytes) break
      const payload = new DataView(pending.buffer, pending.byteOffset + 20, sampleCount * 4)
      const pcm = new Float32Array(sampleCount)
      for (let index = 0; index < sampleCount; index += 1) pcm[index] = payload.getFloat32(index * 4, true)
      yield { sequence: header.getUint32(4, true), sampleRate: header.getUint32(8, true), pcm, final: (header.getUint32(16, true) & 1) === 1 }
      pending = pending.slice(frameBytes)
    }
  }
  if (pending.length !== 0) throw new Error('本地语音流提前结束')
}
import { setSpeechAmplitude } from './speech-playback-state.js'

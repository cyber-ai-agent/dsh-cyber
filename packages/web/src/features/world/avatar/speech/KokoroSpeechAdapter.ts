import { readPcmFrames } from '../../../voice/PcmFrameStream.js'
import { setSpeechAmplitude } from './speech-playback-state.js'

export interface KokoroVoiceOption {
  id: `kokoro:${number}`
  speakerId: number
  label: string
  gender: '女声' | '男声'
}

const FEMALE_VOICE_STYLES = ['清澈知性', '温柔叙事', '明亮活力', '沉静专业', '轻柔陪伴', '干练播报', '元气轻快', '优雅从容', '亲切自然', '理性克制', '温暖成熟'] as const
const MALE_VOICE_STYLES = ['沉稳低音', '温和讲述', '清朗青年', '理性专业', '成熟磁性', '干练播报', '亲切自然', '冷静克制', '温暖陪伴'] as const
const VOICE_TONES = ['自然', '轻柔', '清亮', '沉稳', '灵动'] as const

export const KOKORO_CHINESE_VOICES: readonly KokoroVoiceOption[] = [
  ...Array.from({ length: 55 }, (_, index): KokoroVoiceOption => ({
    id: `kokoro:${index + 3}`,
    speakerId: index + 3,
    label: `${FEMALE_VOICE_STYLES[Math.floor(index / VOICE_TONES.length)]} · ${VOICE_TONES[index % VOICE_TONES.length]}`,
    gender: '女声',
  })),
  ...Array.from({ length: 45 }, (_, index): KokoroVoiceOption => ({
    id: `kokoro:${index + 58}`,
    speakerId: index + 58,
    label: `${MALE_VOICE_STYLES[Math.floor(index / VOICE_TONES.length)]} · ${VOICE_TONES[index % VOICE_TONES.length]}`,
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
  speed?: number
  onStatus(message: string): void
  onStart(): void
  onEnd(): void
}): Promise<void> {
  const option = KOKORO_CHINESE_VOICES.find((voice) => voice.id === input.voiceId)
  if (option === undefined) throw new Error('所选本地中文声音不存在')
  stopKokoroSpeech()
  const chunks = splitKokoroSpeechText(input.text)
  if (chunks.length === 0) throw new Error('没有可播报的文字内容')
  for (let index = 0; index < chunks.length; index += 1) {
    await appendKokoroSpeech({
      ...input,
      text: chunks[index]!,
      onEnd: index === chunks.length - 1 ? input.onEnd : () => undefined,
    })
  }
}

export async function playMossSpeech(input: {
  text: string
  voiceId?: string
  speed?: number
  onStatus(message: string): void
  onStart(): void
  onEnd(): void
}): Promise<void> {
  stopKokoroSpeech()
  const chunks = splitKokoroSpeechText(input.text)
  if (chunks.length === 0) throw new Error('没有可播报的文字内容')
  for (let index = 0; index < chunks.length; index += 1) {
    await appendKokoroSpeech({
      ...input,
      text: chunks[index]!,
      voiceId: input.voiceId ?? 'moss:Junhao',
      provider: 'moss',
      onEnd: index === chunks.length - 1 ? input.onEnd : () => undefined,
    })
  }
}

export async function appendKokoroSpeech(input: {
  text: string
  voiceId: string
  provider?: 'kokoro' | 'moss'
  speed?: number
  onStatus(message: string): void
  onStart(): void
  onEnd(): void
}): Promise<void> {
  const provider = input.provider ?? 'kokoro'
  const option = KOKORO_CHINESE_VOICES.find((voice) => voice.id === input.voiceId)
  if (provider === 'kokoro' && option === undefined) throw new Error('所选本地中文声音不存在')
  const context = getAudioContext()
  const resumePromise = context.state === 'suspended' ? context.resume() : Promise.resolve()
  const requestGeneration = generation
  const controller = new AbortController()
  activeRequests.add(controller)
  let timedOut = false
  const timeout = window.setTimeout(() => { timedOut = true; controller.abort() }, 28_000)
  try {
    input.onStatus('正在生成中文语音…')
    const response = await fetch('/api/local-tts/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: input.text, speakerId: option?.speakerId ?? 58, speed: normalizeSpeed(input.speed), provider, voiceId: input.voiceId }),
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
      if (frame.pcm.length === 0) {
        if (frame.final && started) scheduleFinalMarker(context, nextStartAt, requestGeneration, input.onEnd)
        continue
      }
      const buffer = context.createBuffer(1, frame.pcm.length, frame.sampleRate)
      buffer.getChannelData(0).set(frame.pcm)
      const source = context.createBufferSource()
      source.buffer = buffer
      const playbackRate = provider === 'moss' ? normalizeSpeed(input.speed) : 1
      source.playbackRate.value = playbackRate
      source.connect(getAnalyser(context))
      const startAt = Math.max(context.currentTime + 0.02, nextStartAt)
      nextStartAt = startAt + buffer.duration / playbackRate
      playbackCursor = nextStartAt
      totalDuration += buffer.duration / playbackRate
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
        input.onStatus('正在播放中文语音')
      } else {
        input.onStatus(`正在播放中文语音（已排队 ${totalDuration.toFixed(1)} 秒）`)
      }
    }
    if (!started) throw new Error('本地语音服务没有生成可播放音频')
  } catch (cause) {
    if (timedOut) throw new Error('本地语音生成超时，已自动停止，请重试或缩短播报内容')
    throw cause
  } finally {
    window.clearTimeout(timeout)
    activeRequests.delete(controller)
  }
}

export function splitKokoroSpeechText(value: string, maximumLength = 120): string[] {
  const text = value
    .normalize('NFKC')
    .replace(/[\u{1F000}-\u{1FAFF}\u2600-\u27BF\uFE0F]/gu, ' ')
    .replace(/\p{C}/gu, ' ')
    .replace(/\s+/gu, ' ')
    .replace(/\s+([。！？!?；;，,、])/gu, '$1')
    .trim()
  if (text.length === 0) return []
  const sentences = text.match(/[^。！？!?；;]+[。！？!?；;]?/gu) ?? [text]
  const chunks: string[] = []
  for (const sentence of sentences) {
    let remaining = sentence.trim()
    while (remaining.length > maximumLength) {
      const candidate = remaining.slice(0, maximumLength)
      const separator = Math.max(candidate.lastIndexOf('，'), candidate.lastIndexOf(','), candidate.lastIndexOf('、'), candidate.lastIndexOf(' '))
      const boundary = separator >= Math.floor(maximumLength * 0.45) ? separator + 1 : maximumLength
      chunks.push(remaining.slice(0, boundary).trim())
      remaining = remaining.slice(boundary).trim()
    }
    if (remaining.length > 0) chunks.push(remaining)
  }
  return chunks
}

function normalizeSpeed(value: number | undefined): number {
  return Math.max(0.8, Math.min(1.3, value ?? 1.1))
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

function scheduleFinalMarker(context: AudioContext, startAt: number, requestGeneration: number, onEnd: () => void): void {
  const buffer = context.createBuffer(1, 1, context.sampleRate)
  const source = context.createBufferSource()
  source.buffer = buffer
  source.connect(context.destination)
  activeSources.add(source)
  source.onended = () => {
    activeSources.delete(source)
    source.disconnect()
    if (requestGeneration === generation) onEnd()
    if (activeSources.size === 0) stopAmplitudeMonitor()
  }
  source.start(Math.max(context.currentTime + 0.005, startAt))
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

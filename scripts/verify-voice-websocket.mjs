import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'

const requireFromServer = createRequire(new URL('../packages/server/package.json', import.meta.url))
const { WebSocket } = requireFromServer('ws')
const sherpa = requireFromServer('sherpa-onnx-node')
const stateRoot = process.env.DSH_CYBER_DATA_DIR
  ?? (process.platform === 'win32' && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'DSH Cyber') : join(homedir(), '.dsh-cyber'))
const ttsRoot = join(stateRoot, 'tts', 'sherpa', 'kokoro-int8-multi-lang-v1_1')
const socket = new WebSocket(process.env.DSH_VOICE_WS_URL ?? 'ws://127.0.0.1:43123/api/voice/session', { origin: 'http://127.0.0.1:43123' })
const events = []
let sessionStarted
let finalEvent
let receivedFinal
let speechStartElapsedMs
let speechStartWallTime
socket.on('message', (data) => {
  const event = JSON.parse(String(data)); events.push(event)
  if (event.type === 'prepared') socket.send(JSON.stringify({ type: 'start', endpointSilenceMs: 650 }))
  if (event.type === 'session-started') sessionStarted?.()
  if (event.type === 'speech-start') { speechStartWallTime = performance.now(); speechStartElapsedMs = speechStartWallTime - audioStartedAt }
  if (event.type === 'final') { receivedFinal = event; finalEvent?.(event) }
})
await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
socket.send(JSON.stringify({ type: 'prepare' }))
await new Promise((resolve, reject) => { sessionStarted = resolve; setTimeout(() => reject(new Error('Voice WebSocket start timeout')), 15_000) })

const tts = await sherpa.OfflineTts.createAsync({
  model: { kokoro: {
    model: join(ttsRoot, 'model.int8.onnx'), voices: join(ttsRoot, 'voices.bin'), tokens: join(ttsRoot, 'tokens.txt'), dataDir: join(ttsRoot, 'espeak-ng-data'),
    lexicon: `${join(ttsRoot, 'lexicon-us-en.txt')},${join(ttsRoot, 'lexicon-zh.txt')}`,
  }, debug: false, numThreads: 2, provider: 'cpu' }, maxNumSentences: 1,
})
const generated = await tts.generateAsync({ text: '帮我检查昨天的服务日志', enableExternalBuffer: true, generationConfig: new sherpa.GenerationConfig({ sid: 58, speed: 1, silenceScale: 0.2 }) })
const samples = resample(generated.samples, generated.sampleRate, 16_000)
const sourceOnsetMs = detectSpeechOnset(samples, 16_000)
const stableSourceOnsetMs = detectStableSpeechOnset(samples, 16_000)
const input = concatenate([new Float32Array(3_200), samples, new Float32Array(16_000)])
let audioStartedAt = performance.now()
let energeticFrames = 0
let stableOnsetSentAt
const energeticTimestamps = []
for (let offset = 0; offset < input.length; offset += 320) {
  const frame = input.slice(offset, offset + 320)
  let energy = 0; for (const sample of frame) energy += sample * sample
  const sentAt = performance.now()
  energeticFrames = Math.sqrt(energy / Math.max(1, frame.length)) >= 0.008 ? energeticFrames + 1 : 0
  if (energeticFrames === 0) energeticTimestamps.length = 0
  else { energeticTimestamps.push(sentAt); if (energeticTimestamps.length > 3) energeticTimestamps.shift() }
  if (energeticFrames >= 3 && stableOnsetSentAt === undefined) stableOnsetSentAt = energeticTimestamps[0]
  const packet = Buffer.allocUnsafe(8 + frame.length * 2); packet.writeDoubleLE(sentAt, 0)
  for (let index = 0; index < frame.length; index += 1) packet.writeInt16LE(Math.round(Math.max(-1, Math.min(1, frame[index])) * 32767), 8 + index * 2)
  socket.send(packet)
  await new Promise((resolve) => setTimeout(resolve, 20))
}
const final = receivedFinal ?? await new Promise((resolve, reject) => { finalEvent = resolve; setTimeout(() => reject(new Error('Voice WebSocket final timeout')), 15_000) })
socket.send(JSON.stringify({ type: 'stop' })); socket.close()
const partials = events.filter((event) => event.type === 'partial')
if (partials.length === 0) throw new Error('Voice WebSocket emitted no partial transcript')
if (!events.some((event) => event.type === 'speech-start')) throw new Error('Voice WebSocket emitted no speech-start')
process.stdout.write(`${JSON.stringify({ elapsedMs: performance.now() - audioStartedAt, sourceSpeechOnsetMs: 200 + sourceOnsetMs, stableSpeechOnsetMs: 200 + stableSourceOnsetMs, speechStartElapsedMs, bargeInLatencyMs: speechStartWallTime - stableOnsetSentAt, partials: partials.map((event) => event.text), final: final.text, eventTypes: events.map((event) => event.type) }, null, 2)}\n`)

function resample(input, inputRate, outputRate) { const output = new Float32Array(Math.floor(input.length * outputRate / inputRate)); for (let index = 0; index < output.length; index += 1) { const position = index * inputRate / outputRate; const left = Math.floor(position); const ratio = position - left; output[index] = (input[left] ?? 0) * (1 - ratio) + (input[left + 1] ?? input[left] ?? 0) * ratio } return output }
function concatenate(chunks) { const output = new Float32Array(chunks.reduce((total, chunk) => total + chunk.length, 0)); let offset = 0; for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length } return output }
function detectSpeechOnset(samples, sampleRate) { for (let offset = 0; offset + 320 <= samples.length; offset += 320) { let energy = 0; for (let index = offset; index < offset + 320; index += 1) energy += samples[index] * samples[index]; if (Math.sqrt(energy / 320) > 0.008) return offset / sampleRate * 1000 } return 0 }
function detectStableSpeechOnset(samples, sampleRate) { let run = 0; for (let offset = 0; offset + 320 <= samples.length; offset += 320) { let energy = 0; for (let index = offset; index < offset + 320; index += 1) energy += samples[index] * samples[index]; run = Math.sqrt(energy / 320) >= 0.008 ? run + 1 : 0; if (run >= 3) return (offset - 640) / sampleRate * 1000 } return 0 }

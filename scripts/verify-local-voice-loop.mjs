import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'

const requireFromServer = createRequire(new URL('../packages/server/package.json', import.meta.url))
const sherpa = requireFromServer('sherpa-onnx-node')
const stateRoot = process.env.DSH_CYBER_DATA_DIR
  ?? (process.platform === 'win32' && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'DSH Cyber') : join(homedir(), '.dsh-cyber'))
const ttsRoot = join(stateRoot, 'tts', 'sherpa', 'kokoro-int8-multi-lang-v1_1')
const sttRoot = join(stateRoot, 'voice', 'stt', 'streaming-paraformer-bilingual-zh-en-int8')
const text = '帮我看一下昨天服务为什么挂了'

const tts = await sherpa.OfflineTts.createAsync({
  model: { kokoro: {
    model: join(ttsRoot, 'model.int8.onnx'), voices: join(ttsRoot, 'voices.bin'), tokens: join(ttsRoot, 'tokens.txt'),
    dataDir: join(ttsRoot, 'espeak-ng-data'), lexicon: `${join(ttsRoot, 'lexicon-us-en.txt')},${join(ttsRoot, 'lexicon-zh.txt')}`,
  }, debug: false, numThreads: 2, provider: 'cpu' }, maxNumSentences: 1,
})
const generated = await tts.generateAsync({
  text, enableExternalBuffer: true,
  generationConfig: new sherpa.GenerationConfig({ sid: 58, speed: 1, silenceScale: 0.2 }),
})
const samples = resample(generated.samples, generated.sampleRate, 16_000)
const recognizerStartedAt = performance.now()
const recognizer = new sherpa.OnlineRecognizer({
  featConfig: { sampleRate: 16_000, featureDim: 80 },
  modelConfig: {
    paraformer: { encoder: join(sttRoot, 'encoder.int8.onnx'), decoder: join(sttRoot, 'decoder.int8.onnx') },
    tokens: join(sttRoot, 'tokens.txt'), numThreads: 2, provider: 'cpu', debug: false,
  },
  enableEndpoint: true,
  rule1MinTrailingSilence: 2.4,
  rule2MinTrailingSilence: 0.65,
  rule3MinUtteranceLength: 20,
})
const modelLoadMs = performance.now() - recognizerStartedAt
const stream = recognizer.createStream()
const partials = []
let previous = ''
let firstPartialMs
const decodeStartedAt = performance.now()
for (let offset = 0; offset < samples.length; offset += 320) {
  stream.acceptWaveform({ sampleRate: 16_000, samples: samples.slice(offset, offset + 320) })
  while (recognizer.isReady(stream)) recognizer.decode(stream)
  const current = recognizer.getResult(stream).text.trim()
  if (current && current !== previous) {
    firstPartialMs ??= performance.now() - decodeStartedAt
    partials.push({ audioAtMs: offset / 16_000 * 1000, text: current })
    previous = current
  }
}
stream.acceptWaveform({ sampleRate: 16_000, samples: new Float32Array(16_000) })
stream.inputFinished()
while (recognizer.isReady(stream)) recognizer.decode(stream)
const finalText = recognizer.getResult(stream).text.trim()

const vad = new sherpa.Vad({
  sileroVad: {
    model: join(sttRoot, 'silero_vad.int8.onnx'), threshold: 0.42,
    minSilenceDuration: 0.65, minSpeechDuration: 0.05, windowSize: 512, maxSpeechDuration: 30,
  },
  sampleRate: 16_000, numThreads: 1, provider: 'cpu', debug: false,
}, 60)
let speechDetectedAtMs
const vadInput = concatenate([new Float32Array(3_200), samples, new Float32Array(16_000)])
for (let offset = 0; offset + 512 <= vadInput.length; offset += 512) {
  vad.acceptWaveform(vadInput.slice(offset, offset + 512))
  if (vad.isDetected() && speechDetectedAtMs === undefined) speechDetectedAtMs = offset / 16_000 * 1000
}
vad.flush()
const segments = []
while (!vad.isEmpty()) { const segment = vad.front(false); segments.push({ startMs: segment.start / 16_000 * 1000, durationMs: segment.samples.length / 16_000 * 1000 }); vad.pop() }

if (!finalText) throw new Error('Streaming Paraformer did not produce a final transcript')
if (partials.length === 0) throw new Error('Streaming Paraformer did not produce partial transcripts')
if (segments.length === 0) throw new Error('Silero VAD did not detect the synthesized utterance')
process.stdout.write(`${JSON.stringify({ input: text, modelLoadMs, firstPartialMs, finalMs: performance.now() - decodeStartedAt, partials, finalText, speechDetectedAtMs, vadSegments: segments }, null, 2)}\n`)

function resample(input, inputRate, outputRate) {
  const output = new Float32Array(Math.floor(input.length * outputRate / inputRate))
  for (let index = 0; index < output.length; index += 1) {
    const position = index * inputRate / outputRate
    const left = Math.floor(position)
    const ratio = position - left
    output[index] = (input[left] ?? 0) * (1 - ratio) + (input[left + 1] ?? input[left] ?? 0) * ratio
  }
  return output
}

function concatenate(chunks) {
  const output = new Float32Array(chunks.reduce((total, chunk) => total + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length }
  return output
}

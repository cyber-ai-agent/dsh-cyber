import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'

const requireFromServer = createRequire(new URL('../packages/server/package.json', import.meta.url))
const sherpa = requireFromServer('sherpa-onnx-node')
const stateRoot = process.env.DSH_CYBER_DATA_DIR
  ?? (process.platform === 'win32' && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'DSH Cyber') : join(homedir(), '.dsh-cyber'))
const root = join(stateRoot, 'tts', 'sherpa', 'kokoro-int8-multi-lang-v1_1')
const speakerId = Number(process.argv[2] ?? 58)
const tts = await sherpa.OfflineTts.createAsync({
  model: {
    kokoro: {
      model: join(root, 'model.int8.onnx'),
      voices: join(root, 'voices.bin'),
      tokens: join(root, 'tokens.txt'),
      dataDir: join(root, 'espeak-ng-data'),
      lexicon: `${join(root, 'lexicon-us-en.txt')},${join(root, 'lexicon-zh.txt')}`,
    },
    debug: false,
    numThreads: 2,
    provider: 'cpu',
  },
  maxNumSentences: 1,
})
const startedAt = Date.now()
const audio = await tts.generateAsync({
  text: '你好，我是陈明远。这是本地中文声音的试听。',
  enableExternalBuffer: true,
  generationConfig: new sherpa.GenerationConfig({ sid: speakerId, speed: 1, silenceScale: 0.2 }),
})
let peak = 0
let energy = 0
for (const sample of audio.samples) { peak = Math.max(peak, Math.abs(sample)); energy += sample * sample }
const duration = audio.samples.length / audio.sampleRate
const rms = Math.sqrt(energy / Math.max(1, audio.samples.length))
if (!Number.isFinite(peak) || peak < 0.0001 || rms < 0.00001) throw new Error(`本地语音输出无效：peak=${peak}, rms=${rms}`)
process.stdout.write(`${JSON.stringify({ speakerId, sampleRate: audio.sampleRate, samples: audio.samples.length, duration, peak, rms, elapsedMs: Date.now() - startedAt })}\n`)

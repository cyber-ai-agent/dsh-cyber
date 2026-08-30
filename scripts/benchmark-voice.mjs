import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'

const requireFromServer = createRequire(new URL('../packages/server/package.json', import.meta.url))
const sherpa = requireFromServer('sherpa-onnx-node')
const stateRoot = process.env.DSH_CYBER_DATA_DIR
  ?? (process.platform === 'win32' && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'DSH Cyber') : join(homedir(), '.dsh-cyber'))
const modelRoot = join(stateRoot, 'tts', 'sherpa', 'kokoro-int8-multi-lang-v1_1')
const samples = [
  { kind: 'zh-short', text: '你好，我先检查昨天的服务日志。' },
  { kind: 'zh-long', text: '从日志来看，凌晨两点的服务重启并不是正常发布，而是内存持续增长后触发了进程退出。我会继续核对监控曲线和错误堆栈。' },
  { kind: 'mixed', text: 'API 网关在 02:13 返回五百错误，health check 随后连续失败三次。' },
]

const loadStartedAt = performance.now()
const tts = await sherpa.OfflineTts.createAsync({
  model: {
    kokoro: {
      model: join(modelRoot, 'model.int8.onnx'),
      voices: join(modelRoot, 'voices.bin'),
      tokens: join(modelRoot, 'tokens.txt'),
      dataDir: join(modelRoot, 'espeak-ng-data'),
      lexicon: `${join(modelRoot, 'lexicon-us-en.txt')},${join(modelRoot, 'lexicon-zh.txt')}`,
    },
    debug: false,
    numThreads: 2,
    provider: 'cpu',
  },
  maxNumSentences: 1,
})
const coldStartMs = performance.now() - loadStartedAt
const results = []
for (const sample of samples) {
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const cpuStarted = process.cpuUsage()
    const startedAt = performance.now()
    let firstAudioMs
    const audio = await tts.generateAsync({
      text: sample.text,
      enableExternalBuffer: true,
      generationConfig: new sherpa.GenerationConfig({ sid: 58, speed: 1, silenceScale: 0.2 }),
      onProgress: ({ samples: chunk }) => {
        if (firstAudioMs === undefined && chunk.length > 0) firstAudioMs = performance.now() - startedAt
        return 1
      },
    })
    const elapsedMs = performance.now() - startedAt
    const cpu = process.cpuUsage(cpuStarted)
    const durationMs = audio.samples.length / audio.sampleRate * 1000
    results.push({
      kind: sample.kind,
      iteration,
      firstAudioMs: firstAudioMs ?? elapsedMs,
      elapsedMs,
      audioDurationMs: durationMs,
      realtimeFactor: elapsedMs / durationMs,
      cpuPercent: (cpu.user + cpu.system) / 1000 / elapsedMs * 100,
    })
  }
}

const firstAudio = results.map((item) => item.firstAudioMs)
const output = {
  provider: 'sherpa-onnx/kokoro-int8-multi-lang-v1_1',
  device: `${process.platform}-${process.arch}-cpu`,
  coldStartMs,
  firstAudioMs: { p50: percentile(firstAudio, 0.5), p95: percentile(firstAudio, 0.95) },
  realtimeFactor: { p50: percentile(results.map((item) => item.realtimeFactor), 0.5), p95: percentile(results.map((item) => item.realtimeFactor), 0.95) },
  cpuPercent: { p50: percentile(results.map((item) => item.cpuPercent), 0.5), p95: percentile(results.map((item) => item.cpuPercent), 0.95) },
  memoryMb: process.resourceUsage().maxRSS / 1024,
  results,
}
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)

function percentile(values, ratio) {
  const ordered = [...values].sort((left, right) => left - right)
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * ratio) - 1)]
}

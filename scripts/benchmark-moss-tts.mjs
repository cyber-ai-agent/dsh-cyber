import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { MossTtsProvider } from '../packages/server/lib/voice/tts/moss-tts-provider.js'

const execFileAsync = promisify(execFile)
const stateRoot = process.env.DSH_CYBER_DATA_DIR
  ?? (process.platform === 'win32' && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'DSH Cyber') : join(homedir(), '.dsh-cyber'))
const modelRoot = join(stateRoot, 'tts', 'sherpa', 'models', 'moss-tts-nano-100m-onnx')
const provider = new MossTtsProvider(modelRoot)
const samples = [
  { kind: 'zh-short', text: '你好，我先检查昨天的服务日志。' },
  { kind: 'zh-long', text: '从日志来看，凌晨两点的服务重启并不是正常发布，而是内存持续增长后触发了进程退出。' },
  { kind: 'mixed', text: 'API 网关在凌晨两点十三分返回错误，健康检查随后连续失败三次。' },
]

const coldStartedAt = performance.now()
await provider.prepare()
const coldStartMs = performance.now() - coldStartedAt
const results = []
for (const sample of samples) {
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const startedAt = performance.now()
    let firstAudioMs
    let durationMs = 0
    for await (const chunk of provider.synthesize({ requestId: crypto.randomUUID(), text: sample.text, voiceId: 'moss:Junhao', speed: 1 })) {
      firstAudioMs ??= performance.now() - startedAt
      durationMs += chunk.durationMs
    }
    const elapsedMs = performance.now() - startedAt
    results.push({ kind: sample.kind, iteration, firstAudioMs: firstAudioMs ?? elapsedMs, elapsedMs, audioDurationMs: durationMs, realtimeFactor: elapsedMs / durationMs })
  }
}
const memoryMb = await childMemoryMb(provider.processId)
const output = {
  provider: 'moss-tts-nano-100m-onnx', device: `${process.platform}-${process.arch}-cpu`, coldStartMs,
  firstAudioMs: distribution(results.map((item) => item.firstAudioMs)),
  realtimeFactor: distribution(results.map((item) => item.realtimeFactor)),
  memoryMb, blocksMainThread: false, results,
}
await provider.dispose()
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)

function distribution(values) { return { p50: percentile(values, 0.5), p95: percentile(values, 0.95) } }
function percentile(values, ratio) { const ordered = [...values].sort((a, b) => a - b); return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * ratio) - 1)] }
async function childMemoryMb(pid) {
  if (pid === undefined || process.platform !== 'win32') return undefined
  try {
    const { stdout } = await execFileAsync('wmic', ['process', 'where', `processid=${pid}`, 'get', 'WorkingSetSize', '/value'], { windowsHide: true })
    const bytes = Number(/WorkingSetSize=(\d+)/u.exec(stdout)?.[1])
    return Number.isFinite(bytes) ? bytes / 1024 / 1024 : undefined
  } catch { return undefined }
}

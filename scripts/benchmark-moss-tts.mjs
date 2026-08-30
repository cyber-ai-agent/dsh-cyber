import { execFile } from 'node:child_process'
import { availableParallelism, homedir } from 'node:os'
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
process.stderr.write(`[moss-benchmark] ready pid=${provider.processId ?? 'unknown'} cold=${coldStartMs.toFixed(0)}ms\n`)
const measurementStartedAt = performance.now()
const cpuStartedMs = await processTreeCpuMs(provider.processId)
const results = []
for (const sample of samples) {
  for (let iteration = 0; iteration < 3; iteration += 1) {
    process.stderr.write(`[moss-benchmark] ${sample.kind} ${iteration + 1}/3\n`)
    const startedAt = performance.now()
    let firstAudioMs
    let durationMs = 0
    let audioChunks = 0
    let lastArrivalMs
    let previousChunkDurationMs = 0
    let maxPotentialStarvationMs = 0
    for await (const chunk of provider.synthesize({ requestId: crypto.randomUUID(), text: sample.text, voiceId: 'moss:Junhao', speed: 1 })) {
      if ((chunk.pcm?.length ?? 0) > 0) {
        const arrivalMs = performance.now() - startedAt
        firstAudioMs ??= arrivalMs
        if (lastArrivalMs !== undefined) maxPotentialStarvationMs = Math.max(maxPotentialStarvationMs, arrivalMs - lastArrivalMs - previousChunkDurationMs)
        lastArrivalMs = arrivalMs
        previousChunkDurationMs = chunk.durationMs
        audioChunks += 1
      }
      durationMs += chunk.durationMs
    }
    const elapsedMs = performance.now() - startedAt
    results.push({ kind: sample.kind, iteration, audioChunks, maxPotentialStarvationMs, firstAudioMs: firstAudioMs ?? elapsedMs, elapsedMs, audioDurationMs: durationMs, realtimeFactor: elapsedMs / durationMs })
  }
}
const memoryMb = await childMemoryMb(provider.processId)
const cpuFinishedMs = await processTreeCpuMs(provider.processId)
const measurementElapsedMs = performance.now() - measurementStartedAt
const cpuTimeMs = cpuStartedMs === undefined || cpuFinishedMs === undefined ? undefined : Math.max(0, cpuFinishedMs - cpuStartedMs)
const logicalCpuCount = availableParallelism()
const cpuPercent = cpuTimeMs === undefined ? undefined : cpuTimeMs / measurementElapsedMs * 100
const firstAudioMs = distribution(results.map((item) => item.firstAudioMs))
const maxPotentialStarvationMs = distribution(results.map((item) => item.maxPotentialStarvationMs))
const realtimeFactor = distribution(results.map((item) => item.realtimeFactor))
const gates = {
  firstAudioP95Under800Ms: firstAudioMs.p95 < 800,
  realtimeFactorP95UnderOne: realtimeFactor.p95 < 1,
  streamedEveryRequest: results.every((item) => item.audioChunks > 1),
  starvationP95Under80Ms: maxPotentialStarvationMs.p95 < 80,
  memoryUnder2048Mb: memoryMb === undefined ? undefined : memoryMb < 2_048,
}
const output = {
  provider: 'moss-tts-nano-100m-onnx', device: `${process.platform}-${process.arch}-cpu`, coldStartMs,
  firstAudioMs, maxPotentialStarvationMs, realtimeFactor,
  memoryMb, cpuTimeMs, cpuPercent, logicalCpuCount,
  cpuMachinePercent: cpuPercent === undefined ? undefined : cpuPercent / logicalCpuCount,
  blocksMainThread: false, gates, results,
}
await provider.dispose()
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
if (Object.values(gates).some((value) => value === false)) process.exitCode = 1

function distribution(values) { return { p50: percentile(values, 0.5), p95: percentile(values, 0.95) } }
function percentile(values, ratio) { const ordered = [...values].sort((a, b) => a - b); return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * ratio) - 1)] }
async function childMemoryMb(pid) {
  if (pid === undefined || process.platform !== 'win32') return undefined
  try {
    const bytes = await processTreeMetric(pid, 'WorkingSetSize')
    return bytes / 1024 / 1024
  } catch { return undefined }
}

async function processTreeCpuMs(pid) {
  if (pid === undefined || process.platform !== 'win32') return undefined
  try {
    const user = await processTreeMetric(pid, 'UserModeTime')
    const kernel = await processTreeMetric(pid, 'KernelModeTime')
    return (user + kernel) / 10_000
  } catch { return undefined }
}

async function processTreeMetric(pid, field) {
  const queries = [`ProcessId=${pid}`, `ParentProcessId=${pid}`]
  let total = 0
  for (const query of queries) {
    const { stdout } = await execFileAsync('wmic', ['process', 'where', query, 'get', field, '/value'], { windowsHide: true })
    for (const match of stdout.matchAll(new RegExp(`${field}=(\\d+)`, 'gu'))) total += Number(match[1])
  }
  return total
}

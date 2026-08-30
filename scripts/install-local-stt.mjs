import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { EnvHttpProxyAgent, fetch as proxyAwareFetch } from 'undici'

const REPOSITORY = 'csukuangfj/sherpa-onnx-streaming-paraformer-bilingual-zh-en'
const REVISION = '8e40c43232a1c5c66c82111efc5820d3accca11b'
const MODEL_DIR = 'streaming-paraformer-bilingual-zh-en-int8'
const stateRoot = process.env.DSH_CYBER_DATA_DIR
  ?? (process.platform === 'win32' && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'DSH Cyber') : join(homedir(), '.dsh-cyber'))
const root = join(stateRoot, 'voice', 'stt')
const modelRoot = join(root, MODEL_DIR)
const dispatcher = new EnvHttpProxyAgent()
const files = [
  { path: 'encoder.int8.onnx', size: 165_462_184, sha256: '81a70226a8934e6ed92aa1d4fc486b428b5398e2f2619ed4897b7294cab90e9a', url: `https://huggingface.co/${REPOSITORY}/resolve/${REVISION}/encoder.int8.onnx` },
  { path: 'decoder.int8.onnx', size: 71_664_561, sha256: 'f3cca9f77bb9d93c8fcbfb63ae617b6b1ee96818df3aa3b151c40658fe38594f', url: `https://huggingface.co/${REPOSITORY}/resolve/${REVISION}/decoder.int8.onnx` },
  { path: 'tokens.txt', size: 75_756, sha256: '59aba8873a2ed1e122c25fee421e25f283b63290efbde85c1f01a853d83cb6e6', url: `https://huggingface.co/${REPOSITORY}/resolve/${REVISION}/tokens.txt` },
  { path: 'silero_vad.int8.onnx', size: 212_860, sha256: 'c36d490aff5ab924ca6c7aeec4d8f6bd3d22db6fa17611b9c5b17eae58ac3a20', url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.int8.onnx' },
]

await mkdir(modelRoot, { recursive: true })
const manifestFiles = []
for (const [index, file] of files.entries()) {
  const destination = join(modelRoot, file.path)
  if (!await valid(destination, file)) {
    await mkdir(dirname(destination), { recursive: true })
    const temporary = `${destination}.partial`
    await unlink(temporary).catch(() => undefined)
    process.stdout.write(`[${index + 1}/${files.length}] 下载 ${file.path} (${formatBytes(file.size)})\n`)
    const response = await fetchWithRetry(file.url)
    if (!response.ok || response.body === null) throw new Error(`下载失败 ${file.path}: HTTP ${response.status}`)
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { flags: 'wx', mode: 0o600 }))
    if (!await valid(temporary, file)) throw new Error(`文件校验失败：${file.path}`)
    await rename(temporary, destination)
  } else process.stdout.write(`[${index + 1}/${files.length}] 已存在 ${file.path}\n`)
  manifestFiles.push({ path: file.path, size: file.size, sha256: await sha256(destination) })
}
const manifest = {
  schemaVersion: 1,
  engine: 'sherpa-onnx',
  runtimeVersion: '1.13.6',
  modelId: MODEL_DIR,
  repository: REPOSITORY,
  revision: REVISION,
  sampleRate: 16_000,
  frameDurationMs: 20,
  files: manifestFiles,
  installedAt: new Date().toISOString(),
}
await writeFile(join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
process.stdout.write(`本地流式中文识别包安装完成：${modelRoot}\n${manifestFiles.map((file) => `${file.path}: ${file.sha256}`).join('\n')}\n`)

async function valid(path, file) {
  try {
    if ((await stat(path)).size !== file.size) return false
    return file.sha256 === '' || await sha256(path) === file.sha256
  } catch { return false }
}

async function sha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function formatBytes(value) { return value > 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MiB` : `${(value / 1024).toFixed(1)} KiB` }

async function fetchWithRetry(url) {
  let lastError
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await proxyAwareFetch(url, { redirect: 'follow', signal: AbortSignal.timeout(180_000), dispatcher })
      if (response.ok) return response
      lastError = new Error(`HTTP ${response.status}`)
    } catch (error) { lastError = error }
    if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, attempt * 1_500))
  }
  throw lastError
}

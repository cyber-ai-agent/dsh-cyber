import { createReadStream, createWriteStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { EnvHttpProxyAgent, fetch as proxyAwareFetch } from 'undici'

import { ServiceError } from './service-error.js'
import { SherpaKokoroTtsProvider } from '../voice/tts/sherpa-kokoro-tts-provider.js'
import { MossTtsProvider } from '../voice/tts/moss-tts-provider.js'
import type { AudioChunk, VoiceModelDescriptor, VoiceModelVoice } from '@dsh-cyber/contracts'

interface SherpaManifest {
  schemaVersion: 2
  engine: 'sherpa-onnx'
  runtimeVersion: string
  modelDir: 'kokoro-int8-multi-lang-v1_1'
  voiceCount: 103
  files: Array<{ path: string; size: number; sha256: string }>
}

export interface LocalTtsAudio {
  wav: Buffer
  duration: number
  sampleRate: number
  peak: number
}

const MODEL_DIR = 'kokoro-int8-multi-lang-v1_1'
const voiceDownloadDispatcher = new EnvHttpProxyAgent()
const MOSS_MODEL_ID = 'moss-tts-nano-100m-onnx'
const MOSS_DEFAULT_VOICE: VoiceModelVoice = { id: 'moss:Junhao', label: '君豪 · 自然男声', gender: 'male' }
const MOSS_TTS_REVISION = 'f52645cb467506d8e18e746ddd59482685b74e58'
const MOSS_CODEC_REVISION = 'ceff0d0749bfb3fa2d61149794ec6feef0d1e1ae'

type ModelInstallOperation = {
  state: 'downloading' | 'verifying' | 'error'
  completedBytes: number
  totalBytes: number
  phase: 'downloading' | 'verifying' | 'installing'
  controller: AbortController
  error?: string
}

type ModelPackFile = {
  directory: 'tts' | 'codec' | 'runtime'
  source?: 'huggingface' | 'github'
  repository: string
  revision: string
  path: string
  size: number
  checksum: { algorithm: 'sha256' | 'git-sha1'; value: string }
}

const MOSS_FILES: readonly ModelPackFile[] = [
  mossFile('tts', 'moss_tts_decode_step.onnx', 291_483, 'sha256', '698cbc2fc1c2feca16e5895614ed52bbb32ded10f236c076f477b2e69abf32d8'),
  mossFile('tts', 'moss_tts_global_shared.data', 440_813_568, 'sha256', 'bce8312c3df6a44545302cae229b61054fe0672e0b252ba59cba47adeed831dc'),
  mossFile('tts', 'moss_tts_local_cached_step.onnx', 53_685, 'sha256', 'aa9035fefc1c138a951a8bcfc0374fb03a25f1ece67f7f7f53bce349b84a1dd5'),
  mossFile('tts', 'moss_tts_local_decoder.onnx', 49_231, 'sha256', '51aa754301b38550a5f9adda0ad93bd3dc95819afb511e6dcabf4a90b345a454'),
  mossFile('tts', 'moss_tts_local_fixed_sampled_frame.onnx', 471_262, 'sha256', '40cdb00efc171c450cf91468e01429caa41b0252222cd308e978f58fe354afa8'),
  mossFile('tts', 'moss_tts_local_shared.data', 229_678_080, 'sha256', 'bae7782032c0fb12490ab42afe009f87ae6c75a0f0596fc7b5c08e4d5ee93916'),
  mossFile('tts', 'moss_tts_prefill.onnx', 283_305, 'sha256', 'd56126dcd0574c2f15d98fc6b35eda68d0386b5bd9c5e38e28548d6f2ea8f3db'),
  mossFile('tts', 'tokenizer.model', 470_897, 'sha256', 'c353ee1479b536bf414c1b247f5542b6607fb8ae91320e5af1781fee200fddff'),
  mossFile('tts', 'browser_poc_manifest.json', 503_354, 'git-sha1', '8a04b980c3b9ea2f56747650ea255efe421ada38'),
  mossFile('tts', 'tts_browser_onnx_meta.json', 4_487, 'git-sha1', '883597607ce139b2c4871468396af2c088ed2fe0'),
  mossFile('codec', 'moss_audio_tokenizer_decode_full.onnx', 681_902, 'sha256', '0fbbafe3fd4afa2a019af5c5ced204af6e2d1db044fa40f021525d2aee95b4ac'),
  mossFile('codec', 'moss_audio_tokenizer_decode_shared.data', 44_198_912, 'sha256', 'e69d52e0f4e84ca27850557ee54face46632d3a5a16c89bd246c7c408466dcad'),
  mossFile('codec', 'moss_audio_tokenizer_decode_step.onnx', 351_400, 'sha256', '9527c86a29e1837edec1f74db57d5eeaadb3a715af3382703566460afed25855'),
  mossFile('codec', 'moss_audio_tokenizer_encode.data', 44_507_136, 'sha256', 'aa751265b2bab2887eac224484546b194875aa7494b607115439b3dc6b228a2c'),
  mossFile('codec', 'moss_audio_tokenizer_encode.onnx', 815_775, 'sha256', 'eadea4a645abdcf98714c7aead122ee2ce7da6e080f9f80b977cd1ca8e19473a'),
  mossFile('codec', 'codec_browser_onnx_meta.json', 17_036, 'git-sha1', '886953a56489516b847b7c1c953bde063eb78faa'),
  mossRuntimeFile('ort_cpu_runtime.py', 40_665, '0b9e5d2c95b0e20d7044123b2e4515f1a76f96a6'),
  mossRuntimeFile('onnx_tts_runtime.py', 29_099, 'c6b1d70cbcaa52cf51de138612ac2d0c6bec3435'),
]
const MOSS_DOWNLOAD_BYTES = MOSS_FILES.reduce((total, file) => total + file.size, 0)

export class LocalTtsAssetService {
  readonly #root: string
  readonly #modelRoot: string
  readonly #manifestPath: string
  readonly #provider: SherpaKokoroTtsProvider
  #mossProvider: MossTtsProvider | undefined
  #generationTail: Promise<void> = Promise.resolve()
  #modelOperations = new Map<string, ModelInstallOperation>()

  constructor(stateRoot: string) {
    this.#root = join(stateRoot, 'tts', 'sherpa')
    this.#modelRoot = join(this.#root, MODEL_DIR)
    this.#manifestPath = join(this.#root, 'manifest.json')
    this.#provider = new SherpaKokoroTtsProvider(this.#modelRoot)
  }

  async status(): Promise<{ installed: boolean; engine: 'sherpa-onnx'; voiceCount: number; runtimeVersion?: string; modelId?: string; byteLength?: number }> {
    try {
      const manifest = await this.#readManifest()
      let byteLength = 0
      for (const file of manifest.files) {
        const metadata = await stat(join(this.#modelRoot, file.path))
        if (!metadata.isFile() || metadata.size !== file.size) return { installed: false, engine: 'sherpa-onnx', voiceCount: 0 }
        byteLength += metadata.size
      }
      return { installed: true, engine: 'sherpa-onnx', voiceCount: 100, runtimeVersion: manifest.runtimeVersion, modelId: MODEL_DIR, byteLength }
    } catch {
      return { installed: false, engine: 'sherpa-onnx', voiceCount: 0 }
    }
  }

  async models(): Promise<VoiceModelDescriptor[]> {
    const kokoro = await this.status()
    const mossRoot = join(this.#root, 'models', MOSS_MODEL_ID)
    const mossInstalled = await fileExists(join(mossRoot, 'manifest.json'))
    const mossOperation = this.#modelOperations.get(MOSS_MODEL_ID)
    const mossState = mossOperation?.state ?? (mossInstalled ? 'installed' : 'not-installed')
    const mossVoices = mossInstalled ? await this.#readMossVoices(mossRoot) : []
    return [
      {
        id: 'moss-tts-nano-100m-onnx', provider: 'moss', displayName: 'MOSS-TTS-Nano', version: '100M-ONNX',
        license: 'Apache-2.0', byteLength: MOSS_DOWNLOAD_BYTES, state: mossInstalled && mossState === 'installed' ? 'ready' : mossState,
        tier: 'default', recommended: true, runtime: 'onnx-cpu', languages: ['zh-CN', 'en-US'],
        summary: '默认自然语音包。中文自然度更高，首次使用时按需安装。',
        requirements: ['约 1 GB 磁盘空间', '运行约占 1.7 GB 内存', '建议 4 GB 可用内存'],
        ...(mossInstalled ? { installedPath: mossRoot } : {}),
        // Whatever the installed pack actually ships. The settings panel used
        // to offer exactly one hardcoded name, so a multi-speaker model looked
        // like a single-voice one.
        ...(mossVoices.length === 0 ? {} : { voices: mossVoices }),
        ...(mossOperation === undefined ? {} : {
          progress: { phase: mossOperation.phase, completedBytes: mossOperation.completedBytes, totalBytes: mossOperation.totalBytes },
          ...(mossOperation.error === undefined ? {} : { error: mossOperation.error }),
        }),
      },
      {
        id: 'kokoro-int8-multi-lang-v1_1', provider: 'kokoro', displayName: 'Kokoro 快速语音', version: '1.1-int8',
        license: 'Apache-2.0', byteLength: kokoro.byteLength ?? 147_031_220, state: kokoro.installed ? 'ready' : 'not-installed',
        tier: 'fast', runtime: 'onnx-cpu', languages: ['zh-CN', 'en-US'],
        summary: '低资源快速降级包。启动快、音色多，但中文韵律较机械。',
        ...(kokoro.modelId === undefined ? {} : { installedPath: this.#modelRoot }),
      },
      {
        id: 'qwen3-tts-12hz-0.6b', provider: 'qwen-tts', displayName: 'Qwen3-TTS 0.6B', version: '12Hz-0.6B',
        license: 'Apache-2.0', byteLength: 0, state: 'unavailable', tier: 'advanced', runtime: 'python-cuda',
        languages: ['zh-CN', 'en-US'], summary: '高级可控语音。适合声音设计与克隆；真正流式运行时仍在适配。',
        requirements: ['建议 NVIDIA GPU', '独立高级运行环境'],
      },
      {
        id: 'dots-tts-soar-2b', provider: 'dots-tts', displayName: 'dots.tts SOAR 2B', version: 'SOAR-2B',
        license: 'Apache-2.0', byteLength: 0, state: 'unavailable', tier: 'advanced', runtime: 'python-cuda',
        languages: ['zh-CN', 'en-US'], summary: '高级克隆语音。参考声音相似度高，但模型重且不支持语速控制。',
        requirements: ['高显存 GPU', '必须提供授权参考音频'],
      },
      {
        id: 'fun-cosyvoice3-0.5b', provider: 'cosyvoice', displayName: 'CosyVoice3 0.5B', version: '0.5B-2512',
        license: 'Apache-2.0', byteLength: 0, state: 'unavailable', tier: 'advanced', runtime: 'python-cuda',
        languages: ['zh-CN', 'en-US'], summary: '高级自然语音。支持情绪、方言和双向流式，运行环境较重。',
        requirements: ['建议 NVIDIA GPU', '独立高级运行环境'],
      },
      {
        id: 'system-tts', provider: 'system', displayName: '系统语音', version: 'system', license: 'OS', byteLength: 0,
        state: 'ready', tier: 'fast', runtime: 'system', languages: ['zh-CN'], summary: '零下载备用方案，只使用系统已经安装的中文声音。',
      },
    ]
  }

  async installModel(modelId: string): Promise<VoiceModelDescriptor> {
    // Every refusal used to say the same thing, including for Kokoro — which
    // is installable, just from the command line. Telling a user that a pack
    // "尚未提供本机安装包" when the real answer is one command is worse than
    // saying nothing.
    if (modelId === MODEL_DIR) {
      throw new ServiceError(
        'invalid',
        'voice_model_cli_install',
        'Kokoro 语音包目前通过命令行安装：在项目目录运行 pnpm tts:install，完成后回到这里刷新。',
      )
    }
    if (modelId !== MOSS_MODEL_ID) {
      throw new ServiceError(
        'invalid',
        'voice_model_not_installable',
        '这个引擎需要独立的高级运行环境，当前版本还不能在本机安装。',
      )
    }
    const existing = this.#modelOperations.get(modelId)
    if (existing === undefined || existing.state === 'error') {
      const operation: ModelInstallOperation = {
        state: 'downloading', phase: 'downloading', completedBytes: 0, totalBytes: MOSS_DOWNLOAD_BYTES, controller: new AbortController(),
      }
      this.#modelOperations.set(modelId, operation)
      void this.#installMoss(operation).catch((cause: unknown) => {
        operation.state = 'error'
        operation.error = cause instanceof Error && cause.name === 'AbortError' ? '下载已取消' : cause instanceof Error ? cause.message : '语音模型安装失败'
      })
    }
    return (await this.models()).find((model) => model.id === modelId)!
  }

  async cancelModelInstall(modelId: string): Promise<void> {
    const operation = this.#modelOperations.get(modelId)
    if (operation === undefined || operation.state === 'error') return
    operation.controller.abort()
  }

  async removeModel(modelId: string): Promise<void> {
    if (modelId !== MOSS_MODEL_ID) throw new ServiceError('invalid', 'voice_model_not_removable', '该语音模型不能在这里删除')
    this.#modelOperations.get(modelId)?.controller.abort()
    this.#modelOperations.delete(modelId)
    await this.#mossProvider?.dispose()
    this.#mossProvider = undefined
    await rm(join(this.#root, 'models', modelId), { recursive: true, force: true })
    await rm(join(this.#root, 'models', '.downloads', modelId), { recursive: true, force: true })
  }

  async synthesize(input: { text: string; speakerId: number; speed: number; signal?: AbortSignal }): Promise<LocalTtsAudio> {
    const chunks: Float32Array[] = []
    let sampleRate = 24_000
    for await (const chunk of this.stream(input)) {
      if (chunk.pcm !== undefined) chunks.push(chunk.pcm)
      sampleRate = chunk.sampleRate
    }
    const samples = concatenate(chunks)
    let peak = 0
    let energy = 0
    for (const sample of samples) { peak = Math.max(peak, Math.abs(sample)); energy += sample * sample }
    const rms = Math.sqrt(energy / Math.max(1, samples.length))
    if (!Number.isFinite(peak) || peak < 0.0001 || rms < 0.00001) throw new ServiceError('conflict', 'local_tts_silent_output', '本地语音生成了静音，请重新安装语音包')
    return { wav: pcm16Wav(samples, sampleRate, peak), duration: samples.length / sampleRate, sampleRate, peak }
  }

  async *stream(input: { text: string; speakerId: number; speed: number; provider?: 'kokoro' | 'moss'; voiceId?: string; signal?: AbortSignal }): AsyncIterable<AudioChunk> {
    const text = normalizeTtsText(input.text)
    if (text.length === 0 || text.length > 1_000) throw new ServiceError('invalid', 'local_tts_text_invalid', '播报内容长度必须在 1 到 1000 个字符之间')
    if (!Number.isInteger(input.speakerId) || input.speakerId < 3 || input.speakerId > 102) throw new ServiceError('invalid', 'local_tts_voice_invalid', '请选择有效的中文声音')
    // The ceiling was 1.3 in four independent places. Raising the slider alone
    // would have turned "too slow" into a rejected request.
    if (!Number.isFinite(input.speed) || input.speed < 0.7 || input.speed > 2) throw new ServiceError('invalid', 'local_tts_speed_invalid', '语速必须在 0.7 到 2 之间')

    let release!: () => void
    const previous = this.#generationTail
    this.#generationTail = new Promise<void>((resolve) => { release = resolve })
    await previous
    try {
      // Ask about the pack the caller actually chose. Gating every request on
      // the Kokoro install meant a user who installed only MOSS from the
      // settings panel had a working pack the server refused to use, and was
      // then told to install a different one they had never asked for.
      if (input.provider === 'moss') {
        if (!(await fileExists(join(this.#root, 'models', MOSS_MODEL_ID, 'manifest.json')))) {
          throw new ServiceError('not-found', 'local_tts_not_installed', '自然语音包未安装，请在语音设置中下载 MOSS-TTS-Nano')
        }
      } else if ((await this.status()).installed !== true) {
        throw new ServiceError('not-found', 'local_tts_not_installed', '本地中文语音包未安装，请运行 pnpm tts:install')
      }
      const provider = input.provider === 'moss'
        ? (this.#mossProvider ??= new MossTtsProvider(join(this.#root, 'models', MOSS_MODEL_ID)))
        : this.#provider
      for await (const chunk of provider.synthesize({
        requestId: crypto.randomUUID(), text, voiceId: input.provider === 'moss' ? input.voiceId ?? 'moss:Junhao' : String(input.speakerId), speed: input.speed,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      })) {
        yield chunk
      }
    } finally {
      release()
    }
  }

  async #readManifest(): Promise<SherpaManifest> {
    let value: unknown
    try { value = JSON.parse(await readFile(this.#manifestPath, 'utf8')) } catch { throw new ServiceError('not-found', 'local_tts_not_installed', '本地中文语音包未安装') }
    if (!isManifest(value)) throw new ServiceError('conflict', 'local_tts_manifest_invalid', '本地中文语音包清单无效')
    return value
  }

  async #installMoss(operation: ModelInstallOperation): Promise<void> {
    const modelsRoot = join(this.#root, 'models')
    const target = join(modelsRoot, MOSS_MODEL_ID)
    const staging = join(modelsRoot, `.install-${MOSS_MODEL_ID}-${process.pid}`)
    await rm(staging, { recursive: true, force: true })
    await mkdir(staging, { recursive: true })
    try {
      for (const file of MOSS_FILES) {
        if (operation.controller.signal.aborted) throw abortError()
        const directory = join(staging, modelPackDirectory(file.directory))
        const cacheDirectory = join(modelsRoot, '.downloads', MOSS_MODEL_ID, modelPackDirectory(file.directory))
        await mkdir(directory, { recursive: true })
        await mkdir(cacheDirectory, { recursive: true })
        await materializePinnedFile(file, join(cacheDirectory, file.path), join(directory, file.path), operation)
      }
      operation.state = 'verifying'
      operation.phase = 'installing'
      await installMossPythonRuntime(staging, operation.controller.signal)
      await writeFile(join(staging, 'manifest.json'), `${JSON.stringify({
        schemaVersion: 1, id: MOSS_MODEL_ID, provider: 'moss', version: '100M-ONNX', installedAt: new Date().toISOString(),
        files: MOSS_FILES.map((file) => ({ directory: file.directory, path: file.path, size: file.size, checksum: file.checksum })),
      }, null, 2)}\n`, 'utf8')
      await rm(target, { recursive: true, force: true })
      await rename(staging, target)
      this.#modelOperations.delete(MOSS_MODEL_ID)
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  }

  /**
   * The speakers an installed MOSS pack offers.
   *
   * Read from the pack's own manifest rather than from a list in the UI: a
   * newer pack with more speakers should simply show more of them, and a pack
   * that names its speakers should show those names. The settings panel used
   * to hardcode exactly one, so a multi-speaker model looked like a
   * single-voice one.
   */
  async #readMossVoices(root: string): Promise<VoiceModelVoice[]> {
    try {
      const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as {
        voices?: Array<string | { id?: unknown; label?: unknown; name?: unknown; gender?: unknown }>
      }
      const raw = Array.isArray(manifest.voices) ? manifest.voices : []
      const voices = raw.flatMap((entry): VoiceModelVoice[] => {
        if (typeof entry === 'string') return entry.trim() === '' ? [] : [{ id: `moss:${entry}`, label: entry }]
        const id = typeof entry.id === 'string' ? entry.id : undefined
        if (id === undefined || id.trim() === '') return []
        const label = typeof entry.label === 'string' ? entry.label : typeof entry.name === 'string' ? entry.name : id
        const gender = entry.gender === 'female' || entry.gender === 'male' ? entry.gender : undefined
        return [{ id: `moss:${id}`, label, ...(gender === undefined ? {} : { gender }) }]
      })
      // A pack that names no speakers still has one; without this an installed,
      // working engine would offer nothing at all.
      return voices.length > 0 ? voices : [MOSS_DEFAULT_VOICE]
    } catch {
      return [MOSS_DEFAULT_VOICE]
    }
  }

}

async function fileExists(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile() } catch { return false }
}

function mossFile(
  directory: 'tts' | 'codec',
  path: string,
  size: number,
  algorithm: 'sha256' | 'git-sha1',
  value: string,
): ModelPackFile {
  return {
    directory,
    repository: directory === 'tts' ? 'OpenMOSS-Team/MOSS-TTS-Nano-100M-ONNX' : 'OpenMOSS-Team/MOSS-Audio-Tokenizer-Nano-ONNX',
    revision: directory === 'tts' ? MOSS_TTS_REVISION : MOSS_CODEC_REVISION,
    path,
    size,
    checksum: { algorithm, value },
  }
}

function mossRuntimeFile(path: string, size: number, gitSha1: string): ModelPackFile {
  return {
    directory: 'runtime', source: 'github', repository: 'OpenMOSS/MOSS-TTS-Nano', revision: '7f75b9eb8818f929560459ce8669909dece85975',
    path, size, checksum: { algorithm: 'git-sha1', value: gitSha1 },
  }
}

function modelPackDirectory(directory: ModelPackFile['directory']): string {
  if (directory === 'tts') return 'MOSS-TTS-Nano-100M-ONNX'
  if (directory === 'codec') return 'MOSS-Audio-Tokenizer-Nano-ONNX'
  return 'runtime'
}

async function materializePinnedFile(file: ModelPackFile, cachePath: string, destination: string, operation: ModelInstallOperation): Promise<void> {
  if (await hasValidCachedFile(file, cachePath)) {
    operation.completedBytes += file.size
    await copyFile(cachePath, destination)
    return
  }
  const partialPath = `${cachePath}.partial`
  await rm(partialPath, { force: true })
  const url = file.source === 'github'
    ? `https://raw.githubusercontent.com/${file.repository}/${file.revision}/${encodeURIComponent(file.path)}`
    : `https://huggingface.co/${file.repository}/resolve/${file.revision}/${encodeURIComponent(file.path)}`
  const response = await proxyAwareFetch(url, { redirect: 'follow', signal: operation.controller.signal, dispatcher: voiceDownloadDispatcher })
  if (!response.ok || response.body === null) throw new Error(`下载 ${file.path} 失败：HTTP ${response.status}`)
  const declared = Number(response.headers.get('content-length'))
  if (file.checksum.algorithm === 'sha256' && Number.isFinite(declared) && declared !== file.size) throw new Error(`${file.path} 下载大小与固定清单不一致`)
  let received = 0
  const progress = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length
      operation.completedBytes += chunk.length
      callback(null, chunk)
    },
  })
  await pipeline(Readable.fromWeb(response.body), progress, createWriteStream(partialPath, { flags: 'wx', mode: 0o600 }))
  if (received !== file.size) throw new Error(`${file.path} 下载不完整`)
  operation.state = 'verifying'
  operation.phase = 'verifying'
  const checksum = await fileChecksum(partialPath, file.checksum.algorithm, file.size)
  if (checksum !== file.checksum.value) throw new Error(`${file.path} 完整性校验失败`)
  await rm(cachePath, { force: true })
  await rename(partialPath, cachePath)
  await copyFile(cachePath, destination)
  operation.state = 'downloading'
  operation.phase = 'downloading'
}

async function hasValidCachedFile(file: ModelPackFile, path: string): Promise<boolean> {
  try {
    if ((await stat(path)).size !== file.size) return false
    return await fileChecksum(path, file.checksum.algorithm, file.size) === file.checksum.value
  } catch { return false }
}

async function fileChecksum(path: string, algorithm: 'sha256' | 'git-sha1', size: number): Promise<string> {
  const hash = createHash(algorithm === 'sha256' ? 'sha256' : 'sha1')
  if (algorithm === 'git-sha1') hash.update(`blob ${size}\0`)
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function abortError(): Error {
  const error = new Error('下载已取消')
  error.name = 'AbortError'
  return error
}

/**
 * An interpreter that exists on this machine.
 *
 * The install used the bare name `python`, which macOS has not shipped since
 * 12.3 — so the final step of a one-gigabyte download failed with a spawn
 * error and the pack was never written. On Windows the opposite is true:
 * `python3` is a Store stub that opens the app store instead of running.
 */
async function resolvePython(signal: AbortSignal): Promise<string> {
  const configured = process.env.DSH_CYBER_PYTHON?.trim()
  const candidates = configured !== undefined && configured !== ''
    ? [configured]
    : process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python']
  for (const candidate of candidates) {
    try {
      await runProcess(candidate, ['--version'], signal)
      return candidate
    } catch {
      // Try the next name.
    }
  }
  throw new ServiceError(
    'not-found',
    'local_tts_python_missing',
    `未找到可用的 Python（已尝试 ${candidates.join('、')}）。请安装 Python 3，或用 DSH_CYBER_PYTHON 指定解释器路径。`,
  )
}

async function installMossPythonRuntime(root: string, signal: AbortSignal): Promise<void> {
  const venvRoot = join(root, 'runtime', '.venv')
  const python = await resolvePython(signal)
  await runProcess(python, ['-m', 'venv', venvRoot], signal)
  const runtimePython = process.platform === 'win32' ? join(venvRoot, 'Scripts', 'python.exe') : join(venvRoot, 'bin', 'python')
  await runProcess(runtimePython, [
    '-m', 'pip', 'install', '--disable-pip-version-check', '--no-input',
    'numpy==2.2.1', 'onnxruntime==1.23.2', 'sentencepiece==0.2.1',
  ], signal)
}

function runProcess(command: string, args: string[], signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(abortError()); return }
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-4_000) })
    const abort = () => child.kill()
    signal.addEventListener('abort', abort, { once: true })
    child.once('error', (error) => { signal.removeEventListener('abort', abort); reject(error) })
    child.once('exit', (code) => {
      signal.removeEventListener('abort', abort)
      if (signal.aborted) reject(abortError())
      else if (code === 0) resolve()
      else reject(new Error(`语音运行时安装失败（exit ${code ?? 'unknown'}）：${stderr.trim() || '没有错误输出'}`))
    })
  })
}

export function normalizeTtsText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[\u{1F000}-\u{1FAFF}\u2600-\u27BF\uFE0F]/gu, ' ')
    .replace(/\p{C}/gu, ' ')
    .replace(/\s+/gu, ' ')
    .replace(/\s+([。！？!?；;，,、])/gu, '$1')
    .trim()
}

function concatenate(chunks: Float32Array[]): Float32Array {
  const output = new Float32Array(chunks.reduce((total, chunk) => total + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length }
  return output
}

function isManifest(value: unknown): value is SherpaManifest {
  if (value === null || typeof value !== 'object') return false
  const item = value as Partial<SherpaManifest>
  return item.schemaVersion === 2 && item.engine === 'sherpa-onnx' && item.runtimeVersion === '1.13.6'
    && item.modelDir === MODEL_DIR && item.voiceCount === 103 && Array.isArray(item.files)
    && item.files.every((file) => file !== null && typeof file === 'object' && typeof file.path === 'string' && !file.path.split('/').includes('..')
      && Number.isSafeInteger(file.size) && file.size >= 0 && typeof file.sha256 === 'string' && /^[a-f0-9]{64}$/.test(file.sha256))
}

function pcm16Wav(samples: Float32Array, sampleRate: number, peak: number): Buffer {
  const output = Buffer.allocUnsafe(44 + samples.length * 2)
  output.write('RIFF', 0); output.writeUInt32LE(36 + samples.length * 2, 4); output.write('WAVE', 8)
  output.write('fmt ', 12); output.writeUInt32LE(16, 16); output.writeUInt16LE(1, 20); output.writeUInt16LE(1, 22)
  output.writeUInt32LE(sampleRate, 24); output.writeUInt32LE(sampleRate * 2, 28); output.writeUInt16LE(2, 32); output.writeUInt16LE(16, 34)
  output.write('data', 36); output.writeUInt32LE(samples.length * 2, 40)
  const gain = Math.min(3, 0.9 / peak)
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]! * gain))
    output.writeInt16LE(Math.round(sample * (sample < 0 ? 32768 : 32767)), 44 + index * 2)
  }
  return output
}

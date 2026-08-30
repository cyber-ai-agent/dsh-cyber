import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import tar from 'tar-stream'
import unbzip2 from 'unbzip2-stream'

const MODEL_DIR = 'kokoro-int8-multi-lang-v1_1'
const ARCHIVE_NAME = `${MODEL_DIR}.tar.bz2`
const ARCHIVE_URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/${ARCHIVE_NAME}`
const ARCHIVE_SIZE = 147_031_220
const ARCHIVE_SHA256 = 'a1e94694776049035c4f2c6529f003aaece993c76aae9a78995831c3c4dcafc6'
const stateRoot = process.env.DSH_CYBER_DATA_DIR
  ?? (process.platform === 'win32' && process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, 'DSH Cyber')
    : join(homedir(), '.dsh-cyber'))
const voiceRoot = join(stateRoot, 'tts', 'sherpa')
const modelRoot = join(voiceRoot, MODEL_DIR)
const manifestPath = join(voiceRoot, 'manifest.json')
const requiredFiles = [
  'model.int8.onnx', 'voices.bin', 'tokens.txt', 'lexicon-zh.txt', 'lexicon-us-en.txt',
  'phone-zh.fst', 'date-zh.fst', 'number-zh.fst', 'espeak-ng-data', 'dict',
]

await mkdir(voiceRoot, { recursive: true })
if (await validInstall(modelRoot)) {
  process.stdout.write(`本地中文语音包已安装：${modelRoot}\n`)
  process.exit(0)
}

const archivePath = join(voiceRoot, `${ARCHIVE_NAME}.partial`)
await unlink(archivePath).catch(() => undefined)
process.stdout.write(`下载 sherpa-onnx Kokoro 中文语音包 (${formatBytes(ARCHIVE_SIZE)})\n`)
const response = await fetch(ARCHIVE_URL, { redirect: 'follow' })
if (!response.ok || response.body === null) throw new Error(`语音包下载失败：HTTP ${response.status}`)
await pipeline(Readable.fromWeb(response.body), createWriteStream(archivePath, { flags: 'wx', mode: 0o600 }))
const archiveMetadata = await stat(archivePath)
if (archiveMetadata.size !== ARCHIVE_SIZE) throw new Error(`语音包大小校验失败：${archiveMetadata.size}`)
const archiveSha256 = await fileSha256(archivePath)
if (ARCHIVE_SHA256 !== '' && archiveSha256 !== ARCHIVE_SHA256) throw new Error('语音包 SHA-256 校验失败')

const stagingRoot = join(voiceRoot, `.install-${process.pid}`)
assertManagedPath(stagingRoot)
await rm(stagingRoot, { recursive: true, force: true })
await mkdir(stagingRoot, { recursive: true })
try {
  await extractArchive(archivePath, stagingRoot)
  const stagedModel = join(stagingRoot, MODEL_DIR)
  if (!await validInstall(stagedModel)) throw new Error('解压后的本地语音包不完整')
  assertManagedPath(modelRoot)
  await rm(modelRoot, { recursive: true, force: true })
  await rename(stagedModel, modelRoot)
} finally {
  await rm(stagingRoot, { recursive: true, force: true })
}
await unlink(archivePath).catch(() => undefined)

const coreFiles = []
for (const relativePath of requiredFiles.filter((path) => !['espeak-ng-data', 'dict'].includes(path))) {
  const absolutePath = join(modelRoot, relativePath)
  const metadata = await stat(absolutePath)
  coreFiles.push({ path: relativePath, size: metadata.size, sha256: await fileSha256(absolutePath) })
}
await writeFile(manifestPath, `${JSON.stringify({
  schemaVersion: 2,
  engine: 'sherpa-onnx',
  runtimeVersion: '1.13.6',
  modelDir: MODEL_DIR,
  voiceCount: 103,
  chineseFemaleRange: [3, 57],
  chineseMaleRange: [58, 102],
  archiveSha256,
  installedAt: new Date().toISOString(),
  files: coreFiles,
}, null, 2)}\n`, 'utf8')
process.stdout.write(`本地中文语音包安装完成：${modelRoot}\nSHA-256: ${archiveSha256}\n`)

async function validInstall(root) {
  try {
    for (const relativePath of requiredFiles) await stat(join(root, relativePath))
    const existing = await readFile(join(root, 'README.md'), 'utf8').catch(() => '')
    return existing.length > 0
  } catch { return false }
}

async function extractArchive(archive, destination) {
  const extractor = tar.extract()
  extractor.on('entry', (header, stream, next) => {
    void (async () => {
      const segments = header.name.replaceAll('\\', '/').split('/').filter(Boolean)
      if (segments[0] !== MODEL_DIR || segments.includes('..')) throw new Error(`语音包包含非法路径：${header.name}`)
      if (!['file', 'directory'].includes(header.type)) throw new Error(`语音包包含不允许的条目：${header.type}`)
      const target = resolve(destination, ...segments)
      const base = resolve(destination)
      if (!target.startsWith(`${base}${sep}`)) throw new Error(`语音包路径越界：${header.name}`)
      if (header.type === 'directory') {
        await mkdir(target, { recursive: true })
        stream.resume()
      } else {
        await mkdir(dirname(target), { recursive: true })
        await pipeline(stream, createWriteStream(target, { flags: 'wx', mode: 0o600 }))
      }
      next()
    })().catch((error) => extractor.destroy(error))
  })
  await pipeline(createReadStream(archive), unbzip2(), extractor)
}

function assertManagedPath(target) {
  const base = resolve(voiceRoot)
  const candidate = resolve(target)
  if (!candidate.startsWith(`${base}${sep}`)) throw new Error('拒绝修改本地语音目录之外的路径')
}

async function fileSha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function formatBytes(value) { return `${(value / 1024 / 1024).toFixed(1)} MiB` }

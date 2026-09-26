import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const artifacts = join(desktopRoot, '.desktop-build', 'artifacts')
const releaseRoot = join(artifacts, 'release')
const version = JSON.parse(readFileSync(join(desktopRoot, 'package.json'), 'utf8')).version
const tag = `desktop-v${version}`
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('桌面预发布资产只能在 Windows x64 准备')
if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME !== tag) throw new Error(`Git 标签与桌面版本不符：预期 ${tag}`)

const installerSource = join(artifacts, `DSH Cyber Setup ${version}.exe`)
const unpacked = join(artifacts, 'win-unpacked')
if (!existsSync(installerSource) || statSync(installerSource).size < 100_000_000) throw new Error('已验证的 Windows 安装包不存在')
if (!existsSync(join(unpacked, 'resources', 'runtime', 'node.exe'))) throw new Error('便携包缺少独立运行时')
mkdirSync(releaseRoot, { recursive: true })

const installer = join(releaseRoot, `DSH-Cyber-Setup-${version}-win-x64.exe`)
const portable = join(releaseRoot, `DSH-Cyber-Portable-${version}-win-x64.zip`)
copyFileSync(installerSource, installer)
rmSync(portable, { force: true })
const archived = spawnSync('tar.exe', ['-a', '-c', '-f', portable, '-C', unpacked, '.'], { stdio: 'inherit', windowsHide: true })
if (archived.error) throw archived.error
if (archived.status !== 0 || !existsSync(portable) || statSync(portable).size < 100_000_000) throw new Error('便携包压缩失败')
const checked = spawnSync('tar.exe', ['-tf', portable], { stdio: ['ignore', 'ignore', 'inherit'], windowsHide: true })
if (checked.error) throw checked.error
if (checked.status !== 0) throw new Error('便携包校验失败')
await smokePortable(portable)

const assets = []
for (const path of [installer, portable]) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  assets.push({ name: path.split(/[\\/]/).pop(), bytes: statSync(path).size, sha256: hash.digest('hex') })
}
writeFileSync(join(releaseRoot, 'SHA256SUMS.txt'), `${assets.map((asset) => `${asset.sha256}  ${asset.name}`).join('\n')}\n`)
writeFileSync(join(releaseRoot, 'release-assets.json'), `${JSON.stringify({ tag, version, assets }, null, 2)}\n`)
console.log(`预发布资产已准备：${releaseRoot}`)
for (const asset of assets) console.log(`${asset.name}  ${asset.bytes} B  SHA-256 ${asset.sha256}`)

async function smokePortable(archive) {
  const extracted = mkdtempSync(join(tmpdir(), 'dsh-cyber-portable-smoke-'))
  const contained = relative(tmpdir(), extracted)
  if (!contained.startsWith('dsh-cyber-portable-smoke-') || contained.includes(sep)) throw new Error('便携包验收目录无效')
  let host
  try {
    const unpacked = spawnSync('tar.exe', ['-xf', archive, '-C', extracted], { stdio: 'inherit', windowsHide: true })
    if (unpacked.error) throw unpacked.error
    if (unpacked.status !== 0 || !existsSync(join(extracted, 'DSH Cyber.exe'))) throw new Error('便携包解压失败')
    const require = createRequire(import.meta.url)
    const { launchHost } = require('../runtime.cjs')
    const resources = join(extracted, 'resources')
    const paths = {
      node: join(resources, 'runtime', 'node.exe'),
      cli: join(resources, 'runtime', 'lib', 'bin.js'),
      webRoot: join(resources, 'web'),
      marketplaceRoot: join(resources, 'marketplace'),
    }
    host = launchHost(paths, join(extracted, 'smoke-state'))
    const response = await fetch(`${await host.originPromise}/api/health`)
    if (!response.ok || (await response.json()).ok !== true) throw new Error('便携包解压后无法独立启动服务')
  } finally {
    await host?.stop()
    rmSync(extracted, { recursive: true, force: true })
  }
}

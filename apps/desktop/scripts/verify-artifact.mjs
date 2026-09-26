import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const artifacts = join(desktopRoot, '.desktop-build', 'artifacts')
const resources = join(artifacts, 'win-unpacked', 'resources')
const runtime = join(resources, 'runtime')
const version = JSON.parse(readFileSync(join(desktopRoot, 'package.json'), 'utf8')).version
const required = [
  join(artifacts, 'win-unpacked', 'DSH Cyber.exe'),
  join(runtime, 'node.exe'),
  join(runtime, 'lib', 'bin.js'),
  join(runtime, 'node_modules', '@dsh-cyber', 'server', 'lib', 'index.js'),
  join(resources, 'web', 'index.html'),
  join(resources, 'marketplace'),
  join(resources, 'LICENSE'),
]
for (const target of required) if (!existsSync(target)) throw new Error(`桌面包缺少 ${target}`)
if (!readdirSync(join(runtime, 'node_modules', '@dsh-cyber')).includes('harness-bundle')) throw new Error('桌面包缺少内置 Harness')
verifyNoLinks(join(runtime, 'node_modules'))
console.log('Windows 目录包：Node、服务、Web、市场和许可证齐全；无目录链接。')

if (process.argv[2] === 'installer') {
  const installer = join(artifacts, `DSH Cyber Setup ${version}.exe`)
  if (!existsSync(installer) || statSync(installer).size < 100_000_000) throw new Error('Windows 安装包不存在或长度异常')
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(installer)) hash.update(chunk)
  const digest = hash.digest('hex')
  writeFileSync(join(artifacts, 'SHA256SUMS.txt'), `${digest}  ${installer.split(/[\\/]/).pop()}\n`)
  console.log(`Windows 安装包 SHA-256：${digest}`)
}

function verifyNoLinks(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const target = join(directory, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`桌面包含不可移动的链接：${target}`)
    if (entry.isDirectory()) verifyNoLinks(target)
  }
}

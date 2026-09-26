import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(desktopRoot, '..', '..')
const version = JSON.parse(readFileSync(join(desktopRoot, 'package.json'), 'utf8')).version
const base = `https://github.com/cyber-ai-agent/dsh-cyber/releases/download/desktop-v${version}/`
const installer = `${base}DSH-Cyber-Setup-${version}-win-x64.exe`
const portable = `${base}DSH-Cyber-Portable-${version}-win-x64.zip`
const checksum = `${base}SHA256SUMS.txt`
for (const file of [join(repoRoot, 'README.md'), join(repoRoot, 'README_EN.md'), join(desktopRoot, 'README.md'), join(desktopRoot, 'releases', `${version}.md`)]) {
  const source = readFileSync(file, 'utf8')
  for (const link of [installer, portable, checksum]) {
    if (!source.includes(link)) throw new Error(`${file} 缺少与桌面版本 ${version} 对应的下载链接：${link}`)
  }
}
console.log(`桌面版本 ${version} 的中英文文档与 Release 资产链接一致。`)

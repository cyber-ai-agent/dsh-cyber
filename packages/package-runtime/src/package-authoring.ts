import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { CyberPackageManifest } from '@dsh-cyber/contracts'
import { packageContentDigest, validatePackageManifest } from './package-manager.js'

/** Local editor/VCS files never enter a release package. */
export function isPackageDevelopmentEntry(name: string): boolean {
  return name.startsWith('.') || name === 'node_modules' || name === 'Thumbs.db'
}

/** Regenerate derived metadata; authored capability and identity fields remain unchanged. */
export async function prepareLocalPackage(directory: string, options: { check?: boolean } = {}): Promise<{ changed: boolean; files: number; manifestPath: string }> {
  const root = resolve(directory)
  const rootInfo = await lstat(root)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('请选择真实的扩展包源码目录')
  const manifestPath = join(root, 'dsh-cyber.package.json')
  const info = await lstat(manifestPath)
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error('扩展包清单无效')
  const original = await readFile(manifestPath, 'utf8')
  const manifest = JSON.parse(original) as CyberPackageManifest
  const files: CyberPackageManifest['files'] = []
  let bytes = 0
  async function visit(directory: string, prefix: string, depth: number): Promise<void> {
    if (depth > 32) throw new Error('扩展包目录层级过深')
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      if (isPackageDevelopmentEntry(entry.name) || (prefix === '' && entry.name === 'dsh-cyber.package.json')) continue
      const path = prefix ? `${prefix}/${entry.name}` : entry.name
      const absolute = join(directory, entry.name)
      const before = await lstat(absolute)
      if (before.isSymbolicLink()) throw new Error(`扩展包文件不能是链接：${path}`)
      if (before.isDirectory()) { await visit(absolute, path, depth + 1); continue }
      if (!before.isFile()) throw new Error(`扩展包内容必须是普通文件：${path}`)
      bytes += before.size
      if (before.size > 64 * 1024 * 1024 || bytes > 256 * 1024 * 1024) throw new Error(`扩展包文件过大：${path}`)
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(absolute)) hash.update(chunk)
      const after = await lstat(absolute)
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error(`文件仍在写入，请稍后再试：${path}`)
      files.push({ path, sha256: hash.digest('hex') })
      if (files.length > 2048) throw new Error('扩展包文件超过 2048 个，请只保留需要发布的内容')
    }
  }
  await visit(root, '', 0)
  // Preserve existing file ordering so a refresh has a minimal reviewable diff.
  const order = new Map((manifest.files ?? []).map((file, index) => [file.path, index]))
  files.sort((a, b) => (order.get(a.path) ?? Infinity) - (order.get(b.path) ?? Infinity) || a.path.localeCompare(b.path, 'en'))
  manifest.files = files
  if (manifest.certification !== undefined) manifest.certification.contentSha256 = packageContentDigest(manifest)
  validatePackageManifest(manifest)
  const changed = JSON.stringify(JSON.parse(original)) !== JSON.stringify(manifest)
  if (changed && !options.check) {
    if (await readFile(manifestPath, 'utf8') !== original) throw new Error('清单已被其他编辑器修改，请重试')
    const temporary = join(root, `.package-prepare-${randomUUID()}.tmp`)
    try {
      await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' })
      await rename(temporary, manifestPath)
    } finally { await unlink(temporary).catch(() => undefined) }
  }
  return { changed, files: files.length, manifestPath }
}

import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'

import type { CyberPackageManifest } from '@dsh-cyber/contracts'

import {
  AVATAR_BASE_PACK_CAPABILITY,
  AVATAR_BASE_PACK_MANIFEST_PATH,
  assertAvatarBaseVrmEnvelope,
  parseInstalledAvatarBasePackManifest,
} from '../avatar-base-pack-manifest.js'

/**
 * Validates the Avatar Base Pack-specific part of a package source before an
 * install transaction starts.
 *
 * PackageRuntime still stages the package afterwards and verifies the complete
 * declared inventory. Rechecking the manifest + Base VRMs here gives users a
 * clean install-time failure instead of activating a package that can only be
 * rejected later when the 3D world opens.
 */
export async function validateAvatarBasePackSource(
  manifest: CyberPackageManifest,
  sourceDirectory: string,
): Promise<void> {
  if (manifest.kind !== 'asset' || !manifest.capabilities.includes(AVATAR_BASE_PACK_CAPABILITY)) return

  const declaration = manifest.files.find((file) => file.path === AVATAR_BASE_PACK_MANIFEST_PATH)
  if (declaration === undefined) throw new Error(`Avatar Base Pack 缺少 ${AVATAR_BASE_PACK_MANIFEST_PATH}`)

  const manifestBytes = await readDeclaredSourceFile(manifest, sourceDirectory, declaration.path)
  let value: unknown
  try {
    value = JSON.parse(manifestBytes.toString('utf8'))
  } catch {
    throw new Error('Avatar Base Pack manifest 不是有效 JSON')
  }
  const pack = parseInstalledAvatarBasePackManifest(value, {
    packageId: manifest.id,
    version: manifest.version,
    manifest,
  })

  for (const base of pack.bases) {
    const body = await readDeclaredSourceFile(manifest, sourceDirectory, base.assetPath)
    assertAvatarBaseVrmEnvelope(body, `${manifest.id}/${base.assetPath}`)
  }
}

async function readDeclaredSourceFile(
  manifest: CyberPackageManifest,
  sourceDirectory: string,
  relativePath: string,
): Promise<Buffer> {
  const declared = manifest.files.find((file) => file.path === relativePath)
  if (declared === undefined) throw new Error(`Avatar Base Pack 文件未声明：${relativePath}`)

  const root = resolve(sourceDirectory)
  const rootMetadata = await lstat(root)
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error('Avatar Base Pack 源目录必须是普通目录')
  }

  let current = root
  for (const segment of relativePath.split('/')) {
    current = resolve(current, segment)
    if (current !== root && !current.startsWith(`${root}${sep}`)) {
      throw new Error(`Avatar Base Pack 文件越界：${relativePath}`)
    }
    const segmentMetadata = await lstat(current)
    if (segmentMetadata.isSymbolicLink()) {
      throw new Error(`Avatar Base Pack 路径不允许符号链接：${relativePath}`)
    }
  }

  const metadata = await lstat(current)
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`Avatar Base Pack 文件不是普通文件：${relativePath}`)

  const body = await readFile(current)
  const digest = createHash('sha256').update(body).digest('hex')
  if (digest !== declared.sha256) throw new Error(`Avatar Base Pack 文件哈希不匹配：${relativePath}`)
  return body
}

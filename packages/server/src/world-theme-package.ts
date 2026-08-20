import { extname } from 'node:path'

import type { WorldThemeManifestV1 } from '@dsh-cyber/contracts'

const MAX_IMAGE_BYTES = 4 * 1024 * 1024
const MAX_SPRITESHEET_BYTES = 8 * 1024 * 1024
const ASSET_PATH = /^assets\/[a-z0-9][a-z0-9./-]*\.(?:png|jpe?g|webp)$/

export async function validateWorldThemePackageAssets(
  manifest: WorldThemeManifestV1,
  declaredPaths: Set<string>,
  readAsset: (relativePath: string) => Promise<Buffer>,
): Promise<void> {
  for (const asset of manifest.assets) {
    if (!ASSET_PATH.test(asset.src) || asset.src.split('/').some((segment) => segment.startsWith('.'))) {
      throw new Error(`World theme asset must use a lowercase package assets/ path: ${asset.src}`)
    }
    if (!declaredPaths.has(asset.src)) throw new Error(`World theme asset is not a declared package file: ${asset.src}`)
    const body = await readAsset(asset.src)
    const maximum = asset.kind === 'spritesheet' ? MAX_SPRITESHEET_BYTES : MAX_IMAGE_BYTES
    if (body.byteLength > maximum) throw new Error(`World theme ${asset.kind} exceeds its size limit: ${asset.src}`)
    const extension = extname(asset.src).toLowerCase()
    if (asset.kind === 'spritesheet' && extension !== '.png') {
      throw new Error(`World theme spritesheet must be a PNG file: ${asset.src}`)
    }
    if (!matchesImageSignature(extension, body)) {
      throw new Error(`World theme asset signature does not match its extension: ${asset.src}`)
    }
  }
}

function matchesImageSignature(extension: string, body: Buffer): boolean {
  if (extension === '.png') {
    return body.length >= 8 && body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  }
  if (extension === '.jpg' || extension === '.jpeg') {
    return body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff
  }
  if (extension === '.webp') {
    return body.length >= 12 && body.subarray(0, 4).toString('ascii') === 'RIFF' && body.subarray(8, 12).toString('ascii') === 'WEBP'
  }
  return false
}

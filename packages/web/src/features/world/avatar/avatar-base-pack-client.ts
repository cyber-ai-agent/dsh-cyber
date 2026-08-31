import { api } from '../../../api.js'
import { parseAvatarBasePackManifest, type AvatarBasePackManifest } from './avatar-base-pack.js'

export async function loadWorldAvatarBasePacks(worldId: string): Promise<AvatarBasePackManifest[]> {
  const response = await api<{ items: unknown[] }>(`/api/worlds/${encodeURIComponent(worldId)}/avatar-base-packs`)
  return response.items.map((item) => parseAvatarBasePackManifest(item as AvatarBasePackManifest))
}

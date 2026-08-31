import type { VrmActor } from './vrm/VrmActor.js'
import type { ResolvedAvatarRepresentation } from './avatar-representation.js'

const PACK_URL_PREFIX = 'dsh-avatar-pack:'

/**
 * ThreeWorldRenderer currently uses one string as both "what representation is
 * this?" and "what should I load?". Published VRMs are already real URLs. A
 * shared assembled pack is not: its identity includes the recipe/pack version,
 * while its bytes come from one shared Base VRM. This opaque internal key keeps
 * hot-swap/failure de-duplication correct without exposing the pack source URL
 * as if it were an employee-specific avatar.
 */
export function rendererAvatarUrl(
  employeeId: string,
  representation: ResolvedAvatarRepresentation | undefined,
): string | undefined {
  if (representation === undefined) return undefined
  if (representation.source === 'published') return representation.assetUrl
  return `${PACK_URL_PREFIX}${encodeURIComponent(employeeId)}:${encodeURIComponent(representation.key)}`
}

export async function loadRendererAvatar(
  rendererUrl: string,
  resolve: (employeeId: string) => ResolvedAvatarRepresentation | undefined,
  signal?: AbortSignal,
): Promise<VrmActor> {
  const packed = parsePackRendererUrl(rendererUrl)
  if (packed === undefined) {
    const { VrmActor } = await import('./vrm/VrmActor.js')
    return VrmActor.load({
      assetUrl: rendererUrl,
      ...(signal === undefined ? {} : { signal }),
    })
  }
  const current = resolve(packed.employeeId)
  if (current === undefined || current.source !== 'base-pack' || current.key !== packed.key || current.assembly === undefined) {
    throw new DOMException('角色 3D 表示已更新', 'AbortError')
  }
  const { VrmActor } = await import('./vrm/VrmActor.js')
  return VrmActor.load({
    assetUrl: current.assetUrl,
    ...(current.cacheKey === undefined ? {} : { cacheKey: current.cacheKey }),
    assembly: current.assembly,
    ...(signal === undefined ? {} : { signal }),
  })
}

export function parsePackRendererUrl(value: string): { employeeId: string; key: string } | undefined {
  if (!value.startsWith(PACK_URL_PREFIX)) return undefined
  const rest = value.slice(PACK_URL_PREFIX.length)
  const split = rest.indexOf(':')
  if (split <= 0 || split === rest.length - 1) return undefined
  try {
    return {
      employeeId: decodeURIComponent(rest.slice(0, split)),
      key: decodeURIComponent(rest.slice(split + 1)),
    }
  } catch {
    return undefined
  }
}

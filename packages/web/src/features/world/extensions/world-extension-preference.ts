export type BuiltInWorldExtensionId = 'spatial-3d'

const PREFIX = 'dsh-cyber-world-extension'

/** Optional extensions are off by default and must be explicitly enabled. */
export function readWorldExtensionEnabled(id: BuiltInWorldExtensionId): boolean {
  if (typeof localStorage === 'undefined') return false
  try {
    return localStorage.getItem(`${PREFIX}:${id}`) === 'true'
  } catch {
    return false
  }
}

export function writeWorldExtensionEnabled(id: BuiltInWorldExtensionId, enabled: boolean): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(`${PREFIX}:${id}`, enabled ? 'true' : 'false')
  } catch {
    // Optional feature preference failure must never break the core world.
  }
}

import type { CyberEmployee } from '../../../types.js'

export type WorldViewMode = 'map' | '2d' | '3d'
export type CharacterViewMode = Exclude<WorldViewMode, 'map'>

export function hasInteractiveVrm(employee: CyberEmployee | undefined): boolean {
  return employee?.avatarProfile?.rendererKind === 'vrm-3d'
    && employee.avatarAssetUrl !== undefined
    && employee.avatarProfile.capabilities.includes('full-body')
}

export function characterModeAfterMap(preferred: CharacterViewMode): CharacterViewMode {
  return preferred
}

export function threeDimensionalControl(employee: CyberEmployee | undefined): {
  available: boolean
  label: string
  title: string
} {
  // The control switches renderers; it stopped opening the avatar editor when
  // the world learned to draw a character that has no avatar yet. What it says
  // has to match: it is always available, and it never promises creation.
  if (employee === undefined) return { available: false, label: '3D', title: '用三维方式观看这个世界' }
  if (hasInteractiveVrm(employee)) return { available: true, label: '3D', title: `在三维世界中查看${employee.displayName}` }
  return { available: false, label: '3D', title: `用三维方式观看这个世界（${employee.displayName}还没有 3D 形象，将以默认形象出场）` }
}

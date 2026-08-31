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
  if (employee === undefined) return { available: false, label: '3D', title: '请先选择一个角色' }
  if (hasInteractiveVrm(employee)) return { available: true, label: '3D', title: `查看${employee.displayName}的 3D 数字人` }
  return { available: false, label: '创建 3D', title: `为${employee.displayName}创建 3D 形象` }
}

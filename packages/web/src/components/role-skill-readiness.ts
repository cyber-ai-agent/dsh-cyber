import type { SkillCatalogEntry } from './skill-catalog.js'

export type SkillSetupTarget = 'role' | 'world' | 'catalog'

/** Presentation only: the world catalog and current revision remain authoritative. */
export function roleSkillReadiness(entry: SkillCatalogEntry | undefined, granted: boolean): {
  usable: boolean
  label: string
  reason: string
  target?: SkillSetupTarget
} {
  if (entry === undefined) return { usable: false, label: '目录中未找到', reason: '技能可能未安装、已移除或连接不可用。先到技能中心检查来源。', target: 'catalog' }
  if (!entry.worldAvailable || entry.availability !== 'available') {
    switch (entry.availabilityReason) {
      case 'world-disabled': return { usable: false, label: '世界未启用', reason: '当前世界的技能设置未启用这项技能。', target: 'world' }
      case 'workspace-disabled': return { usable: false, label: '全局默认未启用', reason: '当前世界跟随全局默认，可在此世界单独启用。', target: 'world' }
      case 'package-conflict': return { usable: false, label: '技能包冲突', reason: '多个活动技能包声明了相同能力，需要先处理来源冲突。', target: 'catalog' }
      case 'package-unavailable': return { usable: false, label: '技能包未就绪', reason: '当前范围内没有可用的技能包版本，请检查安装与世界设置。', target: 'world' }
      case 'adapter-package-mismatch': return { usable: false, label: '执行适配器不匹配', reason: '技能包与宿主执行适配器不匹配，请检查技能来源。', target: 'catalog' }
      case 'adapter-unavailable': return { usable: false, label: '执行适配器不可用', reason: '宿主尚未提供这项技能的执行适配器。', target: 'catalog' }
      default: return { usable: false, label: '当前世界不可用', reason: '技能目录暂未说明原因，请检查世界技能设置与技能来源。', target: 'world' }
    }
  }
  if (!granted) return { usable: false, label: '角色未授权', reason: '世界已启用；需要在角色技能设置中明确授权。', target: 'role' }
  return { usable: true, label: '可使用', reason: '已获角色授权，当前世界已启用。' }
}

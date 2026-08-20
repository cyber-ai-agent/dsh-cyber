import type { World } from '@dsh-cyber/contracts'

export type WorldKind = 'company' | 'tavern' | 'studio'

export interface WorldExperience {
  kind: WorldKind
  peopleLabel: string
  personLabel: string
  marketLabel: string
  actionLabel: string
  emptyTitle: string
  emptyCopy: string
  composerPlaceholder: string
  sceneTitle: string
  sceneSubtitle: string
}

const experiences: Record<WorldKind, WorldExperience> = {
  company: {
    kind: 'company',
    peopleLabel: '员工',
    personLabel: '员工',
    marketLabel: '员工市场',
    actionLabel: '任务',
    emptyTitle: '公司还没有员工',
    emptyCopy: '从员工市场招聘第一位独立 Agent，建立属于这个世界的组织与会话。',
    composerPlaceholder: '@员工 下达任务，或同时点名多人召开协作会…',
    sceneTitle: '总部指挥中心',
    sceneSubtitle: '真实任务状态会改变角色所在区域与行动',
  },
  tavern: {
    kind: 'tavern',
    peopleLabel: '角色',
    personLabel: '角色',
    marketLabel: '角色卡市场',
    actionLabel: '剧情',
    emptyTitle: '酒馆还没有登场角色',
    emptyCopy: '邀请角色卡进入当前世界。每名角色保留独立设定、记忆、说话方式与关系。',
    composerPlaceholder: '@角色 推进剧情，或点名多名角色开始群体演绎…',
    sceneTitle: '今夜场景',
    sceneSubtitle: '角色卡、场景与本次剧情上下文彼此独立',
  },
  studio: {
    kind: 'studio',
    peopleLabel: '成员',
    personLabel: '成员',
    marketLabel: '创作者市场',
    actionLabel: '内容',
    emptyTitle: '工作室还没有成员',
    emptyCopy: '邀请一名创作角色，开始策划、制作与发布。',
    composerPlaceholder: '@成员 发起选题、制作或复盘…',
    sceneTitle: '内容工作室',
    sceneSubtitle: '从灵感到发布的多角色创作现场',
  },
}

export function worldExperience(world: Pick<World, 'templateId'>): WorldExperience {
  const template = world.templateId.toLowerCase()
  if (template.includes('tavern')) return experiences.tavern
  if (template.includes('studio') || template.includes('creator')) return experiences.studio
  return experiences.company
}

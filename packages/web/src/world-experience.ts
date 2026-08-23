import type { World } from '@dsh-cyber/contracts'

export type WorldKind = 'personal' | 'company' | 'tavern' | 'studio'

export interface WorldExperience {
  kind: WorldKind
  peopleLabel: string
  personLabel: string
  /** Local role-instantiation label. The global extension catalog is always called 市场. */
  marketLabel: string
  actionLabel: string
  emptyTitle: string
  emptyCopy: string
  composerPlaceholder: string
  sceneTitle: string
  sceneSubtitle: string
}

const experiences: Record<WorldKind, WorldExperience> = {
  personal: {
    kind: 'personal',
    peopleLabel: '角色',
    personLabel: '角色',
    marketLabel: '新增角色',
    actionLabel: '互动',
    emptyTitle: '这个世界还没有角色',
    emptyCopy: '前往右侧「档案」新增独立角色；新的角色模板可从顶部「市场 → 角色」安装，也可以在创意工坊创建。',
    composerPlaceholder: '@角色 开始对话或任务…',
    sceneTitle: '我的世界',
    sceneSubtitle: '世界观、角色、模型与记忆在这里独立存在',
  },
  company: {
    kind: 'company',
    peopleLabel: '角色',
    personLabel: '角色',
    marketLabel: '新增角色',
    actionLabel: '任务',
    emptyTitle: '公司还没有角色',
    emptyCopy: '前往右侧「档案」新增第一名独立 Agent；模板安装统一从顶部「市场 → 角色」进入。',
    composerPlaceholder: '@角色 下达任务，或同时点名多人召开协作会…',
    sceneTitle: '总部指挥中心',
    sceneSubtitle: '真实任务状态会改变角色所在区域与行动',
  },
  tavern: {
    kind: 'tavern',
    peopleLabel: '角色',
    personLabel: '角色',
    marketLabel: '邀请角色',
    actionLabel: '剧情',
    emptyTitle: '酒馆还没有登场角色',
    emptyCopy: '从右侧「档案」邀请角色入场；新角色模板统一从顶部市场安装。',
    composerPlaceholder: '@角色 推进剧情，或点名多名角色开始群体演绎…',
    sceneTitle: '今夜场景',
    sceneSubtitle: '角色、场景与本次剧情上下文彼此独立',
  },
  studio: {
    kind: 'studio',
    peopleLabel: '成员',
    personLabel: '成员',
    marketLabel: '新增成员',
    actionLabel: '内容',
    emptyTitle: '工作室还没有成员',
    emptyCopy: '从右侧「档案」新增创作成员；需要新模板时使用顶部市场或创意工坊。',
    composerPlaceholder: '@成员 发起选题、制作或复盘…',
    sceneTitle: '内容工作室',
    sceneSubtitle: '从灵感到发布的多角色创作现场',
  },
}

export function worldExperience(world: Pick<World, 'templateId'>): WorldExperience {
  const template = world.templateId.toLowerCase()
  if (template === 'personal' || template === 'personal-world') return experiences.personal
  if (template === 'tavern' || template === 'moonlit-tavern') return experiences.tavern
  if (template === 'studio' || template === 'creator-studio') return experiences.studio
  return experiences.company
}

import type { World } from '@dsh-cyber/contracts'

export type WorldKind = 'personal' | 'company' | 'tavern' | 'studio' | 'observatory' | 'academy' | 'hub' | 'garden' | 'news'

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
    emptyCopy: '前往右侧「角色」新增独立角色；新的角色模板可从顶部「市场 → 角色」安装，也可以在创意工坊创建。',
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
    emptyCopy: '前往右侧「角色」新增第一名独立 Agent；模板安装统一从顶部「市场 → 角色」进入。',
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
    emptyCopy: '从右侧「角色」邀请角色入场；新角色模板统一从顶部市场安装。',
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
    emptyCopy: '从右侧「角色」新增创作成员；需要新模板时使用顶部市场或创意工坊。',
    composerPlaceholder: '@成员 发起选题、制作或复盘…',
    sceneTitle: '内容工作室',
    sceneSubtitle: '从灵感到发布的多角色创作现场',
  },
  observatory: {
    kind: 'observatory',
    peopleLabel: '研究员',
    personLabel: '研究员',
    marketLabel: '加入研究员',
    actionLabel: '研究',
    emptyTitle: '观测站还没有研究员',
    emptyCopy: '从右侧「角色」邀请研究员加入；更多科研角色可从顶部市场安装。',
    composerPlaceholder: '@研究员 发起观测、分析或联合研究…',
    sceneTitle: '蓝环轨道观测层',
    sceneSubtitle: '观测记录、样本与研究会话只属于当前观测站',
  },
  academy: {
    kind: 'academy',
    peopleLabel: '教研角色',
    personLabel: '教研角色',
    marketLabel: '聘入学院',
    actionLabel: '教学',
    emptyTitle: '学院还没有教研角色',
    emptyCopy: '从右侧「角色」聘入教授、助教、课程设计师或知识动画设计师；更多教研角色可从顶部市场安装。',
    composerPlaceholder: '@教研角色 拆解知识点、排课程计划、做教学材料或开始答疑…',
    sceneTitle: '大学教室',
    sceneSubtitle: '知识拆解 → 课程计划 → 教学材料 → 答疑 → 知识图 → 课程结果',
  },
  hub: {
    kind: 'hub',
    peopleLabel: '助理角色',
    personLabel: '助理角色',
    marketLabel: '接入中枢',
    actionLabel: '委派',
    emptyTitle: '中枢还没有助理角色',
    emptyCopy: '从右侧「角色」接入中枢管家、调研员、日程管家或信息整理员；更多助理角色可从顶部市场安装。',
    composerPlaceholder: '说一件要办的事，中枢会判断归属再委派…',
    sceneTitle: '个人中枢工作室',
    sceneSubtitle: '接收请求 → 判断归属 → 委派 → 汇总回报',
  },
  garden: {
    kind: 'garden',
    peopleLabel: '整理角色',
    personLabel: '整理角色',
    marketLabel: '请入花园',
    actionLabel: '整理',
    emptyTitle: '花园还没有整理角色',
    emptyCopy: '从右侧「角色」请入知识管家、资料采集员、来源核验员或知识制图员；更多整理角色可从顶部市场安装。',
    composerPlaceholder: '@整理角色 采集来源、归档资料、提炼条目、核验引用或复看知识图谱…',
    sceneTitle: '藏书庭院',
    sceneSubtitle: '采集来源 → 归档资料 → 提炼条目 → 核验引用 → 连接知识图谱 → 复看维护',
  },
  news: {
    kind: 'news',
    peopleLabel: '编辑部角色',
    personLabel: '编辑部角色',
    marketLabel: '聘入编辑部',
    actionLabel: '追踪',
    emptyTitle: '新闻中心还没有编辑部角色',
    emptyCopy: '从右侧「角色」聘入科技新闻分析师、财经观察员或行业研究员；更多情报角色可从顶部市场安装。',
    composerPlaceholder: '@编辑部角色 建立追踪线、采集一轮、交叉核实或发布带日期的简报…',
    sceneTitle: '编辑部',
    sceneSubtitle: '建立追踪线 → 按节奏采集 → 交叉核实 → 更新时间线 → 发布带日期的简报 → 复盘并调整节奏',
  },
}

export function worldExperience(world: Pick<World, 'templateId'>): WorldExperience {
  const template = world.templateId.toLowerCase()
  if (template === 'personal' || template === 'personal-world') return experiences.personal
  if (template === 'tavern' || template === 'moonlit-tavern') return experiences.tavern
  if (template === 'studio' || template === 'creator-studio') return experiences.studio
  if (template === 'observatory' || template === 'orbital-observatory') return experiences.observatory
  if (template === 'academy' || template === 'ai-academy') return experiences.academy
  if (template === 'jarvis-core' || template === 'jarvis') return experiences.hub
  if (template === 'garden' || template === 'knowledge-garden') return experiences.garden
  if (template === 'news' || template === 'news-center') return experiences.news
  return experiences.company
}

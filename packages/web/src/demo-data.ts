import type {
  EmployeeDossier,
  EmployeeInstance,
  EmployeeMilestoneCategory,
  WorkMessage,
  WorkSession,
} from '@dsh-cyber/contracts'

import type { CyberEmployee, WorkbenchData } from './types.js'

const now = '2026-08-19T10:42:16.000Z'
const workspaceId = 'demo-workspace'
const worldId = 'demo-company'
const tavernWorldId = 'demo-tavern'

const roleSeed = [
  ['xiaoyu', '小羽', '产品经理', 'violet', '梳理 v0.3.0 发布范围', 'working'],
  ['laozhou', '老周', '架构师', 'navy', '评审租户隔离方案', 'working'],
  ['agui', '阿帆', '开发工程师', 'green', '实现审计日志接口', 'working'],
  ['xiaoq', '小Q', '测试工程师', 'amber', '执行发布回归', 'working'],
  ['anlan', '安澜', '安全专家', 'red', '等待修复后复测', 'blocked'],
  ['moyou', '墨游', '运维工程师', 'cyan', '部署发布与监控告警', 'available'],
  ['xiaoe', '小E', '数据分析师', 'orange', '分析质量趋势', 'waiting'],
  ['secretary', '秘书', '总裁秘书', 'silver', '整理会议纪要', 'available'],
] as const

export const demoEmployees: CyberEmployee[] = roleSeed.map((seed, index) => ({
  id: seed[0],
  workspaceId,
  worldId,
  blueprintId: `demo-${seed[0]}`,
  blueprintVersion: 1,
  displayName: seed[1],
  role: seed[2],
  presence: seed[5] === 'working' ? 'working' : 'available',
  health: seed[5] === 'blocked' ? 'blocked' : 'healthy',
  status: seed[5],
  currentRevision: 3,
  createdAt: '2026-05-20T09:00:00.000Z',
  updatedAt: now,
  avatarIndex: index,
  summary: `${seed[2]}独立 Agent，拥有自己的会话、记忆与成长记录。`,
  currentActivity: seed[4],
}))

const tavernRoleSeed = [
  ['tavern-innkeeper', '伊瑟拉', '酒馆老板娘', '在吧台后擦拭一只银杯', 'working'],
  ['tavern-bard', '洛安', '游吟诗人', '拨弄琴弦，观察壁炉旁的陌生人', 'available'],
  ['tavern-knight', '凯恩', '负伤骑士', '压低斗篷，等待下一轮发言', 'waiting'],
  ['tavern-archivist', '弥娅', '秘闻档案师', '整理刚刚听到的传闻与人物关系', 'available'],
] as const

export const demoTavernEmployees: CyberEmployee[] = tavernRoleSeed.map((seed, index) => ({
  id: seed[0],
  workspaceId,
  worldId: tavernWorldId,
  blueprintId: `demo-${seed[0]}`,
  blueprintVersion: 1,
  displayName: seed[1],
  role: seed[2],
  presence: seed[4] === 'working' ? 'working' : 'available',
  health: 'healthy',
  status: seed[4],
  currentRevision: 2,
  createdAt: '2026-06-12T20:00:00.000Z',
  updatedAt: now,
  avatarIndex: index + 2,
  summary: `${seed[2]}角色卡，拥有独立人设、记忆、世界知识与说话方式。`,
  currentActivity: seed[3],
}))

const sessionSeed = [
  ['release', '项目攻坚会：v0.3.0 发布计划', '2026-08-19T10:42:00.000Z'],
  ['security', '安全审计与修复跟进', '2026-08-18T16:12:00.000Z'],
  ['ability', '智能体能力评审会', '2026-08-18T11:04:00.000Z'],
  ['feedback', '客户反馈与需求池', '2026-08-17T15:20:00.000Z'],
  ['celebration', '例行庆会 05-20', '2026-05-20T17:30:00.000Z'],
] as const

const sessions: WorkSession[] = sessionSeed.map(([id, title, updatedAt]) => ({
  id,
  workspaceId,
  worldId,
  kind: id === 'release' ? 'meeting' : 'group',
  title,
  status: 'open',
  createdAt: updatedAt,
  updatedAt,
}))

export const demoTavernSessions: WorkSession[] = [{
  id: 'tavern-rainy-night',
  workspaceId,
  worldId: tavernWorldId,
  kind: 'group',
  title: '雨夜的陌生委托',
  status: 'open',
  createdAt: '2026-08-19T20:18:00.000Z',
  updatedAt: '2026-08-19T20:24:00.000Z',
}]

export const demoMessages: WorkMessage[] = [
  message('m1', 1, 'xiaoyu', 'employee', 'assistant', '目标：5 天后发布 v0.3.0，包含多租户隔离、审计日志与告警策略配置。\n\n@老周 请确认方案边界，@阿帆 评估开发工作量，@小Q 规划测试范围。', '10:32'),
  message('m2', 2, 'laozhou', 'employee', 'assistant', '方案边界已明确：租户隔离基于 Row-Level Security；审计日志落地 ClickHouse；告警策略使用规则引擎。相关架构设计已更新。', '10:33'),
  message('m3', 3, 'agui', 'employee', 'assistant', '开发工作量预估：后端 32h，前端 16h，联调 8h，合计 56h。我会先完成审计日志与策略引擎的接口实现。', '10:35'),
  message('m4', 4, 'xiaoq', 'employee', 'assistant', '测试范围：多租户数据隔离、审计日志写入与查询、告警策略触发与去重。预计 42 条用例，自动化覆盖目标 80%。', '10:36'),
  message('m5', 5, 'anlan', 'employee', 'reasoning', '先核对扫描来源、风险等级和修复依赖，再决定是否阻断发布。已确认两个发现都来自本次真实扫描，其中一个需要等待接口修复。', '10:37'),
  message('m6', 6, 'anlan', 'employee', 'assistant', '安全扫描已触发，发现 2 个中危风险。已进入等待推进，修复后自动排队复测。', '10:38'),
]

export const demoTavernMessages: WorkMessage[] = [
  tavernMessage('tm1', 1, 'owner', 'owner', 'user', '雨越下越大。我推开酒馆的门，问：今晚是谁在等我？', '20:18'),
  tavernMessage('tm2', 2, 'tavern-innkeeper', 'employee', 'assistant', '伊瑟拉没有立刻回答。她把银杯推到你面前，杯底压着一枚沾泥的旧徽章：“等你的不是人，是一桩迟到了十二年的债。”', '20:19'),
  tavernMessage('tm3', 3, 'tavern-bard', 'employee', 'assistant', '洛安的琴弦发出一声短促的颤音。他看向壁炉旁那个始终没有抬头的旅人：“那枚徽章，我在北境的葬歌里见过。”', '20:21'),
  tavernMessage('tm4', 4, 'tavern-knight', 'employee', 'assistant', '凯恩终于抬起头，雨水顺着斗篷滴落。他的手按住剑柄，却不是为了拔剑：“别再唱了。那首歌里死去的人，还没有全都入土。”', '20:24'),
]

function tavernMessage(
  id: string,
  sequence: number,
  senderId: string,
  senderKind: WorkMessage['senderKind'],
  kind: WorkMessage['kind'],
  content: string,
  time: string,
): WorkMessage {
  return {
    id,
    sessionId: 'tavern-rainy-night',
    sequence,
    senderId,
    senderKind,
    kind,
    content,
    metadata: { displayTime: time },
    createdAt: `2026-08-19T${time}:00.000Z`,
  }
}

function message(
  id: string,
  sequence: number,
  senderId: string,
  senderKind: WorkMessage['senderKind'],
  kind: WorkMessage['kind'],
  content: string,
  time: string,
): WorkMessage {
  return {
    id,
    sessionId: 'release',
    sequence,
    senderId,
    senderKind,
    kind,
    content,
    metadata: { displayTime: time },
    createdAt: `2026-08-19T${time}:00.000Z`,
  }
}

function dossier(employee: CyberEmployee, index: number, roster: CyberEmployee[] = demoEmployees): EmployeeDossier {
  const isTavern = employee.worldId === tavernWorldId
  const skill = isTavern
    ? (['酒馆经营', '吟游叙事', '骑士礼仪', '秘闻归档'][index] ?? '角色演绎')
    : (['需求拆解', '系统设计', 'TypeScript 工程', '回归测试', '安全审计', '发布运维', '数据分析', '会议协调'][index] ?? '协作')
  const categories: EmployeeMilestoneCategory[] = ['joined', 'delivery', 'skill', 'review']
  return {
    employee,
    revisions: [{
      employeeId: employee.id,
      revision: employee.currentRevision,
      persona: isTavern ? `${employee.role}，始终保持独立人设、知识边界和说话方式。` : `${employee.role}，以可验证结果和清晰协作为工作原则。`,
      skillGrants: [],
      capabilityGrants: [],
      modelPolicy: { modelProfileId: 'deepseek-default' },
      reason: isTavern ? '从角色卡市场进入当前故事世界' : '从角色市场加入当前世界',
      createdAt: now,
    }],
    profile: {
      employeeId: employee.id,
      revision: 2,
      birthday: index === 0 ? '05-24' : `0${(index % 8) + 1}-1${index}`,
      background: isTavern ? `${employee.role}，在月影酒馆拥有自己的来历、秘密、关系与长期记忆。` : `${employee.role}，关注可验证交付、清晰沟通与持续改进。`,
      personalityTraits: index % 2 === 0 ? ['严谨', '主动', '务实'] : ['沉稳', '好奇', '可靠'],
      appearance: { avatarIndex: index },
      reason: '完成角色数字档案建档',
      createdAt: now,
    },
    skills: [
      {
        employeeId: employee.id,
        skillId: skill,
        revision: 2,
        status: 'verified',
        evidenceIds: [`evidence-${employee.id}`],
        reason: isTavern ? '通过真实对话、剧情事件与角色一致性验证。' : '通过真实任务、测试或评审验证。',
        createdAt: now,
      },
      {
        employeeId: employee.id,
        skillId: isTavern ? '多角色演绎' : '跨角色协作',
        revision: 1,
        status: 'learning',
        evidenceIds: [],
        reason: isTavern ? '正在剧情互动与关系变化中积累证据。' : '正在会议和交付协作中积累证据。',
        createdAt: now,
      },
    ],
    evidence: [{
      id: `evidence-${employee.id}`,
      workspaceId,
      worldId: employee.worldId,
      employeeId: employee.id,
      skillId: skill,
      kind: 'review',
      outcome: 'passed',
      summary: isTavern ? '人物回应与角色卡设定、场景知识保持一致。' : '交付物通过同伴评审与验收。',
      sourceEventIds: [`event-${employee.id}`],
      sourceMessageIds: [`message-${employee.id}`],
      artifactRefs: [isTavern ? `lore/${employee.id}-scene.md` : `artifacts/${employee.id}-delivery.md`],
      createdAt: now,
    }],
    milestones: categories.map((category, milestoneIndex) => ({
      id: `${employee.id}-${category}`,
      workspaceId,
      worldId: employee.worldId,
      employeeId: employee.id,
      category,
      title: [isTavern ? '进入月影酒馆' : '加入赛博公司', isTavern ? '完成首段角色演绎' : '完成首个可验收交付', `掌握技能：${skill}`, isTavern ? '建立关键角色关系' : '通过跨角色评审'][milestoneIndex]!,
      summary: ['建立独立身份、记忆与会话。', isTavern ? '角色表现与设定保持一致。' : '交付结果通过老板验收。', '有消息、事件和结果作为技能证据。', isTavern ? '通过真实剧情互动更新关系。' : '与同事完成评审并沉淀改进项。'][milestoneIndex]!,
      sourceEventIds: [`event-${employee.id}-${milestoneIndex}`],
      sourceMessageIds: [],
      artifactRefs: milestoneIndex === 1 ? [isTavern ? `lore/${employee.id}-scene.md` : `artifacts/${employee.id}-delivery.md`] : [],
      occurredAt: `2026-0${5 + milestoneIndex}-2${milestoneIndex}T10:00:00.000Z`,
      createdAt: now,
    })),
    journals: [{
      employeeId: employee.id,
      localDate: '2026-08-19',
      revision: 1,
      summary: `今天推进了“${employee.currentActivity ?? '当前任务'}”，形成了可复查的结果。`,
      highlights: isTavern ? ['保持人物设定一致', '更新关系与剧情线索', `巩固技能：${skill}`] : ['完成计划内工作', '同步风险和下一步', `巩固技能：${skill}`],
      sourceEventIds: [`event-${employee.id}`],
      sourceMessageIds: [`message-${employee.id}`],
      createdAt: now,
    }],
    relationships: roster
      .filter((item) => item.id !== employee.id)
      .slice(0, 3)
      .map((item, relationIndex) => ({
        employeeId: employee.id,
        colleagueId: item.id,
        collaborationCount: 4 - relationIndex,
        reviewCount: relationIndex === 0 ? 2 : 1,
        handoffCount: relationIndex,
        lastInteractionAt: now,
        updatedAt: now,
      })),
  }
}

export const demoData: WorkbenchData = {
  workspace: {
    id: workspaceId,
    name: '核心研发空间',
    status: 'active',
    createdAt: '2026-05-20T08:00:00.000Z',
    updatedAt: now,
  },
  worlds: [
    {
      id: worldId,
      workspaceId,
      name: '赛博公司',
      templateId: 'cyber-company',
      status: 'active',
      createdAt: '2026-05-20T08:00:00.000Z',
      updatedAt: now,
    },
    {
      id: 'demo-tavern',
      workspaceId,
      name: '月影酒馆',
      templateId: 'tavern',
      status: 'active',
      createdAt: '2026-06-12T08:00:00.000Z',
      updatedAt: now,
    },
  ],
  activeWorld: {
    id: worldId,
    workspaceId,
    name: '赛博公司',
    templateId: 'cyber-company',
    status: 'active',
    createdAt: '2026-05-20T08:00:00.000Z',
    updatedAt: now,
  },
  employees: demoEmployees,
  sessions,
  messages: demoMessages,
  preferences: {
    locale: 'zh-CN',
    workspaceId,
    colorScheme: 'dark',
    skinId: 'cyber-graphite',
    backgroundFit: 'cover',
    backgroundOpacity: 0.18,
    interfaceDensity: 'compact',
    motion: 'system',
    leftPaneWidth: 292,
    rightPaneWidth: 550,
    updatedAt: now,
  },
  modelProfiles: [{
    id: 'deepseek-default',
    workspaceId,
    displayName: 'DeepSeek 默认模型',
    providerKind: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    modelId: 'deepseek-chat',
    api: 'openai-completions',
    credentialEnvName: 'DEEPSEEK_API_KEY',
    isDefault: true,
    settings: {},
    createdAt: now,
    updatedAt: now,
  }],
  dossiers: Object.fromEntries(demoEmployees.map((employee, index) => [employee.id, dossier(employee, index)])),
}

export const demoTavernDossiers = Object.fromEntries(
  demoTavernEmployees.map((employee, index) => [employee.id, dossier(employee, index, demoTavernEmployees)]),
)

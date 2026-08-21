import type { EmployeeBlueprint, WorldTemplateManifest } from '@dsh-cyber/contracts'

const CREATED_AT = '2026-08-19T00:00:00.000Z'

export const BUILTIN_WORLD_TEMPLATES: readonly WorldTemplateManifest[] = [
  {
    schemaVersion: 1,
    id: 'cyber-company',
    version: 1,
    displayName: '赛博公司',
    summary: '围绕项目、角色协作和交付运转的独立数字世界，也可通过世界设置改造成私人世界。',
    terminology: {
      agent: '角色',
      recruit: '添加角色',
      groupSession: '群组会话',
      assignment: '任务',
    },
  },
  {
    schemaVersion: 1,
    id: 'tavern',
    version: 1,
    displayName: '角色酒馆',
    summary: '拥有独立人物、关系和剧情记忆的多角色互动世界。',
    terminology: {
      agent: '角色',
      recruit: '邀请入席',
      groupSession: '同桌会话',
      assignment: '委托',
    },
  },
  {
    schemaVersion: 1,
    id: 'creator-studio',
    version: 1,
    displayName: '自媒体工作室',
    summary: '围绕选题、制作、审稿、发布与复盘协作的内容团队。',
    terminology: {
      agent: '角色',
      recruit: '添加角色',
      groupSession: '选题会',
      assignment: '制作单',
    },
  },
] as const

export const BUILTIN_BLUEPRINTS: readonly EmployeeBlueprint[] = [
  blueprint({
    id: 'core.butler',
    worldTemplateId: 'cyber-company',
    displayName: '管家',
    role: '世界管家',
    summary: '协助配置当前世界、整理会话、管理角色，并严格遵守当前世界的权限边界。',
    persona: '你是当前世界的独立管家。你帮助用户理解和配置这个世界，只以自己的身份发言，不读取其他世界的内容，也不会未经确认修改关键设置。',
    requestedSkills: ['world-setup', 'conversation-organization'],
  }),
  blueprint({
    id: 'cyber-company.secretary',
    worldTemplateId: 'cyber-company',
    displayName: '秘书',
    role: '秘书',
    summary: '整理日程、会议和跨角色信息；不会冒充其他角色。',
    persona: '你是独立的秘书角色。你负责协调与整理，只能以自己的身份发言，不能代替其他角色回答。',
    requestedSkills: ['meeting-notes', 'task-coordination'],
  }),
  blueprint({
    id: 'cyber-company.software-engineer',
    worldTemplateId: 'cyber-company',
    displayName: '开发工程师',
    role: '软件工程师',
    summary: '分析、实现和验证软件需求。',
    persona: '你是独立的软件工程师。先澄清验收标准，再实施、测试并报告真实证据。',
    requestedSkills: ['coding', 'testing'],
    requestedCapabilities: ['workspace:read'],
  }),
  blueprint({
    id: 'cyber-company.archivist',
    worldTemplateId: 'cyber-company',
    displayName: '档案管理员',
    role: '知识与档案管理员',
    summary: '在授权范围内整理来源可追溯的历史、知识条目和检索索引。',
    persona: '你是独立的档案管理员。区分原始档案、已验证事实和推断，回答时保留来源，绝不跨权限泄露记忆。',
    requestedSkills: ['archive-curation', 'knowledge-retrieval'],
    requestedCapabilities: ['knowledge:read'],
  }),
  blueprint({
    id: 'tavern.innkeeper',
    worldTemplateId: 'tavern',
    displayName: '酒馆老板',
    role: '酒馆经营者',
    summary: '经营酒馆、介绍来客并维护酒馆内的关系与秩序。',
    persona: '你是这个酒馆世界里的独立酒馆老板。你有自己的经历和立场，不是公司角色的换皮。',
  }),
  blueprint({
    id: 'tavern.bard',
    worldTemplateId: 'tavern',
    displayName: '吟游诗人',
    role: '吟游诗人',
    summary: '用自己的视角讲述故事、追问传闻并参与多角色剧情。',
    persona: '你是酒馆世界里的独立吟游诗人。你只知道自己经历或被明确告知的事，不读取其他世界的角色记忆。',
    requestedSkills: ['storytelling'],
  }),
  blueprint({
    id: 'creator-studio.editor',
    worldTemplateId: 'creator-studio',
    displayName: '主编',
    role: '内容主编',
    summary: '组织选题、定义受众和审稿标准。',
    persona: '你是自媒体工作室里的独立主编。你从受众价值、事实可靠性和发布风险做判断。',
    requestedSkills: ['editorial-review'],
  }),
  blueprint({
    id: 'creator-studio.producer',
    worldTemplateId: 'creator-studio',
    displayName: '内容制作人',
    role: '内容制作人',
    summary: '把选题转化为脚本、素材计划和制作交付。',
    persona: '你是自媒体工作室里的独立内容制作人。给出可执行的制作方案并对交付质量负责。',
    requestedSkills: ['content-production'],
  }),
] as const

export function worldTemplate(templateId: string): WorldTemplateManifest | undefined {
  return BUILTIN_WORLD_TEMPLATES.find((template) => template.id === templateId)
}

export function blueprintsForWorld(templateId: string): EmployeeBlueprint[] {
  return BUILTIN_BLUEPRINTS.filter((item) => item.worldTemplateId === templateId)
}

function blueprint(
  input: Omit<EmployeeBlueprint, 'schemaVersion' | 'version' | 'createdAt' | 'requestedSkills' | 'requestedCapabilities'> & {
    requestedSkills?: string[]
    requestedCapabilities?: string[]
  },
): EmployeeBlueprint {
  return {
    ...input,
    schemaVersion: 1,
    version: 1,
    requestedSkills: input.requestedSkills ?? [],
    requestedCapabilities: input.requestedCapabilities ?? [],
    createdAt: CREATED_AT,
  }
}

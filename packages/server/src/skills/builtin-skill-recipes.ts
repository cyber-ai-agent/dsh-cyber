import type { CharacterSkillDescriptor } from '@dsh-cyber/contracts/skill-runtime'

import type { CharacterSkillAdapterRegistry, CharacterSkillRecipe } from './skill-adapter.js'

type RecipeInput = Pick<CharacterSkillDescriptor, 'id' | 'displayName' | 'summary'> & { instruction: string }

const ROUTING_HINTS: Readonly<Record<string, readonly string[]>> = {
  'world-setup': ['世界', '设置', '配置', 'world', 'setup', 'configure'],
  'conversation-organization': ['会话', '聊天', '整理', 'conversation', 'organize', 'chat'],
  'meeting-notes': ['会议', '纪要', 'meeting', 'notes', 'minutes'],
  'task-coordination': ['任务', '协调', '计划', '依赖', 'task', 'coordinate', 'plan'],
  coding: ['代码', '编程', '实现', '开发', '软件', 'html', '前端', 'coding', 'code', 'frontend', 'build'],
  testing: ['测试', '验证', '回归', 'test', 'testing', 'verify', 'qa'],
  'archive-curation': ['档案', '归档', 'archive', 'curate'],
  'knowledge-retrieval': ['知识', '检索', '搜索', '资料', 'research', 'retrieve', 'search', 'knowledge'],
  'evidence-summarization': ['证据', '总结', '分析', 'evidence', 'summarize', 'analysis'],
  storytelling: ['故事', '叙事', 'story', 'storytelling'],
  'editorial-review': ['编辑', '审校', '校对', 'review', 'edit', 'editorial'],
  'content-production': ['内容', '制作', '脚本', 'content', 'produce', 'production'],
  'scientific-reasoning': ['科学', '研究', '假设', 'scientific', 'reasoning', 'research'],
  'systems-diagnostics': ['诊断', '系统', '故障', 'diagnostic', 'systems', 'debug'],
  'schedule-planning': ['日程', '节奏', '定时', '重复', '提醒', '周期', 'schedule', 'cadence', 'recurring', 'reminder'],
  'citation-audit': ['引用', '来源', '出处', '核验', '溯源', 'citation', 'source', 'provenance', 'verify'],
  'freshness-review': ['时效', '过期', '复核', '截至', '刷新', 'freshness', 'stale', 'outdated', 'as-of'],
  'curriculum-design': ['课程', '大纲', '课时', '教案', '学习目标', 'curriculum', 'syllabus', 'lesson', 'course'],
}

const BUILTIN_RECIPES: readonly CharacterSkillRecipe[] = [
  recipe('world-setup', '世界配置', '把世界设定转化为清晰、可验证且不越权的配置建议。', '先确认用户目标与当前世界边界；区分建议和已执行变更，未经确认不修改关键设置。'),
  recipe('conversation-organization', '会话整理', '梳理会话主题、结论、未决问题与下一步。', '按主题整理当前会话，保留说话者和事实来源；不得把推测写成已确认结论。'),
  recipe('meeting-notes', '会议纪要', '生成可追溯的会议结论、决定与行动项。', '输出议题、已确认决定、分歧、负责人、截止时间和待验证项；缺失信息明确标注，不虚构参会者承诺。'),
  recipe('task-coordination', '任务协调', '拆解目标、依赖、负责人、风险与验收标准。', '先写清交付物和验收标准，再拆分依赖与顺序；状态只依据当前世界中的真实记录。'),
  recipe('coding', '软件实现', '以小步、可验证和可维护的方式实现软件需求。', '先理解现有合同与测试，再做最小完整改动；保护用户已有修改，不用假实现冒充完成。'),
  recipe('testing', '测试验证', '设计覆盖正常、边界、失败与回归路径的验证。', '测试必须能证明行为而非只证明代码运行；报告实际命令、结果和未覆盖风险。'),
  recipe('archive-curation', '档案整理', '建立来源清晰、可检索且不跨世界泄露的档案。', '区分原始记录、已验证事实、摘要与推断；保留证据引用，只处理当前世界授权内容。'),
  recipe('knowledge-retrieval', '知识检索', '从当前世界可访问资料中检索并回答。', '优先一手资料和近期证据；说明检索范围、来源与不确定性，找不到时明确说没有找到。'),
  recipe('evidence-summarization', '证据总结', '把多条证据整理为结论、支持度与冲突点。', '逐项区分证据、解释和结论；展示相互冲突的证据，不用多数意见替代可靠性判断。'),
  recipe('storytelling', '叙事创作', '在当前世界设定和角色知识边界内创作连贯故事。', '保持人物视角、时间线和世界规则一致；未知事实以传闻或悬念表达，不读取其他世界的剧情。'),
  recipe('editorial-review', '编辑审校', '从受众、结构、事实、语言和发布风险审校内容。', '先指出影响最大的结构与事实问题，再给可直接执行的修改；保留作者意图并标记需核实内容。'),
  recipe('content-production', '内容制作', '把选题转化为受众明确的脚本、素材计划和交付清单。', '明确受众、平台、核心信息、结构、素材缺口和验收标准；不伪造素材、数据或授权。'),
  recipe('scientific-reasoning', '科学推理', '区分观测、假设、预测与可证伪验证。', '说明数据质量和假设前提，提出可证伪预测与最小复测方案；相关性不能直接写成因果。'),
  recipe('systems-diagnostics', '系统诊断', '从症状、证据和依赖关系定位系统问题。', '先收集只读证据并缩小故障域，再提出可回滚修复；不得把未验证猜测写成根因。'),
  // Theme gap recipes (#129 / #134 reported them; this is the separate change).
  // They are instructions only: the schedule one plans for the existing Task
  // Schedule instead of owning a scheduler, and the audit/review ones are
  // deterministic checks over what is already in the world — nothing fetches.
  recipe('schedule-planning', '日程规划', '把需要定时或重复执行的事规划成可落入现有任务计划的节奏。', '先判断是一次性还是重复执行，再写清标题、要执行的内容、首次时间与时区、重复间隔（重复任务最短五分钟）和执行时的权限模式；这只是给世界已有任务计划的建议，由用户在任务计划里创建并确认，不自行创建也不在对话里口头承诺时间。时间冲突要指出来让用户选，不擅自改期；只报告任务计划里真实存在的状态。'),
  recipe('citation-audit', '引用核验', '逐条核对论断是否指到可回溯的来源，指不到的标为待核实。', '每条论断只认三种可回溯位置：资料与片段、会话与消息，或成果的具体版本；「资料里说过」不算来源。指不到就标为缺来源并停留在待核实，不进结论与图谱；来源内容与论断不一致标为指错来源；两条来源互相冲突时并列保留双方并标出冲突，不用「最新的」或「多数的」替代可靠性判断。不补全没有读到的内容。'),
  recipe('freshness-review', '时效复核', '按追踪节奏检查内容是否过期，超期的标为待复核。', '只做确定性的时间检查：每条内容都必须带来源的绝对时间并标注时区，写「今天」「刚刚」「近期」这类相对说法的一律退回要求改写；超出该追踪线刷新节奏的旧结论标为待复核，不作为当前状况呈现。输出写明本次复核的截至时间；没有变化就写「本轮无新增」，不用旧内容凑数，也不替任何内容补一个时间。'),
  recipe('curriculum-design', '课程设计', '把拆解好的知识点排成课程结构、课时节奏与可检验的学习目标。', '只在知识点已经拆解清楚之后排课程计划；每个课时写明面向的学员基础、时长、覆盖的知识点和可检验的达成目标，课时之间标出前置依赖。如实标出还没有材料支撑的课时和尚未覆盖的知识点，不用篇幅充数，也不替主讲判断学科事实。'),
] as const

export function registerBuiltinSkillRecipes(registry: CharacterSkillAdapterRegistry): void {
  for (const item of BUILTIN_RECIPES) registry.registerRecipe(item)
}

function recipe(id: string, displayName: string, summary: string, instruction: string): CharacterSkillRecipe {
  const input: RecipeInput = { id, displayName, summary, instruction }
  return {
    descriptor: {
      id: input.id,
      displayName: input.displayName,
      summary: input.summary,
      routingHints: [...(ROUTING_HINTS[input.id] ?? [])],
      adapterId: 'builtin.recipe',
      risks: [],
      supportsScheduling: false,
      persistentApproval: 'forbidden',
      kind: 'recipe',
      recommendedByDefault: true,
    },
    instruction: input.instruction,
  }
}

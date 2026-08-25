import type { CharacterSkillDescriptor } from '@dsh-cyber/contracts/skill-runtime'

import type { CharacterSkillAdapterRegistry, CharacterSkillRecipe } from './skill-adapter.js'

type RecipeInput = Pick<CharacterSkillDescriptor, 'id' | 'displayName' | 'summary'> & { instruction: string }

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

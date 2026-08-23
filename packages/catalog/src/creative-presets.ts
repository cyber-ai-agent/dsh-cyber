import type { EmbodimentPresetDescriptor, EmbodimentProfile } from '@dsh-cyber/contracts/creative-platform'

export const BUILTIN_EMBODIMENT_PRESETS: readonly EmbodimentPresetDescriptor[] = [
  preset(
    'general',
    '通用角色',
    '适合顾问、自由角色和暂未确定固定工作区的角色。',
    ['general'], ['public'], ['collaboration'], ['public', 'meeting', 'rest'], ['public'], ['observe-world'],
  ),
  preset(
    'engineering',
    '工程 / 开发',
    '优先工程工位、白板和测试设施。',
    ['engineering', 'coding'], ['engineering'], ['coding', 'testing'], ['engineering', 'meeting', 'rest', 'public'], ['engineering', 'work'], ['inspect-workbench'],
  ),
  preset(
    'research',
    '研究 / 知识',
    '优先研究、资料、档案与分析设施。',
    ['research', 'knowledge'], ['research'], ['research', 'inspect'], ['research', 'meeting', 'rest', 'public'], ['research', 'work'], ['inspect-research-material'],
  ),
  preset(
    'operations',
    '运营 / 数据',
    '优先监控、运营看板和控制设施。',
    ['operations', 'analytics'], ['operations'], ['monitoring', 'analysis'], ['operations', 'meeting', 'rest', 'public'], ['operations', 'work'], ['inspect-dashboard'],
  ),
  preset(
    'administration',
    '行政 / 协调',
    '优先行政桌、档案和会议准备区域。',
    ['administration', 'coordination'], ['administration'], ['schedule', 'coordination'], ['administration', 'meeting', 'rest', 'public'], ['administration', 'work'], ['prepare-meeting'],
  ),
  preset(
    'creative',
    '创作 / 内容',
    '适合编剧、编辑、设计、视频与内容制作角色。',
    ['creative', 'content'], ['creative'], ['create', 'review'], ['creative', 'meeting', 'rest', 'public'], ['creative', 'work'], ['review-creative-board'],
  ),
] as const

export function embodimentPreset(presetId: string): EmbodimentPresetDescriptor | undefined {
  return BUILTIN_EMBODIMENT_PRESETS.find((item) => item.id === presetId)
}

function preset(
  id: string,
  displayName: string,
  description: string,
  roleTags: string[],
  preferredZoneTags: string[],
  preferredFacilityCapabilities: string[],
  allowedZoneTags: string[],
  homeSlotTags: string[],
  ambientBehaviors: string[],
): EmbodimentPresetDescriptor {
  const profile: EmbodimentProfile = {
    roleTags,
    preferredZoneTags,
    preferredFacilityCapabilities,
    allowedZoneTags,
    homeSlotTags,
    ambientBehaviors,
    socialPolicy: {
      canInitiateConversation: false,
      cooldownSeconds: 1_800,
      maxDailyConversations: 0,
    },
  }
  return { id, displayName, description, profile }
}

import type { WorkSessionCollaborationMode } from '@dsh-cyber/contracts'

export interface GroupIntentRoutingInput {
  prompt: string
}

export interface GroupIntentRoutingResult {
  collaborationMode: WorkSessionCollaborationMode
  reason: 'explicit-collaboration' | 'deliverable-request' | 'discussion-request' | 'conversation-default'
}

/**
 * Classifies each group message at ingress so the room does not depend on a
 * user-selected, long-lived mode. The router is deliberately conservative:
 * ambiguous chat remains a discussion, while concrete delivery or execution
 * language enters the task collaboration pipeline.
 *
 * This is a host-owned intent boundary. It chooses between existing
 * provider-neutral orchestration paths and never grants a Skill or executes an
 * adapter by itself.
 */
export class GroupIntentRouter {
  route(input: GroupIntentRoutingInput): GroupIntentRoutingResult {
    const prompt = normalize(input.prompt)
    if (EXPLICIT_COLLABORATION.test(prompt)) {
      return { collaborationMode: 'task', reason: 'explicit-collaboration' }
    }
    if (DISCUSSION_REQUEST.test(prompt)) {
      return { collaborationMode: 'discussion', reason: 'discussion-request' }
    }
    if (DELIVERABLE_REQUEST.test(prompt)) {
      return { collaborationMode: 'task', reason: 'deliverable-request' }
    }
    return { collaborationMode: 'discussion', reason: 'conversation-default' }
  }
}

const EXPLICIT_COLLABORATION = /(?:(?:^|\s)任务[：:]|协作|分工|分头|一起完成|共同完成|并行处理|分别负责|任务拆分|交给.+(?:负责|处理)|coordinate|collaborate|divide\s+the\s+work)/iu
const DELIVERABLE_REQUEST = /(?:请|帮我|需要|立刻|现在|开始)?(?:实现|修复|开发|创建|生成|制作|编写|整理|部署|发布|提交|执行|运行|测试|验证|调查|调研|分析并|设计并|完成|处理)(?:一下|这个|这些|一份|一个|代码|方案|报告|文档|页面|功能|问题|任务)?|(?:implement|fix|build|create|generate|write|deploy|ship|submit|execute|run|test|verify|investigate|deliver)\b/iu
const DISCUSSION_REQUEST = /(?:讨论|聊聊|说说|怎么看|怎么|如何|什么看法|意见|建议|想法|头脑风暴|解释|介绍|为什么|是什么|怎么样|是否|能否|可以吗|吗[？?]?$|[？?]$|discuss|brainstorm|explain|what\s+do\s+you\s+think|why\b|how\b)/iu

function normalize(value: string): string {
  return value.trim().replace(/\s+/gu, ' ')
}

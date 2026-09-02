import type { ContextLayerKind } from '@dsh-cyber/contracts'

/**
 * The reader-facing names of the context layers.
 *
 * Shared by the Inspector and the trace card so one layer is called the same
 * thing wherever its size is shown. `key` is the i18n key; `label` and `hint`
 * are the zh-CN fallbacks the runtime uses when a locale has no entry.
 */
export const CONTEXT_LAYER_LABELS: Record<ContextLayerKind, { key: string; label: string; hint: string }> = {
  'stable-identity': {
    key: 'context.layerIdentity',
    label: '稳定身份',
    hint: '人设、角色资料与已授予的权限，每轮不变，因此可以被缓存。',
  },
  'world-context': {
    key: 'context.layerWorld',
    label: '世界规则',
    hint: '当前世界的设定与运行规则。',
  },
  'task-context': {
    key: 'context.layerTask',
    label: '任务上下文',
    hint: '本次协作的目标、计划步骤与依赖。',
  },
  'memory-index': {
    key: 'context.layerMemoryIndex',
    label: '记忆索引',
    hint: '这一轮里角色“能想起哪些事”的目录。',
  },
  'retrieved-memories': {
    key: 'context.layerRetrieved',
    label: '召回的记忆',
    hint: '真正取回并放进这一轮的历史片段。',
  },
  'recent-conversation': {
    key: 'context.layerRecent',
    label: '最近对话',
    hint: '保留原文重放的最近几轮对话；实时会话可能只重放其中较新的一段。',
  },
  'current-request': {
    key: 'context.layerRequest',
    label: '本次请求',
    hint: '你这一次真正发出的内容。',
  },
}

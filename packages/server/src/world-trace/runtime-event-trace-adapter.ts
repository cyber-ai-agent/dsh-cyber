import type { AgentRuntimeEvent, WorldTraceEntry, WorldTraceStatus } from '@dsh-cyber/contracts'

import { runtimeIdentity, traceId, type RuntimeTraceFact, type WorldTraceAdapter } from './trace-adapter.js'

export class RuntimeEventTraceAdapter implements WorldTraceAdapter<'runtime-event'> {
  readonly kind = 'runtime-event' as const

  adapt({ value }: { kind: 'runtime-event'; value: RuntimeTraceFact }): WorldTraceEntry[] {
    const event = value.event
    if (event.kind === 'reasoning.delta' || event.kind === 'text.delta') return []
    const presentation = runtimePresentation(event)
    const traceTurnId = typeof event.metadata.traceTurnId === 'string' ? event.metadata.traceTurnId : undefined
    const id = runtimeIdentity({ ...event, ...(traceTurnId === undefined ? {} : { traceTurnId }) })
    return [{
      id,
      worldId: value.worldId,
      category: presentation.category,
      status: presentation.status,
      summary: presentation.summary,
      ...(presentation.detail === undefined ? {} : { detail: presentation.detail }),
      actorId: value.actorId,
      sessionId: value.sessionId,
      ...(event.kind.startsWith('turn.') ? { taskId: `turn:${event.sourceSessionId}` } : {}),
      sourceKind: 'runtime-event',
      sourceId: traceId(event.source, event.sourceSessionId, event.sourceSequence, event.kind),
      ...(event.sourceSequence === undefined ? {} : { sourceSequence: event.sourceSequence }),
      createdAt: value.createdAt,
      updatedAt: value.createdAt,
    }]
  }
}

function runtimePresentation(event: AgentRuntimeEvent): {
  category: 'agent' | 'tool'
  status: WorldTraceStatus
  summary: string
  detail?: string
} {
  switch (event.kind) {
    case 'turn.started':
      return { category: 'agent', status: 'running', summary: '角色开始处理请求' }
    case 'turn.completed':
      return { category: 'agent', status: 'success', summary: '角色已完成本轮处理' }
    case 'turn.failed':
      return { category: 'agent', status: 'failed', summary: '角色本轮处理失败' }
    case 'assistant.reasoning':
      return {
        category: 'agent',
        status: 'info',
        summary: '角色生成了推理摘要',
        ...(event.content?.trim() ? { detail: event.content } : {}),
      }
    case 'assistant.message':
      return { category: 'agent', status: 'success', summary: '角色已生成最终回复' }
    case 'tool.started':
      return {
        category: 'tool',
        status: 'running',
        summary: `开始使用工具：${event.toolName ?? '未命名工具'}`,
        ...(event.toolName === undefined ? {} : { detail: event.toolName }),
      }
    case 'tool.completed':
      return {
        category: 'tool',
        status: event.failed ? 'failed' : 'success',
        summary: event.failed ? '工具执行失败' : '工具执行完成',
        ...(event.toolName === undefined ? {} : { detail: event.toolName }),
      }
    case 'reasoning.delta':
    case 'text.delta':
      return { category: 'agent', status: 'info', summary: '运行时增量' }
  }
}

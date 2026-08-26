import type { AgentRuntimeEvent, WorldTraceEntry, WorldTraceStatus } from '@dsh-cyber/contracts'

import { toolDisplayLabel, toolPresentation } from './agent-run-trace-adapter.js'
import { traceId, type RuntimeTraceFact, type WorldTraceAdapter } from './trace-adapter.js'

export class RuntimeEventTraceAdapter implements WorldTraceAdapter<'runtime-event'> {
  readonly kind = 'runtime-event' as const

  adapt({ value }: { kind: 'runtime-event'; value: RuntimeTraceFact }): WorldTraceEntry[] {
    const event = value.event
    if (event.kind === 'reasoning.delta' || event.kind === 'text.delta') return []
    const runId = value.agentRunId ?? stringMetadata(event, 'agentRunId')
      ?? stringMetadata(event, 'traceTurnId') ?? `${event.source}:${event.sourceSessionId}`
    const presentation = runtimePresentation(event)
    const entry: WorldTraceEntry = {
      id: traceId('agent-run', runId),
      worldId: value.worldId,
      category: event.kind.startsWith('tool.') ? 'tool' : 'agent',
      status: presentation.status,
      summary: presentation.summary,
      actorId: value.actorId,
      sessionId: value.sessionId,
      ...(value.workTurnId === undefined ? {} : { taskId: `turn:${value.workTurnId}`, workTurnId: value.workTurnId }),
      sourceKind: 'agent-run',
      sourceId: runId,
      ...(event.sourceSequence === undefined ? {} : { sourceSequence: event.sourceSequence }),
      createdAt: value.createdAt,
      updatedAt: value.createdAt,
    }
    if (event.kind === 'assistant.reasoning' && event.content?.trim()) entry.reasoningSummary = event.content.trim()
    if (event.kind === 'tool.started' || event.kind === 'tool.completed') {
      const callId = event.callId ?? `event-${event.sourceSequence ?? value.createdAt}`
      const presentation = toolPresentation(event.toolName)
      entry.tools = [{
        callId,
        ...(event.toolName === undefined ? {} : { name: event.toolName }),
        ...presentation,
        status: event.kind === 'tool.started' ? 'running' : event.failed ? 'failed' : 'success',
        ...(event.kind === 'tool.started' ? { createdAt: value.createdAt } : { completedAt: value.createdAt }),
      }]
    }
    const usage = tokenUsage(event)
    if (usage !== undefined) entry.tokenUsage = usage
    return [entry]
  }
}

function runtimePresentation(event: AgentRuntimeEvent): { status: WorldTraceStatus; summary: string } {
  switch (event.kind) {
    case 'turn.started': return { status: 'running', summary: '正在分析请求' }
    case 'turn.completed': return { status: 'success', summary: '完成本轮分析与回复' }
    case 'turn.failed': return { status: 'failed', summary: '本轮处理失败' }
    case 'assistant.reasoning': return { status: 'running', summary: '正在整理判断依据' }
    case 'assistant.message': return { status: 'running', summary: '正在生成最终回复' }
    case 'approval.requested': return { status: 'waiting', summary: `等待批准${toolDisplayLabel(event.toolName)}` }
    case 'approval.decided': return {
      status: event.failed ? 'cancelled' : 'running',
      summary: event.failed ? '操作审批已关闭' : '操作已批准，继续执行',
    }
    case 'tool.started': return { status: 'running', summary: `正在${toolDisplayLabel(event.toolName)}` }
    case 'tool.completed': return {
      status: event.failed ? 'failed' : 'running',
      summary: event.failed ? `${toolDisplayLabel(event.toolName)}失败` : `${toolDisplayLabel(event.toolName)}完成`,
    }
    case 'reasoning.delta':
    case 'text.delta': return { status: 'running', summary: '正在处理' }
  }
}

function stringMetadata(event: AgentRuntimeEvent, key: string): string | undefined {
  const value = event.metadata[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function tokenUsage(event: AgentRuntimeEvent) {
  const prompt = event.metadata.tokensPrompt
  const completion = event.metadata.tokensCompletion
  const total = event.metadata.tokensTotal
  return typeof prompt === 'number' && typeof completion === 'number' && typeof total === 'number'
    ? { prompt, completion, total }
    : undefined
}

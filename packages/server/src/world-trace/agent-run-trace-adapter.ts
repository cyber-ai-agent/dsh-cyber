import type {
  AgentRunStatus,
  WorkMessage,
  WorldTraceEntry,
  WorldTraceStatus,
  WorldTraceToolStep,
} from '@dsh-cyber/contracts'

import { traceId, type AgentRunTraceFact, type WorldTraceAdapter } from './trace-adapter.js'

export class AgentRunTraceAdapter implements WorldTraceAdapter<'agent-run'> {
  readonly kind = 'agent-run' as const

  adapt({ value }: { kind: 'agent-run'; value: AgentRunTraceFact }): WorldTraceEntry[] {
    const { run, interaction } = value
    const runMessages = value.messages.filter((message) => belongsToRun(message, run.id))
    const reasoningSummary = runMessages
      .filter((message) => message.kind === 'reasoning')
      .map((message) => message.content.trim())
      .filter(Boolean)
      .join('\n\n')
    const tools = buildToolSteps(runMessages)
    const createdAt = run.startedAt ?? run.createdAt
    const updatedAt = run.completedAt ?? interaction?.createdAt ?? createdAt
    const entry: WorldTraceEntry = {
      id: traceId('agent-run', run.id),
      worldId: value.worldId,
      category: tools.length > 0 ? 'tool' : 'agent',
      status: traceStatus(run.status),
      summary: traceSummary(run.status, tools.length),
      actorId: run.employeeId,
      sessionId: run.sessionId,
      taskId: `turn:${run.turnId}`,
      workTurnId: run.turnId,
      sourceKind: 'agent-run',
      sourceId: run.id,
      createdAt,
      updatedAt,
    }
    if (reasoningSummary) entry.reasoningSummary = reasoningSummary
    if (tools.length > 0) entry.tools = tools
    if (run.errorCode) entry.detail = friendlyRunError(run.errorCode)
    if (interaction !== undefined) {
      entry.durationMs = interaction.durationMs
      entry.modelId = interaction.modelId
      entry.provider = interaction.provider
      if (interaction.tokensPrompt !== undefined &&
        interaction.tokensCompletion !== undefined &&
        interaction.tokensTotal !== undefined) {
        entry.tokenUsage = {
          prompt: interaction.tokensPrompt,
          completion: interaction.tokensCompletion,
          total: interaction.tokensTotal,
        }
      }
    }
    return [entry]
  }
}

function belongsToRun(message: WorkMessage, runId: string): boolean {
  return message.metadata.agentRunId === runId || message.metadata.traceTurnId === runId
}

function buildToolSteps(messages: readonly WorkMessage[]): WorldTraceToolStep[] {
  const steps = new Map<string, WorldTraceToolStep>()
  for (const message of messages) {
    if (message.kind !== 'tool-call' && message.kind !== 'tool-result') continue
    const callId = stringMetadata(message, 'callId') ?? message.id
    const current = steps.get(callId)
    if (message.kind === 'tool-call') {
      const name = stringMetadata(message, 'toolName') ?? (message.content.trim() || undefined)
      steps.set(callId, {
        callId,
        ...(name === undefined ? {} : { name }),
        label: toolDisplayLabel(name),
        status: current?.status ?? 'running',
        createdAt: message.createdAt,
        ...(current?.completedAt === undefined ? {} : { completedAt: current.completedAt }),
      })
      continue
    }
    const failed = message.metadata.failed === true
    steps.set(callId, {
      callId,
      ...(current?.name === undefined ? {} : { name: current.name }),
      label: current?.label ?? '执行工具',
      status: failed ? 'failed' : 'success',
      ...(current?.createdAt === undefined ? {} : { createdAt: current.createdAt }),
      completedAt: message.createdAt,
    })
  }
  return [...steps.values()]
}

function stringMetadata(message: WorkMessage, key: string): string | undefined {
  const value = message.metadata[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function toolDisplayLabel(name: string | undefined): string {
  if (!name) return '执行工具'
  const normalized = name.toLowerCase()
  if (/search|web|firecrawl/.test(normalized)) return '搜索并核对网络信息'
  if (/read|open|view|get/.test(normalized)) return '读取信息'
  if (/write|edit|patch|update/.test(normalized)) return '更新内容'
  if (/shell|command|terminal|exec/.test(normalized)) return '执行工作区命令'
  if (/browser|click|navigate/.test(normalized)) return '操作浏览器'
  if (/file|list|glob/.test(normalized)) return '检查文件'
  return `调用 ${name}`
}

function traceStatus(status: AgentRunStatus): WorldTraceStatus {
  if (status === 'completed') return 'success'
  if (status === 'failed' || status === 'interrupted') return 'failed'
  if (status === 'running' || status === 'queued') return 'running'
  return 'info'
}

function traceSummary(status: AgentRunStatus, toolCount: number): string {
  if (status === 'completed') return toolCount > 0 ? `完成处理，调度了 ${toolCount} 个工具` : '完成本轮分析与回复'
  if (status === 'failed') return '本轮处理失败'
  if (status === 'interrupted') return '用户停止执行'
  if (status === 'queued') return '等待开始处理'
  return toolCount > 0 ? `正在处理，已调度 ${toolCount} 个工具` : '正在分析请求'
}

function friendlyRunError(code: string): string {
  const labels: Record<string, string> = {
    'service-restarted': '本地服务重启，本轮运行已安全结束。',
    timeout: '模型或工具响应超时。',
    authentication: '模型服务认证失败。',
    'rate-limited': '模型服务请求过于频繁。',
    'model-not-found': '当前模型不可用。',
    interrupted: '本轮运行被中断。',
  }
  return labels[code] ?? '本轮运行未能完成，请在会话中重试。'
}

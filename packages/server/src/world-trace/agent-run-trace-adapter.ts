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
      // Only a real WorkTask reaches the card. A run outside any task carries
      // no task field, so a task filter can never match it by accident.
      ...(value.task === undefined ? {} : { taskId: value.task.id, taskTitle: value.task.title }),
      workTurnId: run.turnId,
      // The durable AgentRun id. Without it nothing downstream — an Artifact
      // link, the Context view — can get from a trace card back to the run.
      runId: run.id,
      sourceKind: 'agent-run',
      sourceId: run.id,
      createdAt,
      updatedAt,
    }
    // Absent reasoning stays absent. A run whose runtime published no public
    // summary must render as having none, never as invented narrative.
    if (reasoningSummary) entry.reasoningSummary = reasoningSummary
    if (tools.length > 0) entry.tools = tools
    if (value.artifacts !== undefined && value.artifacts.length > 0) entry.artifacts = value.artifacts
    // Numbers only. A run without a snapshot has no context field, and the
    // renderer says so; it must not draw an empty layer chart.
    if (value.context !== undefined) entry.context = value.context
    if (run.errorCode || interaction?.status === 'failed') entry.detail = friendlyRunError(run.errorCode, interaction)
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
      const presentation = toolPresentation(name)
      steps.set(callId, {
        callId,
        ...(name === undefined ? {} : { name }),
        ...presentation,
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
  return toolPresentation(name).label
}

export function toolPresentation(name: string | undefined): Pick<WorldTraceToolStep, 'label' | 'description'> {
  if (!name) return { label: '执行工具', description: '运行时未提供工具名称' }
  const normalized = name.toLowerCase()
  if (/firecrawl|web[_-]?search|search[_-]?query/.test(normalized)) return { label: '搜索网络信息', description: '检索公开网页和来源，获取与当前任务相关的信息' }
  if (/search|find[_-]?(text|content)|ripgrep|\brg\b/.test(normalized)) return { label: '查找内容', description: '在可访问的数据或文件中定位相关内容' }
  if (/apply[_-]?patch|patch|edit|replace|update[_-]?file/.test(normalized)) return { label: '修改文件内容', description: '按任务要求更新已有文件中的指定内容' }
  if (/write|create[_-]?file|save/.test(normalized)) return { label: '写入文件', description: '创建文件或保存新的文件内容' }
  if (/read[_-]?file|open[_-]?file|view[_-]?file/.test(normalized)) return { label: '读取文件', description: '读取文件内容用于分析或处理' }
  if (/shell|command|terminal|exec/.test(normalized)) return { label: '执行本地命令', description: '在当前权限范围内运行命令或开发工具' }
  if (/browser|click|navigate|screenshot/.test(normalized)) return { label: '操作浏览器', description: '打开、检查或操作网页界面' }
  if (/glob|list[_-]?(file|dir)|directory|file/.test(normalized)) return { label: '检查文件', description: '查看目录或文件列表，确认工作区内容' }
  if (/read|open|view|get|fetch/.test(normalized)) return { label: '读取信息', description: '读取当前任务所需的信息' }
  return { label: `调用 ${name}`, description: `使用运行时工具 ${name} 完成当前步骤` }
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

function friendlyRunError(
  code: string | undefined,
  interaction: AgentRunTraceFact['interaction'],
): string {
  const signal = [code, interaction?.errorCode, interaction?.errorMessage, interaction?.httpStatus]
    .filter((value) => value !== undefined)
    .join(' ')
    .toLocaleLowerCase('en-US')
  if (/service[-_ ]?restarted/.test(signal)) return '本地服务重启，本轮运行已安全结束。'
  if (interaction?.httpStatus === 429 || /rate[-_ ]?limit|too many requests|quota/.test(signal)) {
    return /all available accounts/.test(signal)
      ? '模型服务当前限流，上游暂无可用账户。请稍后重试或切换模型。'
      : '模型服务当前限流。请稍后重试、检查服务商额度，或切换模型。'
  }
  if (interaction?.httpStatus === 401 || interaction?.httpStatus === 403 || /auth|api[-_ ]?key|credential|forbidden/.test(signal)) {
    return '模型服务认证失败。请在“设置 → AI 模型”检查密钥和接口权限。'
  }
  if (interaction?.httpStatus === 404 || /model[-_ ]?not[-_ ]?found|unknown[-_ ]?model/.test(signal)) {
    return '当前模型不存在或无权访问。请重新获取模型列表并选择可用模型。'
  }
  if (interaction?.httpStatus === 408 || interaction?.httpStatus === 504 || /timeout|timed out|etimedout/.test(signal)) {
    return '模型服务响应超时。请检查兼容接口状态后重试；长推理可切换到响应更稳定的模型。'
  }
  if (/econn|network|socket|connection|unreachable|bad gateway|service unavailable/.test(signal)) {
    return '模型服务连接中断。请检查网络和兼容接口状态后重试。'
  }
  if (/interrupt|abort|user[-_ ]?stop/.test(signal)) return '本轮运行被中断。'
  return '模型服务未能完成本轮请求。请查看模型交互日志后重试。'
}

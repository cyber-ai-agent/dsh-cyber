import type { WorldTraceEntry } from '@dsh-cyber/contracts'

import { traceId, type ConsolidationTraceFact, type WorldTraceAdapter } from './trace-adapter.js'

const ERROR_LABELS: Record<string, string> = {
  knowledge_model_timeout: '模型响应超时',
  knowledge_model_unreachable: '无法连接模型服务',
  knowledge_model_unconfigured: '尚未配置可用模型',
  knowledge_model_response_invalid: '模型没有返回可用内容',
  knowledge_model_response_too_large: '模型响应过大',
  knowledge_model_response_empty: '模型返回了空响应',
  knowledge_model_rate_limited: '模型服务限流',
  knowledge_model_upstream_error: '模型服务上游错误',
  knowledge_model_credential_rejected: '模型密钥被拒绝',
  knowledge_model_not_found: '模型或接口不存在',
  knowledge_model_url_invalid: '模型接口地址无效',
  knowledge_model_rejected: '模型服务拒绝了请求',
  extraction_json_invalid: '模型输出不是有效 JSON',
  extraction_field_required: '模型输出缺少必需字段',
  extraction_enum_invalid: '模型输出了不支持的取值',
  extraction_shape_invalid: '模型输出结构无效',
  extraction_array_invalid: '模型输出数组无效',
  extraction_text_invalid: '模型输出文本无效',
  extraction_output_too_large: '模型输出过长',
}

const SOURCE_LABELS: Record<string, string> = {
  conversation: '群聊会话',
  document: '文档',
  artifact: '产物',
}

export function consolidationErrorLabel(code: string | undefined): string {
  if (code === undefined) return '未知错误'
  return ERROR_LABELS[code] ?? code.slice(0, 40)
}

/**
 * Failed knowledge consolidation jobs projected into the world trace.
 *
 * Before this, the background pipeline could be dying on every turn and the
 * only evidence was a row in the model usage log. A failure is world activity
 * the owner should see where the facts belong.
 */
export class ConsolidationTraceAdapter implements WorldTraceAdapter<'consolidation'> {
  readonly kind = 'consolidation' as const

  adapt({ value }: { kind: 'consolidation'; value: ConsolidationTraceFact }): WorldTraceEntry[] {
    return [{
      id: traceId('consolidation', value.jobId),
      worldId: value.worldId,
      category: 'system',
      status: 'failed',
      summary: `知识整理失败：${consolidationErrorLabel(value.errorCode)}`,
      detail: `来源：${SOURCE_LABELS[value.sourceType] ?? value.sourceType}；第 ${value.attempt} 次尝试。可在知识面板中查看任务并重试。`,
      sourceKind: 'consolidation',
      sourceId: value.jobId,
      createdAt: value.updatedAt,
      updatedAt: value.updatedAt,
    }]
  }
}

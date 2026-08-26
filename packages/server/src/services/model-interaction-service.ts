import type {
  AgentRuntimeEvent,
  AgentRuntimePort,
  AgentTurnRequest,
  AgentTurnResult,
  ModelInteractionLog,
  ModelInteractionLogFilter,
  ModelInteractionLogPage,
  ModelInteractionLogStatus,
} from '@dsh-cyber/contracts'
import type { HarnessModelRoute } from '@dsh-cyber/harness-adapter'
import type { SqliteStore } from '@dsh-cyber/persistence'

/**
 * 模型交互日志服务。
 *
 * 隐私红线（与 AGENTS.md 一致）：本服务只持久化请求摘要统计（消息数 / 字符数）、
 * 可读错误信息与 token 用量（仅接口返回时）。绝不写入 API 密钥、prompt 明文或
 * 响应明文。错误信息在落库前统一经过敏感内容清洗。
 */
export class ModelInteractionService {
  readonly #store: SqliteStore

  constructor(store: SqliteStore) {
    this.#store = store
  }

  /**
   * 记录一次对话回合级交互（source='turn'）。
   * 观测边界：模型 API 请求发生在 DSH worker 内部，服务端只能观测整轮交互
   * （开始时间、worker 返回的成功/失败、耗时、工具调用次数、最终响应摘要）。
   * 消息数按「1 条用户 prompt + 每轮工具回填 1 条」统计。Token 只记录 Harness
   * 明确返回的真实用量，不做字符数估算。
   */
  recordTurn(input: RecordTurnInteractionInput): ModelInteractionLog {
    return this.#store.recordModelInteraction({
      workspaceId: input.workspaceId,
      ...(input.worldId === undefined ? {} : { worldId: input.worldId }),
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      ...(input.employeeId === undefined ? {} : { employeeId: input.employeeId }),
      ...(input.workTurnId === undefined ? {} : { workTurnId: input.workTurnId }),
      ...(input.agentRunId === undefined ? {} : { agentRunId: input.agentRunId }),
      source: 'turn',
      modelId: input.modelId,
      provider: input.provider,
      status: input.status,
      ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
      ...(input.errorMessage === undefined ? {} : { errorMessage: sanitizeErrorMessage(input.errorMessage) }),
      ...(input.httpStatus === undefined ? {} : { httpStatus: input.httpStatus }),
      promptMessageCount: 1 + (input.toolCallCount ?? 0),
      promptCharCount: input.prompt.length,
      ...(input.responseCharCount === undefined ? {} : { responseCharCount: input.responseCharCount }),
      ...(input.toolCallCount === undefined ? {} : { toolCallCount: input.toolCallCount }),
      durationMs: input.durationMs,
      ...(input.tokenUsage === undefined ? {} : {
        tokensPrompt: input.tokenUsage.prompt,
        tokensCompletion: input.tokenUsage.completion,
        tokensTotal: input.tokenUsage.total,
      }),
    })
  }

  /**
   * 记录一次 /models 模型发现交互（source='discovery'）。GET 请求无 prompt，
   * 请求摘要保持为 0，耗时与状态反映真实 HTTP 往返。
   */
  recordDiscovery(input: RecordDiscoveryInteractionInput): ModelInteractionLog {
    return this.#store.recordModelInteraction({
      workspaceId: input.workspaceId,
      source: 'discovery',
      modelId: input.modelId,
      provider: input.provider,
      status: input.status,
      ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
      ...(input.errorMessage === undefined ? {} : { errorMessage: sanitizeErrorMessage(input.errorMessage) }),
      ...(input.httpStatus === undefined ? {} : { httpStatus: input.httpStatus }),
      promptMessageCount: 0,
      promptCharCount: 0,
      durationMs: input.durationMs,
    })
  }

  /**
   * Records one background semantic extraction without storing source text,
   * extraction instructions or the model response.
   */
  recordKnowledge(input: RecordKnowledgeInteractionInput): ModelInteractionLog {
    return this.#store.recordModelInteraction({
      workspaceId: input.workspaceId,
      worldId: input.worldId,
      source: 'knowledge',
      modelId: input.modelId,
      provider: input.provider,
      status: input.status,
      ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
      ...(input.errorMessage === undefined ? {} : { errorMessage: sanitizeErrorMessage(input.errorMessage) }),
      ...(input.httpStatus === undefined ? {} : { httpStatus: input.httpStatus }),
      promptMessageCount: 1,
      promptCharCount: input.promptCharCount,
      responseCharCount: input.responseCharCount,
      toolCallCount: 0,
      durationMs: input.durationMs,
      ...(input.tokensPrompt === undefined ? {} : { tokensPrompt: input.tokensPrompt }),
      ...(input.tokensCompletion === undefined ? {} : { tokensCompletion: input.tokensCompletion }),
      ...(input.tokensPrompt === undefined && input.tokensCompletion === undefined ? {} : {
        tokensTotal: (input.tokensPrompt ?? 0) + (input.tokensCompletion ?? 0),
      }),
    })
  }

  list(workspaceId: string, filter: ModelInteractionLogFilter): ModelInteractionLogPage {
    return this.#store.listModelInteractions(workspaceId, filter)
  }

  get(interactionId: string): ModelInteractionLog | undefined {
    return this.#store.getModelInteraction(interactionId)
  }

  clear(workspaceId: string): number {
    return this.#store.clearModelInteractions(workspaceId)
  }
}

export interface RecordTurnInteractionInput {
  workspaceId: string
  worldId?: string
  sessionId?: string
  employeeId?: string
  workTurnId?: string
  agentRunId?: string
  modelId: string
  provider: string
  status: ModelInteractionLogStatus
  errorCode?: string
  errorMessage?: string
  httpStatus?: number
  prompt: string
  responseCharCount?: number
  toolCallCount?: number
  durationMs: number
  tokenUsage?: AgentTurnResult['tokenUsage']
}

export interface RecordDiscoveryInteractionInput {
  workspaceId: string
  modelId: string
  provider: string
  status: ModelInteractionLogStatus
  errorCode?: string
  errorMessage?: string
  httpStatus?: number
  durationMs: number
}

export interface RecordKnowledgeInteractionInput {
  workspaceId: string
  worldId: string
  modelId: string
  provider: string
  status: ModelInteractionLogStatus
  errorCode?: string
  errorMessage?: string
  httpStatus?: number
  promptCharCount: number
  responseCharCount: number
  durationMs: number
  tokensPrompt?: number
  tokensCompletion?: number
}

/**
 * 包一层 AgentRuntimePort：在真实回合前后记录模型交互日志，不改动业务语义。
 * 未配置模型路由时（route 为 undefined，走默认 DSH 模型）同样记录，便于排查。
 */
export class TurnInteractionLoggingRuntime implements AgentRuntimePort {
  readonly #inner: AgentRuntimePort
  readonly #service: ModelInteractionService
  readonly #resolveRoute: (request: AgentTurnRequest) => HarnessModelRoute | undefined

  constructor(options: {
    inner: AgentRuntimePort
    service: ModelInteractionService
    resolveRoute: (request: AgentTurnRequest) => HarnessModelRoute | undefined
  }) {
    this.#inner = options.inner
    this.#service = options.service
    this.#resolveRoute = options.resolveRoute
  }

  async runTurn(request: AgentTurnRequest): Promise<AgentTurnResult> {
    const startedAt = Date.now()
    const route = this.#resolveRoute(request)
    const modelId = route?.modelId ?? 'dsh-default'
    const provider = route?.displayName ?? '默认 DSH 模型'
    let toolCallCount = 0
    let turnFailedCode: string | undefined
    let turnFailedMessage: string | undefined
    let turnFailedHttpStatus: number | undefined
    const wrapped: AgentTurnRequest = {
      ...request,
      onEvent: (event: AgentRuntimeEvent) => {
        if (event.kind === 'tool.started') toolCallCount += 1
        if (event.kind === 'turn.failed') {
          const code = event.metadata.errorCode
          if (typeof code === 'string' && code.trim()) turnFailedCode = code.trim()
          const message = event.metadata.error
          if (typeof message === 'string' && message.trim()) turnFailedMessage = message.trim()
          const status = event.metadata.status ?? event.metadata.httpStatus
          if (typeof status === 'number') turnFailedHttpStatus = status
          else if (typeof status === 'string') {
            const parsed = Number.parseInt(status, 10)
            if (Number.isInteger(parsed)) turnFailedHttpStatus = parsed
          }
        }
        request.onEvent?.(event)
      },
    }
    const traceContext = {
      sessionId: request.conversationId,
      ...(request.workTurnId === undefined ? {} : { workTurnId: request.workTurnId }),
      ...(request.agentRunId === undefined ? {} : { agentRunId: request.agentRunId }),
    }
    try {
      const result = await this.#inner.runTurn(wrapped)
      // worker 返回 turn.failed 事件但 runTurn 未抛异常时（如空回复），
      // 按失败记录，否则 502 类错误在日志里会漏掉。
      if (turnFailedCode !== undefined || turnFailedMessage !== undefined || turnFailedHttpStatus !== undefined) {
        this.#service.recordTurn({
          workspaceId: request.agent.workspaceId,
          worldId: request.agent.worldId,
          employeeId: request.agent.id,
          ...traceContext,
          modelId,
          provider,
          status: 'failed',
          errorCode: turnFailedCode ?? classifyTurnFailure(turnFailedMessage ?? ''),
          ...(turnFailedMessage === undefined ? {} : { errorMessage: turnFailedMessage }),
          ...(turnFailedHttpStatus === undefined ? {} : { httpStatus: turnFailedHttpStatus }),
          prompt: request.prompt,
          responseCharCount: result.finalResponse.length,
          toolCallCount,
          durationMs: Date.now() - startedAt,
          ...(result.tokenUsage === undefined ? {} : { tokenUsage: result.tokenUsage }),
        })
        return result
      }
      this.#service.recordTurn({
        workspaceId: request.agent.workspaceId,
        worldId: request.agent.worldId,
        employeeId: request.agent.id,
        ...traceContext,
        modelId,
        provider,
        status: 'success',
        prompt: request.prompt,
        responseCharCount: result.finalResponse.length,
        toolCallCount,
        durationMs: Date.now() - startedAt,
        ...(result.tokenUsage === undefined ? {} : { tokenUsage: result.tokenUsage }),
      })
      return result
    } catch (error) {
      const errorMessage = turnFailedMessage ?? errorMessageText(error)
      const httpStatus = turnFailedHttpStatus ?? extractHttpStatus(error)
      this.#service.recordTurn({
        workspaceId: request.agent.workspaceId,
        worldId: request.agent.worldId,
        employeeId: request.agent.id,
        ...traceContext,
        modelId,
        provider,
        status: 'failed',
        errorCode: turnFailedCode ?? classifyTurnFailure(error),
        ...(errorMessage === '' ? {} : { errorMessage }),
        ...(httpStatus === undefined ? {} : { httpStatus }),
        prompt: request.prompt,
        toolCallCount,
        durationMs: Date.now() - startedAt,
      })
      throw error
    }
  }

  closeAgent(agentId: string): Promise<void> {
    return this.#inner.closeAgent?.(agentId) ?? Promise.resolve()
  }

  abortRun(agentRunId: string): Promise<void> {
    return this.#inner.abortRun?.(agentRunId) ?? Promise.resolve()
  }

  decideApproval(agentRunId: string, approvalRequestId: string, decision: 'approved' | 'rejected'): Promise<void> {
    return this.#inner.decideApproval?.(agentRunId, approvalRequestId, decision)
      ?? Promise.reject(new Error('当前运行时未提供动作审批能力'))
  }

  async close(): Promise<void> {
    await this.#inner.close()
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close()
  }
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(?:api[_-]?key|access[_-]?token|secret|password)\b\s*[=:]\s*["']?[A-Za-z0-9._-]{8,}/gi,
]

function sanitizeErrorMessage(value: unknown): string {
  let text = friendlyRuntimeErrorMessage(value)
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, '[已隐藏]')
  return text.slice(0, 500)
}

export function friendlyRuntimeErrorMessage(value: unknown): string {
  const text = errorMessageText(value)
  const normalized = text.toLowerCase()
  if (
    normalized.includes('id collision')
    && (normalized.includes('persisted log') || normalized.includes('already persisted'))
  ) {
    return '本地模型会话恢复时发现历史记录冲突。系统会自动建立新的安全会话；请重新发送当前消息。如果仍然失败，请重启本地服务后再试。'
  }
  return text
}

function errorMessageText(value: unknown): string {
  const raw = value instanceof Error
    ? value.message
    : value === null || value === undefined
      ? ''
      : String(value)
  return raw.trim().slice(0, 500)
}

export function classifyTurnFailure(value: unknown): string {
  const signal = value instanceof Error
    ? `${value.name} ${value.message}`
    : value !== null && typeof value === 'object'
      ? Object.values(value).filter((item) => typeof item === 'string' || typeof item === 'number').join(' ')
      : String(value ?? '')
  const normalized = signal.toLowerCase()
  if (/id collision/.test(normalized) && /persisted log|already persisted/.test(normalized)) return 'session-recovery'
  if (/401|403|unauthori[sz]ed|forbidden|authentication|invalid[_ -]?api[_ -]?key|credential/.test(normalized)) return 'authentication'
  if (/404|model[_ -]?not[_ -]?found|unknown[_ -]?model|invalid[_ -]?model/.test(normalized)) return 'model-not-found'
  if (/429|rate[_ -]?limit|too many requests|quota/.test(normalized)) return 'rate-limited'
  if (/timeout|timed out|abort/.test(normalized)) return 'timeout'
  if (/econn|enotfound|network|fetch failed|connection|socket|dns/.test(normalized)) return 'unreachable'
  return 'unknown'
}

/**
 * 从错误对象或错误文本里尽力提取 HTTP 状态码。
 * 支持：Error 上的 status/statusCode/code（数字或"502"字符串）、
 * 错误文本里的 "status: 502" / "HTTP 502" / "(502)" 等常见形态。
 */
export function extractHttpStatus(value: unknown): number | undefined {
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    for (const key of ['status', 'statusCode', 'httpStatus', 'code']) {
      const candidate = record[key]
      if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 100 && candidate <= 599) {
        return candidate
      }
      if (typeof candidate === 'string') {
        const parsed = Number.parseInt(candidate, 10)
        if (Number.isInteger(parsed) && parsed >= 100 && parsed <= 599) return parsed
      }
    }
  }
  const text = errorMessageText(value)
  const patterns = [
    /\b(?:status|http)[^\d]{0,12}(\d{3})\b/i,
    /\bHTTP(?:\/[\d.]+)?\s+(\d{3})\b/i,
    /\((\d{3})\)/,
    /\b(\d{3})\b(?=\s|$)/,
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(text)
    if (match !== null) {
      const status = Number.parseInt(match[1]!, 10)
      if (status >= 100 && status <= 599) return status
    }
  }
  return undefined
}

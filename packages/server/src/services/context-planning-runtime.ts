import { planContextBudget, type AgentRuntimePort, type AgentTurnRequest, type AgentTurnResult } from '@dsh-cyber/contracts'

export interface ContextModelLimits {
  contextWindow?: number
  maxOutputTokens?: number
}

export function contextModelLimits(route: { contextWindow?: number; maxTokens?: number } | undefined): ContextModelLimits | undefined {
  return route === undefined ? undefined : {
    ...(route.contextWindow === undefined ? {} : { contextWindow: route.contextWindow }),
    ...(route.maxTokens === undefined ? {} : { maxOutputTokens: route.maxTokens }),
  }
}

export class ContextPlanningRuntime implements AgentRuntimePort {
  constructor(
    private readonly inner: AgentRuntimePort,
    private readonly resolveLimits: (request: AgentTurnRequest) => ContextModelLimits | undefined,
  ) {}

  runTurn(request: AgentTurnRequest): Promise<AgentTurnResult> {
    if (request.contextBudget !== undefined) return this.inner.runTurn(request)
    const limits = this.resolveLimits(request)
    const contextBudget = planContextBudget({
      ...(limits?.contextWindow === undefined ? {} : { contextWindow: limits.contextWindow }),
      ...(limits?.maxOutputTokens === undefined ? {} : { maxOutputTokens: limits.maxOutputTokens }),
      fixedText: [request.revision.persona, request.prompt],
    })
    return this.inner.runTurn({ ...request, contextBudget })
  }

  close(): Promise<void> { return this.inner.close() }
  closeAgent(agentId: string): Promise<void> { return this.inner.closeAgent?.(agentId) ?? Promise.resolve() }
  abortRun(agentRunId: string): Promise<void> { return this.inner.abortRun?.(agentRunId) ?? Promise.resolve() }
  decideApproval(agentRunId: string, approvalRequestId: string, decision: 'approved' | 'rejected'): Promise<void> {
    return this.inner.decideApproval?.(agentRunId, approvalRequestId, decision)
      ?? Promise.reject(new Error('当前运行时未提供动作审批能力'))
  }
}

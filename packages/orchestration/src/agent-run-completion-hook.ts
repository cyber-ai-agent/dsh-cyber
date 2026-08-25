import type { JsonObject } from '@dsh-cyber/contracts'

/**
 * Provider-neutral completion context.  The orchestration package owns the
 * lifecycle seam, but knows nothing about how a host publishes artifacts (or
 * any other durable completion contribution).
 */
export interface AgentRunCompletionContext {
  workspaceId: string
  worldId: string
  employeeId: string
  sessionId: string
  workTurnId: string
  agentRunId: string
  workspacePath: string
}

/**
 * Contributions are deliberately small and JSON-safe.  `artifactRefs` are
 * durable host IDs, never source paths.  `messageMetadata` is merged into the
 * assistant WorkMessage immediately before it is appended.
 */
export interface AgentRunCompletionContribution {
  artifactRefs?: string[]
  messageMetadata?: JsonObject
}

export interface AgentRunCompletionHook {
  onCompleted(context: AgentRunCompletionContext): Promise<AgentRunCompletionContribution>
}

/** A no-op default keeps orchestration usable without the Server package. */
export const NOOP_AGENT_RUN_COMPLETION_HOOK: AgentRunCompletionHook = {
  async onCompleted(): Promise<AgentRunCompletionContribution> {
    return {}
  },
}


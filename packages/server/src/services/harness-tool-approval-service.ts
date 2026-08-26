import type {
  AgentRuntimePort,
  ApprovalRequest,
  ApprovalRequestView,
  ApprovalRisk,
  JsonObject,
} from '@dsh-cyber/contracts'
import type { ConversationRealtimeEnvelope } from '@dsh-cyber/orchestration'
import type { SqliteStore } from '@dsh-cyber/persistence'

import { toolDisplayLabel } from '../world-trace/agent-run-trace-adapter.js'
import { TraceSanitizer } from '../world-trace/trace-sanitizer.js'

const APPROVAL_TTL_MS = 10 * 60 * 1_000

interface ToolApprovalDetails {
  toolName: string
  callId?: string
  reason?: string
}

/** Owns the live bridge between a persisted approval card and one paused DSH tool call. */
export class HarnessToolApprovalService {
  readonly #store: SqliteStore
  readonly #runtime: AgentRuntimePort
  readonly #details = new Map<string, ToolApprovalDetails>()
  readonly #settling = new Set<string>()
  readonly #sanitizer = new TraceSanitizer()
  readonly #onChanged: (worldId: string, payload: JsonObject) => void
  readonly #expiryTimer: NodeJS.Timeout

  constructor(options: {
    store: SqliteStore
    runtime: AgentRuntimePort
    onChanged?: (worldId: string, payload: JsonObject) => void
  }) {
    this.#store = options.store
    this.#runtime = options.runtime
    this.#onChanged = options.onChanged ?? (() => undefined)

    // A worker restart ends every in-turn question. Close stale cards so a
    // later click cannot appear to authorize an action that has no live call.
    for (const world of this.#store.listWorkspaces().flatMap((workspace) => this.#store.listWorlds(workspace.id))) {
      for (const request of this.#store.listWorldApprovalRequests(world.id, 'pending')) {
        if (request.subjectType === 'tool-call') {
          this.#store.decideApprovalRequest(request.id, 'rejected', 'once', 'system')
        }
      }
    }
    this.#expiryTimer = setInterval(() => { void this.#settleExpired() }, 1_000)
    this.#expiryTimer.unref?.()
  }

  close(): void { clearInterval(this.#expiryTimer) }

  capture(envelope: ConversationRealtimeEnvelope): ApprovalRequest | undefined {
    const approvalRequestId = stringValue(envelope.event.metadata.approvalRequestId)
    if (approvalRequestId === undefined) return undefined
    if (envelope.event.kind === 'approval.decided') {
      const current = this.#store.getApprovalRequestBySubject('tool-call', approvalRequestId)
      if (current?.status === 'pending') {
        const request = this.#store.decideApprovalRequest(current.id, 'rejected', 'once', 'system')
        this.#details.delete(approvalRequestId)
        this.#onChanged(envelope.worldId, {
          kind: 'approval-closed',
          approvalId: request.id,
          sessionId: envelope.sessionId,
        })
        return request
      }
      return current
    }
    if (envelope.event.kind !== 'approval.requested') return undefined
    const toolName = this.#sanitizer.text(envelope.event.toolName ?? 'unknown-tool', 120)
    const reason = optionalSanitized(this.#sanitizer, envelope.event.metadata.reason, 300)
    const callId = optionalSanitized(this.#sanitizer, envelope.event.callId, 160)
    this.#details.set(approvalRequestId, {
      toolName,
      ...(reason === undefined ? {} : { reason }),
      ...(callId === undefined ? {} : { callId }),
    })
    const createdAt = new Date()
    const request = this.#store.createApprovalRequest({
      workspaceId: envelope.workspaceId,
      worldId: envelope.worldId,
      sessionId: envelope.sessionId,
      workTurnId: envelope.workTurnId,
      agentRunId: envelope.agentRunId,
      characterId: envelope.agentId,
      subjectType: 'tool-call',
      subjectId: approvalRequestId,
      risk: approvalRisk(toolName, reason),
      summary: approvalSummary(toolName, reason),
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + APPROVAL_TTL_MS).toISOString(),
    })
    this.#onChanged(envelope.worldId, {
      kind: 'approval-requested',
      approvalId: request.id,
      sessionId: envelope.sessionId,
    })
    return request
  }

  view(request: ApprovalRequest): ApprovalRequestView['subject'] | undefined {
    if (request.subjectType !== 'tool-call') return undefined
    const details = this.#details.get(request.subjectId)
    const toolName = details?.toolName ?? 'dsh-tool'
    return {
      id: request.subjectId,
      skillId: 'dsh.runtime',
      adapterId: 'deepseek-harness',
      action: toolName,
      target: details?.reason ?? '当前会话',
      label: request.summary,
      risk: request.risk,
      parameters: {
        ...(details?.reason === undefined ? {} : { reason: details.reason }),
        ...(details?.callId === undefined ? {} : { callId: details.callId }),
      },
    }
  }

  async decide(approvalId: string, decision: 'approved' | 'rejected'): Promise<{ request: ApprovalRequest }> {
    const pending = this.#store.getApprovalRequest(approvalId)
    if (pending === undefined) throw new Error('审批请求不存在')
    if (pending.subjectType !== 'tool-call' || pending.agentRunId === undefined) {
      throw new Error('审批请求没有关联运行中的工具调用')
    }
    const request = this.#store.decideApprovalRequest(approvalId, decision, 'once', 'local-user')
    if (request.status === 'expired') {
      await this.#runtime.decideApproval?.(pending.agentRunId, pending.subjectId, 'rejected').catch(() => undefined)
      this.#details.delete(pending.subjectId)
      throw new Error('审批请求已经过期')
    }
    if (this.#runtime.decideApproval === undefined) throw new Error('当前运行时未提供动作审批能力')
    await this.#runtime.decideApproval(pending.agentRunId, pending.subjectId, decision)
    this.#details.delete(pending.subjectId)
    this.#onChanged(pending.worldId, {
      kind: 'approval-decided',
      approvalId,
      sessionId: pending.sessionId ?? '',
      decision,
    })
    return { request }
  }

  async #settleExpired(): Promise<void> {
    const now = Date.now()
    for (const approvalRequestId of this.#details.keys()) {
      if (this.#settling.has(approvalRequestId)) continue
      const request = this.#store.getApprovalRequestBySubject('tool-call', approvalRequestId)
      if (request === undefined || request.status === 'approved' || request.status === 'rejected') {
        this.#details.delete(approvalRequestId)
        continue
      }
      if (request.status !== 'expired' && Date.parse(request.expiresAt) > now) continue
      this.#settling.add(approvalRequestId)
      try {
        if (request.status === 'pending') {
          this.#store.decideApprovalRequest(request.id, 'rejected', 'once', 'system', new Date(now).toISOString())
        }
        if (request.agentRunId !== undefined) {
          await this.#runtime.decideApproval?.(request.agentRunId, approvalRequestId, 'rejected').catch(() => undefined)
        }
        this.#details.delete(approvalRequestId)
        this.#onChanged(request.worldId, { kind: 'approval-expired', approvalId: request.id, sessionId: request.sessionId ?? '' })
      } finally {
        this.#settling.delete(approvalRequestId)
      }
    }
  }
}

function approvalSummary(toolName: string, reason: string | undefined): string {
  const action = approvalActionLabel(toolName)
  return reason === undefined ? action : `${action}：${reason}`
}

function approvalActionLabel(toolName: string): string {
  const normalized = toolName.toLowerCase()
  if (normalized.includes('pwsh') || normalized.includes('powershell')) return '执行 PowerShell 命令'
  if (normalized.includes('bash') || normalized.includes('shell')) return '执行终端命令'
  if (normalized.includes('editor') || normalized.includes('replace')) return '修改本地文件'
  return toolDisplayLabel(toolName)
}

function approvalRisk(toolName: string, reason: string | undefined): ApprovalRisk {
  const value = `${toolName} ${reason ?? ''}`.toLowerCase()
  if (/browser|http|network|网页|联网/.test(value)) return 'external-side-effect'
  if (/bash|pwsh|shell|editor|write|replace|file|文件|写入/.test(value)) return 'write-local'
  return 'high-risk'
}

function optionalSanitized(sanitizer: TraceSanitizer, value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined
  const sanitized = sanitizer.text(value, limit)
  return sanitized.length === 0 ? undefined : sanitized
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

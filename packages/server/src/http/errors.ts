import { conversationTurnFailure } from '@dsh-cyber/contracts'
import type { ServerResponse } from 'node:http'

import { ContextInputTooLargeError } from '@dsh-cyber/contracts'
import {
  AgentTurnFailedError,
  ConversationOrchestrationError,
  type AgentTurnFailureKind,
} from '@dsh-cyber/orchestration'
import {
  PackageApprovalRequiredError,
  PackageInstallError,
} from '@dsh-cyber/package-runtime'

import { UnsupportedWorldRuntimeError } from '../world-runtime-service.js'
import { ServiceError } from '../services/service-error.js'
import { writeJson } from './response.js'

export class HttpError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

export function writeError(response: ServerResponse, error: unknown): void {
  if (response.headersSent) {
    response.end()
    return
  }
  if (error instanceof HttpError) {
    writeJson(response, error.status, errorPayload(error.code, error.message))
    return
  }
  if (error instanceof ServiceError) {
    const status = {
      conflict: 409,
      forbidden: 403,
      invalid: 422,
      'not-found': 404,
      'rate-limited': 429,
      'too-large': 413,
      unavailable: 502,
      unsupported: 415,
    }[error.kind]
    writeJson(response, status, errorPayload(error.code, error.message))
    return
  }
  if (error instanceof ContextInputTooLargeError) {
    writeJson(response, 413, errorPayload(
      'context_input_too_large',
      agentTurnFailureMessage('context-limit'),
      {
        estimatedTokens: error.estimatedTokens,
        inputBudgetTokens: error.inputBudgetTokens,
      },
    ))
    return
  }
  if (error instanceof AgentTurnFailedError) {
    const contextLimit = error.failureKind === 'context-limit'
    const hasLimits = contextLimit && error.estimatedTokens !== undefined
      && error.inputBudgetTokens !== undefined
    writeJson(response, contextLimit ? 413 : 502, errorPayload(
      `model_turn_${error.failureKind.replaceAll('-', '_')}`,
      agentTurnFailureMessage(error.failureKind),
      hasLimits
        ? { estimatedTokens: error.estimatedTokens, inputBudgetTokens: error.inputBudgetTokens }
        : undefined,
    ))
    return
  }
  if (error instanceof ConversationOrchestrationError) {
    writeJson(response, 422, {
      ...errorPayload('conversation_rejected', '当前会话暂时无法执行，请检查参与角色、模型分配和世界设置后重试。'),
    })
    return
  }
  if (error instanceof PackageApprovalRequiredError) {
    writeJson(response, 409, {
      ...errorPayload('package_approval_required', error.message),
    })
    return
  }
  if (error instanceof PackageInstallError) {
    writeJson(response, 422, {
      ...errorPayload('package_install_failed', error.message),
    })
    return
  }
  if (error instanceof UnsupportedWorldRuntimeError) {
    writeJson(response, 409, {
      ...errorPayload('world_runtime_unavailable', '当前世界使用旧版渲染器。请切换到运行时 V2 主题以启用实时世界。'),
    })
    return
  }
  const notFound = error instanceof Error && error.name === 'EntityNotFoundError'
  writeJson(response, notFound ? 404 : 500, {
    ...errorPayload(notFound ? 'entity_not_found' : 'internal_error', notFound ? error.message : '服务器内部错误'),
  })
}

function errorPayload(
  code: string,
  message: string,
  details?: Record<string, number>,
): { error: { code: string; message: string; messageKey: string; [key: string]: string | number } } {
  return { error: { code, message, messageKey: `error.${code}`, ...(details ?? {}) } }
}

export function agentTurnFailureMessage(kind: AgentTurnFailureKind): string {
  return conversationTurnFailure(`runtime-${kind}`).message
}

import type { ServerResponse } from 'node:http'

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
    writeJson(response, error.status, { error: { code: error.code, message: error.message } })
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
    writeJson(response, status, { error: { code: error.code, message: error.message } })
    return
  }
  if (error instanceof AgentTurnFailedError) {
    writeJson(response, 502, {
      error: {
        code: `model_turn_${error.failureKind.replaceAll('-', '_')}`,
        message: agentTurnFailureMessage(error.failureKind),
      },
    })
    return
  }
  if (error instanceof ConversationOrchestrationError) {
    writeJson(response, 422, {
      error: { code: 'conversation_rejected', message: '当前会话暂时无法执行，请检查参与员工和模型配置后重试。' },
    })
    return
  }
  if (error instanceof PackageApprovalRequiredError) {
    writeJson(response, 409, {
      error: { code: 'package_approval_required', message: error.message },
    })
    return
  }
  if (error instanceof PackageInstallError) {
    writeJson(response, 422, {
      error: { code: 'package_install_failed', message: error.message },
    })
    return
  }
  if (error instanceof UnsupportedWorldRuntimeError) {
    writeJson(response, 409, {
      error: {
        code: 'world_runtime_unavailable',
        message: 'This world uses the legacy renderer. Switch to a Runtime V2 theme to enable the live world.',
      },
    })
    return
  }
  const notFound = error instanceof Error && error.name === 'EntityNotFoundError'
  writeJson(response, notFound ? 404 : 500, {
    error: {
      code: notFound ? 'entity_not_found' : 'internal_error',
      message: notFound ? error.message : 'Internal server error',
    },
  })
}

function agentTurnFailureMessage(kind: AgentTurnFailureKind): string {
  switch (kind) {
    case 'authentication': return '模型服务拒绝了 API 密钥，请在设置中重新填写后重试。'
    case 'model-not-found': return '当前模型 ID 不存在或无权访问，请重新获取模型列表。'
    case 'rate-limited': return '模型服务请求过于频繁或额度不足，请稍后重试。'
    case 'timeout': return '模型服务响应超时，请检查网络或稍后重试。'
    case 'unreachable': return '无法连接模型服务，请检查接口地址、网络和服务状态。'
    case 'unknown': return '模型暂时无法完成请求，请检查 API 密钥、接口地址和模型 ID 后重试。'
  }
}

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
      error: { code: 'conversation_rejected', message: '当前会话暂时无法执行，请检查参与角色、模型分配和世界设置后重试。' },
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

export function agentTurnFailureMessage(kind: AgentTurnFailureKind): string {
  switch (kind) {
    case 'authentication':
      return 'API 密钥被模型服务拒绝。请打开“设置 → 模型”重新填写密钥，并先获取模型列表确认连接成功。'
    case 'model-not-found':
      return '接口已连接，但当前模型 ID 不存在或无权访问。请在“设置 → 模型”重新获取模型列表并选择可用模型。'
    case 'rate-limited':
      return '模型服务正在限流或账户额度不足。请稍后重试，或检查服务商额度并切换可用模型。'
    case 'timeout':
      return '模型服务响应超时。请先确认接口地址可以访问；网络正常时可稍后重试，或降低当前推理档位。'
    case 'unreachable':
      return '模型服务不可达或上游暂时不可用。请检查接口地址、代理/网络和服务状态；如果模型列表也无法获取，请先修复连接。'
    case 'unknown':
      return '上游返回了暂未识别的模型错误。请打开“设置 → 模型 → 模型交互日志”查看最近失败的状态码和错误码；若模型列表可正常获取但对话仍失败，重点检查接口协议、推理模式兼容性和模型 ID。'
  }
}

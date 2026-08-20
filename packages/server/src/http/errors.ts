import type { ServerResponse } from 'node:http'

import { ConversationOrchestrationError } from '@dsh-cyber/orchestration'
import {
  PackageApprovalRequiredError,
  PackageInstallError,
} from '@dsh-cyber/package-runtime'

import { UnsupportedWorldRuntimeError } from '../world-runtime-service.js'
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
  if (error instanceof ConversationOrchestrationError) {
    writeJson(response, 422, {
      error: { code: 'conversation_rejected', message: error.message },
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

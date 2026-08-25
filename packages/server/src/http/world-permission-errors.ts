import {
  WorldPermissionGrantRejectedError,
  WorldPermissionRequestConflictError,
  WorldPermissionRequestExpiredError,
} from '../services/world-permission-request-service.js'
import { HttpError } from './errors.js'

/**
 * Maps an authority-layer refusal onto the status it deserves.
 *
 * These are legitimate answers to the user — the request expired, it was
 * already decided, a member may not hold a management permission — not server
 * faults. It lives in the http layer so the inline card route and the chat
 * text route can agree without importing one another.
 */
export function mapPermissionDecisionError(error: unknown): Error {
  if (error instanceof WorldPermissionRequestExpiredError) {
    return new HttpError(409, 'world_permission_request_expired', error.message)
  }
  if (error instanceof WorldPermissionRequestConflictError) {
    return new HttpError(409, 'world_permission_request_already_decided', error.message)
  }
  if (error instanceof WorldPermissionGrantRejectedError) {
    return new HttpError(409, 'world_permission_grant_rejected', error.message)
  }
  const code = error instanceof Error ? (error as Error & { code?: unknown }).code : undefined
  if (code === 'world_permission_request_expired') {
    return new HttpError(409, 'world_permission_request_expired', '世界权限请求已过期')
  }
  if (code === 'world_permission_request_already_decided') {
    return new HttpError(409, 'world_permission_request_already_decided', '世界权限请求已经处理')
  }
  return error instanceof Error ? error : new Error(String(error))
}

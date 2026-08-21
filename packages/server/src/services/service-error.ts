export type ServiceErrorKind =
  | 'conflict'
  | 'forbidden'
  | 'invalid'
  | 'not-found'
  | 'rate-limited'
  | 'too-large'
  | 'unavailable'
  | 'unsupported'

export class ServiceError extends Error {
  readonly kind: ServiceErrorKind
  readonly code: string
  /** 上游服务返回的真实 HTTP 状态码（模型接口等外部服务），无则 undefined */
  readonly httpStatus?: number

  constructor(kind: ServiceErrorKind, code: string, message: string, httpStatus?: number) {
    super(message)
    this.kind = kind
    this.code = code
    if (httpStatus !== undefined) this.httpStatus = httpStatus
  }
}

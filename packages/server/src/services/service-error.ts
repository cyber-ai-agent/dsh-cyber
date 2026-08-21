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

  constructor(kind: ServiceErrorKind, code: string, message: string) {
    super(message)
    this.kind = kind
    this.code = code
  }
}

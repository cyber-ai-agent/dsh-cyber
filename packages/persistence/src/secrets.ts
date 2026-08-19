import type { JsonValue } from '@dsh-cyber/contracts'

import { SecretPersistenceError } from './errors.js'

const SECRET_KEY = /(?:^|[_-])(api[_-]?key|access[_-]?key|secret|password|passwd|private[_-]?key|token|credential|cookie)(?:$|[_-])/i

export function assertSecretFree(value: JsonValue, path = '$'): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertSecretFree(entry, `${path}[${index}]`))
    return
  }

  if (value === null || typeof value !== 'object') return

  for (const [key, entry] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) {
      throw new SecretPersistenceError(`Secret-like field is not allowed in domain events: ${path}.${key}`)
    }
    assertSecretFree(entry, `${path}.${key}`)
  }
}

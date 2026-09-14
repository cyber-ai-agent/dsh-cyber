import { describe, expect, it } from 'vitest'

import {
  CredentialRedactor,
  credentialVariable,
  credentialVariableForEnvironment,
  parseCredentialVariableDescriptors,
} from '../src/credentials.js'

describe('credential variables', () => {
  it('replaces registered values with stable variables in text and JSON', () => {
    const variable = credentialVariable('integration:connection-1:apiKey')
    const redactor = new CredentialRedactor([{
      ref: 'integration:connection-1:apiKey',
      variable,
      value: 'opaque-api-key-123456',
    }])

    expect(redactor.text('Authorization: Bearer opaque-api-key-123456')).toContain(variable)
    expect(redactor.text('Authorization: Bearer opaque-api-key-123456')).not.toContain('opaque-api-key-123456')
    expect(redactor.text(`password=opaque-api-key-123456`)).toBe(`password=${variable}`)
    expect(redactor.json({ apiKey: 'opaque-api-key-123456', file: 'token-counter.ts' })).toEqual({
      apiKey: variable,
      file: 'token-counter.ts',
    })
  })

  it('keeps private keys and multi-line values out of output', () => {
    const variable = credentialVariable('integration:device-1:privateKey')
    const redactor = new CredentialRedactor([{
      ref: 'integration:device-1:privateKey',
      variable,
      value: '-----BEGIN OPENSSH PRIVATE KEY-----\nopaque\n-----END OPENSSH PRIVATE KEY-----',
    }])

    const result = redactor.text('key=-----BEGIN OPENSSH PRIVATE KEY-----\nopaque\n-----END OPENSSH PRIVATE KEY-----')
    expect(result).toBe(`key=${variable}`)
  })

  it('parses descriptor-only worker metadata and ignores malformed entries', () => {
    const descriptor = credentialVariableForEnvironment('DSH_CYBER_MODEL_KEY_ABC')
    expect(parseCredentialVariableDescriptors(JSON.stringify([descriptor]))).toEqual([descriptor])
    expect(parseCredentialVariableDescriptors(JSON.stringify([
      descriptor,
      { ref: 'bad', variable: 'opaque' },
      { ref: 'bad-env', variable: '${credential.environment.ok}', envName: 'bad-name' },
    ]))).toEqual([descriptor])
  })
})

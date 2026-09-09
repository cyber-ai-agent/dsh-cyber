import { describe, expect, it } from 'vitest'
import { isSensitiveToolPath, redactToolTraceText } from '../src/tool-trace.js'

describe('tool evidence value redaction', () => {
  it.each(['character-profile-runtime.ts', 'keyboard-shortcuts.ts', 'token-counter.ts', 'session-history-parser.ts', 'secret-storage.ts', '.dsh/artifacts/26f63451-0e6d-48ab-81ca-f5416f89a039.json'])(
    'keeps ordinary filename %s', (value) => expect(redactToolTraceText(value)).toBe(value),
  )
  it.each([
    ['Authorization: Bearer a-secret-value', 'a-secret-value'],
    ['Cookie: id=private-session; locale=zh', 'private-session'],
    ['{"access_token":"super secret with spaces"}', 'super secret'],
    ['curl -u "alice:private-pass" https://example.com', 'private-pass'],
    ['curl --header "x-custom: opaque-value" https://example.com', 'opaque-value'],
    ['tool --password "opaque password"', 'opaque password'],
    ['x=sk-test-1234567890abcdef', 'sk-test-1234567890abcdef'],
    ['-----BEGIN PRIVATE KEY-----\nopaque key\n-----END PRIVATE KEY-----', 'opaque key'],
    ['https://alice:pass@example.com/files?token=opaque#private', 'alice:pass'],
    ['https://hooks.slack.com/services/T12A/B12B/opaque', 'opaque'],
  ])('redacts credential values from %s', (value, secret) => {
    expect(redactToolTraceText(value)).not.toContain(secret)
  })
  it('preserves multiline evidence, strips terminal control sequences, and clips after masking', () => {
    expect(redactToolTraceText('\u001b[31mfirst\nsecond\u001b[0m')).toBe('first\nsecond')
    const text = redactToolTraceText('password=' + 's'.repeat(500), 80)
    expect(text).not.toContain('ssss')
    expect(redactToolTraceText('x'.repeat(100_000))).toHaveLength(32_000)
  })
  it('suppresses credential container bodies, not source files discussing credentials', () => {
    for (const path of ['.env', '/etc/secrets.json', 'C:\\Users\\alice\\.ssh\\id_rsa', 'HEAD:.env']) expect(isSensitiveToolPath(path)).toBe(true)
    for (const path of ['secret-storage.ts', 'token-counter.ts', 'credentials.test.ts']) expect(isSensitiveToolPath(path)).toBe(false)
  })
})

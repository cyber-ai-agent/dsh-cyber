import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { HARNESS_COMPATIBILITY_MATRIX } from '../src/compatibility.js'
import { SUPPORTED_HARNESS_VERSION } from '../src/profile.js'

const EXPECTED_HARNESS_VERSION = '0.1.2-alpha.3'
const HERE = dirname(fileURLToPath(import.meta.url))

describe('DSH 0.1.2-alpha.3 compatibility', () => {
  it('pins the bundled and candidate runtime to the supported alpha3 release', () => {
    expect(SUPPORTED_HARNESS_VERSION).toBe(EXPECTED_HARNESS_VERSION)
    expect(HARNESS_COMPATIBILITY_MATRIX.some((entry) => entry.dshVersion === EXPECTED_HARNESS_VERSION)).toBe(true)
  })

  it('keeps optional DeepSeek metadata and session-log uploads disabled', async () => {
    const patch = await readFile(join(HERE, '../../harness-bundle/cordis.patch.yml'), 'utf8')
    expect(patch).toMatch(/id: session-log-deepseek\s+disabled: true/)
    expect(patch).toMatch(/id: plugin-package-inventory-deepseek\s+disabled: true/)
  })
})

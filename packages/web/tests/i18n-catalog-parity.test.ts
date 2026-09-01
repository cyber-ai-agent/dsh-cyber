import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { ALL_WORKBENCH_CATALOGS } from '../src/i18n/workbench-messages.js'
import { translate } from '../src/i18n/runtime.js'

const fixtureProject = join(process.cwd(), 'packages', 'web', 'tests', 'fixtures', 'i18n-catalog-parity')

function typecheckFixtures(): string {
  try {
    execFileSync('node', [
      join(process.cwd(), 'node_modules', 'typescript', 'bin', 'tsc'),
      '-p', fixtureProject,
      '--pretty', 'false',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return ''
  } catch (cause) {
    const failure = cause as { stdout?: string; stderr?: string }
    return `${failure.stdout ?? ''}${failure.stderr ?? ''}`
  }
}

describe('locale catalog key parity', () => {
  it('rejects a key that only one locale declares, and accepts a declared null gap', () => {
    const output = typecheckFixtures()

    expect(output, 'missing-key.fixture.ts must fail to typecheck').toContain('missing-key.fixture.ts')
    expect(output, 'extra-key.fixture.ts must fail to typecheck').toContain('extra-key.fixture.ts')
    expect(output, 'complete.fixture.ts must typecheck cleanly').not.toContain('complete.fixture.ts')

    // The typing this replaced accepted the very shape missing-key.fixture.ts
    // uses. If this ever starts reporting errors the hole closed some other way
    // and the fixture can go.
    expect(output, 'legacy-hole.fixture.ts documents the old, unchecked style').not.toContain('legacy-hole.fixture.ts')
  }, 120_000)

  it('keeps every workbench locale row on the same key set with only usable strings', () => {
    const entries = Object.entries(ALL_WORKBENCH_CATALOGS)
    expect(entries).toHaveLength(12)
    const referenceKeys = Object.keys(ALL_WORKBENCH_CATALOGS['zh-CN']).sort()

    for (const [locale, catalog] of entries) {
      // Declared-but-untranslated keys are stripped, so a locale row is always a
      // subset of the reference keys and never carries a null or empty value.
      expect(Object.keys(catalog).every((key) => referenceKeys.includes(key)), locale).toBe(true)
      expect(Object.values(catalog).every((message) => typeof message === 'string' && message.trim().length > 0), locale).toBe(true)
    }
  })

  it('resolves a locale gap through the existing en-US fallback', () => {
    // marketTitle is translated for en-US only; ja-JP declares it as a null gap.
    expect(ALL_WORKBENCH_CATALOGS['ja-JP'].marketTitle).toBeUndefined()
    expect(translate('workbench.marketTitle', 'fallback', {}, 'ja-JP'))
      .toBe(ALL_WORKBENCH_CATALOGS['en-US'].marketTitle)
  })
})

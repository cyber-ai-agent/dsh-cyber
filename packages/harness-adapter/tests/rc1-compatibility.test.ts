import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  HARNESS_COMPATIBILITY_MATRIX,
  inspectHarnessCandidate,
} from '../src/compatibility.js'
import { SUPPORTED_HARNESS_VERSION } from '../src/profile.js'

const EXPECTED_HARNESS_VERSION = '0.1.2-rc.1'
const HERE = dirname(fileURLToPath(import.meta.url))

describe('DSH 0.1.2-rc.1 compatibility', () => {
  it('pins the bundled and candidate runtime to the supported rc1 release', () => {
    expect(SUPPORTED_HARNESS_VERSION).toBe(EXPECTED_HARNESS_VERSION)
    expect(HARNESS_COMPATIBILITY_MATRIX.some((entry) => entry.dshVersion === EXPECTED_HARNESS_VERSION)).toBe(true)
  })

  it('advertises no DSH release the rewritten launch API cannot start', () => {
    expect(HARNESS_COMPATIBILITY_MATRIX.map((entry) => entry.dshVersion)).toEqual([
      EXPECTED_HARNESS_VERSION,
    ])
    for (const entry of HARNESS_COMPATIBILITY_MATRIX) {
      expect(Object.values(entry.packages)).toEqual(
        Object.values(entry.packages).map(() => entry.dshVersion),
      )
    }
  })

  it.each(['0.1.3-alpha.1', '0.1.2-alpha.3', '0.1.1-rc.1', '0.1.0-rc.8', '0.1.0-rc.7'])(
    'rejects the unreachable %s runtime and names the version an operator must install',
    async (staleVersion) => {
      const candidateRoot = await writeCandidate(staleVersion)
      const report = await inspectHarnessCandidate({ candidateRoot })
      expect(report.supported).toBe(false)
      expect(report.ok).toBe(false)
      expect(report.version).toBe(staleVersion)
      const errors = report.errors.join('\n')
      expect(errors).toContain(staleVersion)
      expect(errors).toContain(EXPECTED_HARNESS_VERSION)
    },
  )

  it('keeps optional DeepSeek metadata and session-log uploads disabled', async () => {
    const patch = await readFile(join(HERE, '../../harness-bundle/cordis.patch.yml'), 'utf8')
    expect(patch).toMatch(/id: session-log-deepseek\s+disabled: true/)
    expect(patch).toMatch(/id: plugin-package-inventory-deepseek\s+disabled: true/)
  })
})

async function writeCandidate(version: string): Promise<string> {
  const candidateRoot = join(await mkdtemp(join(tmpdir(), 'dsh-cyber-stale-')), 'candidate')
  await mkdir(candidateRoot, { recursive: true })
  await writeFile(join(candidateRoot, 'package.json'), '{"private":true}\n', 'utf8')
  for (const packageName of [
    '@deepseek-ai/dsh',
    '@deepseek-ai/dsh-sdk-client',
    '@deepseek-ai/dsh-sdk-jsonrpc-server',
  ]) {
    const packageDirectory = join(candidateRoot, 'node_modules', ...packageName.split('/'))
    await mkdir(packageDirectory, { recursive: true })
    await writeFile(
      join(packageDirectory, 'package.json'),
      `${JSON.stringify({ name: packageName, version })}\n`,
      'utf8',
    )
  }
  return candidateRoot
}

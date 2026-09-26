import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  HARNESS_COMPATIBILITY_MATRIX,
  inspectHarnessCandidate,
} from '../src/compatibility.js'
import { inspectHarnessCompatibility, SUPPORTED_HARNESS_VERSION } from '../src/profile.js'

const EXPECTED_HARNESS_VERSION = '0.1.7-rc.2'
const HERE = dirname(fileURLToPath(import.meta.url))

describe('DSH 0.1.7-rc.2 compatibility', () => {
  it('pins the bundled and candidate runtime to the supported release candidate', () => {
    expect(SUPPORTED_HARNESS_VERSION).toBe(EXPECTED_HARNESS_VERSION)
    expect(HARNESS_COMPATIBILITY_MATRIX.some((entry) => entry.dshVersion === EXPECTED_HARNESS_VERSION)).toBe(true)
    expect(HARNESS_COMPATIBILITY_MATRIX[0]).toMatchObject({
      releaseTag: 'dsh-v0.1.7-rc.2',
      sessionFormatVersion: 4,
      supportedFormatMigrations: ['v2-to-v3', 'v3-to-v4'],
      lifecycle: { sessionHandle: true, asyncAgentLoopCreate: true, sessionLock: true },
    })
  })

  it('advertises no DSH release the rewritten launch API cannot start', () => {
    expect(HARNESS_COMPATIBILITY_MATRIX.map((entry) => entry.dshVersion)).toEqual([
      EXPECTED_HARNESS_VERSION,
    ])
    for (const entry of HARNESS_COMPATIBILITY_MATRIX) {
      expect(Object.values(entry.packages)).toEqual(
        Object.values(entry.packages).map(() => entry.dshVersion),
      )
      expect(entry.packages['@deepseek-ai/dsh']).toBe(entry.dshVersion)
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

  it('pins early tool-result pruning and compaction budgets in the worker bundle', async () => {
    const patch = await readFile(join(HERE, '../../harness-bundle/cordis.patch.yml'), 'utf8')
    expect(patch).toMatch(/id: compaction-basic[\s\S]*thresholdRatio: 0\.72[\s\S]*retainRatio: 0\.12[\s\S]*maxTokens: 2048/)
    expect(patch).toMatch(/id: tool-result-pruner[\s\S]*thresholdChars: 4096[\s\S]*headChars: 3072[\s\S]*tailChars: 768/)
  })

  it('keeps upstream Skill discovery behind the DSH Cyber package and grant boundary', async () => {
    const patch = await readFile(join(HERE, '../../harness-bundle/cordis.patch.yml'), 'utf8')
    expect(patch).toMatch(/id: skill-filesystem[\s\S]*includeDefaultRoots: false[\s\S]*customSkillDirs: \[\][\s\S]*watch: false/)
    expect(patch).toMatch(/id: tool-skill\s+disabled: true/)
  })

  it('uses the session event feed instead of deprecated synchronous history reads', async () => {
    const source = await readFile(join(HERE, '../../harness-bundle/src/index.ts'), 'utf8')
    expect(source).not.toMatch(/\.eventAt\(|\.snapshotEvents\(|\.ownEvents\(/)
    expect(source).toContain("ctx.on('session/event'")
  })

  it('reports the V4 migration boundary and verifies the Bundle peer closure', async () => {
    const report = await inspectHarnessCompatibility()
    expect(report).toMatchObject({
      ok: true,
      expectedVersion: EXPECTED_HARNESS_VERSION,
      releaseTag: 'dsh-v0.1.7-rc.2',
      releaseDate: '2026-09-24',
      releaseCommit: '477b4f420553e8a52c2fbccc464d7561b239c443',
      npmChannel: 'next',
      contractId: 'dsh-session-events-v1',
      sessionFormatVersion: 4,
      supportedFormatMigrations: ['v2-to-v3', 'v3-to-v4'],
    })
    const dshPackages = Object.entries(report.packages)
      .filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))
    expect(dshPackages.length).toBeGreaterThan(20)
    expect(dshPackages.every(([, value]) => value.version === EXPECTED_HARNESS_VERSION)).toBe(true)
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

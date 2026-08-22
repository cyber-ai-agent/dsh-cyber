import { createRequire } from 'node:module'
import { readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { ensureHarnessProfile, type HarnessProfilePaths } from './profile.js'

export const HARNESS_PROTOCOL_CONTRACT = 'dsh-session-events-v1' as const

export const HARNESS_COMPATIBILITY_MATRIX = [
  {
    dshVersion: '0.1.1-rc.1',
    contractId: HARNESS_PROTOCOL_CONTRACT,
    packages: {
      '@deepseek-ai/dsh': '0.1.1-rc.1',
      '@deepseek-ai/dsh-sdk-client': '0.1.1-rc.1',
      '@deepseek-ai/dsh-sdk-jsonrpc-server': '0.1.1-rc.1',
    },
    requiredEvents: [
      'turn/start',
      'assistant/chunk',
      'assistant/message',
      'tool/call',
      'tool/result',
      'turn/end',
    ],
  },
  {
    dshVersion: '0.1.0-rc.8',
    contractId: HARNESS_PROTOCOL_CONTRACT,
    packages: {
      '@deepseek-ai/dsh': '0.1.0-rc.8',
      '@deepseek-ai/dsh-sdk-client': '0.1.0-rc.8',
      '@deepseek-ai/dsh-sdk-jsonrpc-server': '0.1.0-rc.8',
    },
    requiredEvents: [
      'turn/start',
      'assistant/chunk',
      'assistant/message',
      'tool/call',
      'tool/result',
      'turn/end',
    ],
  },
  {
    dshVersion: '0.1.0-rc.7',
    contractId: HARNESS_PROTOCOL_CONTRACT,
    packages: {
      '@deepseek-ai/dsh': '0.1.0-rc.7',
      '@deepseek-ai/dsh-sdk-client': '0.1.0-rc.7',
      '@deepseek-ai/dsh-sdk-jsonrpc-server': '0.1.0-rc.7',
    },
    requiredEvents: [
      'turn/start',
      'assistant/chunk',
      'assistant/message',
      'tool/call',
      'tool/result',
      'turn/end',
    ],
  },
] as const

export type HarnessCompatibilityEntry = (typeof HARNESS_COMPATIBILITY_MATRIX)[number]

export interface HarnessCandidateReport {
  ok: boolean
  candidateRoot: string
  version?: string
  supported: boolean
  contractId?: string
  packages: Record<string, { version?: string; path?: string; error?: string }>
  profile?: HarnessProfilePaths
  checks: {
    packageVersions: boolean
    isolatedProfile: boolean
    runtimeSmokeRequired: true
  }
  errors: string[]
}

export function harnessCompatibilityEntry(
  version: string,
): HarnessCompatibilityEntry | undefined {
  return HARNESS_COMPATIBILITY_MATRIX.find((entry) => entry.dshVersion === version)
}

export async function inspectHarnessCandidate(options: {
  candidateRoot: string
  stateRoot?: string
}): Promise<HarnessCandidateReport> {
  const candidateRoot = resolve(options.candidateRoot)
  const report: HarnessCandidateReport = {
    ok: true,
    candidateRoot,
    supported: false,
    packages: {},
    checks: {
      packageVersions: false,
      isolatedProfile: false,
      runtimeSmokeRequired: true,
    },
    errors: [],
  }
  try {
    const candidateManifest = join(candidateRoot, 'package.json')
    const metadata = await stat(candidateManifest)
    if (!metadata.isFile()) throw new Error('candidate package.json is not a file')
    const require = createRequire(candidateManifest)
    const packageNames = Object.keys(HARNESS_COMPATIBILITY_MATRIX[0].packages)
    for (const packageName of packageNames) {
      try {
        const manifestPath = require.resolve(`${packageName}/package.json`)
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { version?: unknown }
        const version = typeof manifest.version === 'string' ? manifest.version : undefined
        report.packages[packageName] = {
          ...(version === undefined ? {} : { version }),
          path: manifestPath,
        }
      } catch (error) {
        const message = errorMessage(error)
        report.packages[packageName] = { error: message }
        report.errors.push(`${packageName}: ${message}`)
      }
    }
    const versions = new Set(
      Object.values(report.packages)
        .map((item) => item.version)
        .filter((item): item is string => item !== undefined),
    )
    if (versions.size !== 1) {
      report.errors.push('Candidate Harness packages must use one exact version')
    } else {
      const version = [...versions][0]!
      report.version = version
      const entry = harnessCompatibilityEntry(version)
      report.supported = entry !== undefined
      if (entry === undefined) {
        report.errors.push(`Harness ${version} is not in the compatibility matrix`)
      } else {
        report.contractId = entry.contractId
        for (const [packageName, expectedVersion] of Object.entries(entry.packages)) {
          const actual = report.packages[packageName]?.version
          if (actual !== expectedVersion) {
            report.errors.push(`${packageName} is ${actual ?? 'missing'}, expected ${expectedVersion}`)
          }
        }
        report.checks.packageVersions = report.errors.length === 0
        if (options.stateRoot !== undefined && report.checks.packageVersions) {
          const profileName = `dsh-cyber-candidate-${safeVersion(version)}`
          report.profile = await ensureHarnessProfile(
            join(resolve(options.stateRoot), 'candidates', version, 'harness-home'),
            profileName,
          )
          report.checks.isolatedProfile = true
        }
      }
    }
  } catch (error) {
    report.errors.push(errorMessage(error))
  }
  report.ok =
    report.supported &&
    report.checks.packageVersions &&
    (options.stateRoot === undefined || report.checks.isolatedProfile) &&
    report.errors.length === 0
  return report
}

function safeVersion(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9-]/g, '-')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

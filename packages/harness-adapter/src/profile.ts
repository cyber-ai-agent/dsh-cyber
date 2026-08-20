import { createRequire } from 'node:module'
import { lstat, mkdir, open, readFile, readlink, rename, symlink, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

export const SUPPORTED_HARNESS_VERSION = '0.1.0-rc.7' as const
export const WORKER_PROFILE_NAME = 'dsh-cyber-worker' as const

export interface HarnessProfilePaths {
  homeDir: string
  profileDir: string
  profileManifestPath: string
  profilePatchPath: string
  settingsPath: string
}

export interface HarnessProviderProfile {
  route: string
  displayName: string
  api: string
  baseURL: string
  model: {
    id: string
    name?: string
    contextWindow?: number
    maxTokens?: number
  }
  apiKeyEnv?: string
}

export interface HarnessCompatibilityReport {
  ok: boolean
  expectedVersion: string
  packages: Record<string, { version?: string; path?: string; error?: string }>
  profile?: HarnessProfilePaths
  errors: string[]
}

export async function ensureHarnessProfile(
  homeDir: string,
  profileName: string = WORKER_PROFILE_NAME,
  providerProfile?: HarnessProviderProfile,
): Promise<HarnessProfilePaths> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(profileName)) {
    throw new Error(`Invalid Harness profile name: ${JSON.stringify(profileName)}`)
  }
  const absoluteHome = resolve(homeDir)
  const profileDir = join(absoluteHome, 'profiles', profileName)
  const profileManifestPath = join(profileDir, 'package.json')
  const profilePatchPath = join(profileDir, 'cordis.patch.yml')
  const settingsPath = join(absoluteHome, 'settings.yaml')
  await mkdir(profileDir, { recursive: true })
  await writeTextAtomic(
    profileManifestPath,
    `${JSON.stringify(
      {
        name: '@dsh-cyber/worker-profile',
        version: '0.1.0',
        private: true,
        dsh: {
          profile: {
            bundles: ['@deepseek-ai/dsh-base', '@dsh-cyber/harness-bundle'],
          },
        },
      },
      null,
      2,
    )}\n`,
  )
  await writeTextAtomic(
    profilePatchPath,
    providerProfile === undefined
      ? '# Machine-local DSH Cyber worker overrides. Bundle policy remains authoritative.\n[]\n'
      : `${JSON.stringify([
          {
            id: 'llm-pi-ai',
            config: { providers: { [providerProfile.route]: providerRoute(providerProfile) } },
          },
        ], null, 2)}\n`,
  )
  if (providerProfile !== undefined) {
    validateProviderProfile(providerProfile)
    const route = providerRoute(providerProfile)
    await writeTextAtomic(
      settingsPath,
      `${JSON.stringify({ 'llm-pi-ai': { providers: { [providerProfile.route]: route } } }, null, 2)}\n`,
    )
  }
  const require = createRequire(import.meta.url)
  const bundleDirectory = dirname(require.resolve('@dsh-cyber/harness-bundle/package.json'))
  await ensurePackageLink(
    join(profileDir, 'node_modules', '@dsh-cyber', 'harness-bundle'),
    bundleDirectory,
  )
  return {
    homeDir: absoluteHome,
    profileDir,
    profileManifestPath,
    profilePatchPath,
    settingsPath,
  }
}

function providerRoute(providerProfile: HarnessProviderProfile): Record<string, unknown> {
  validateProviderProfile(providerProfile)
  return {
    displayName: providerProfile.displayName,
    api: providerProfile.api,
    baseURL: providerProfile.baseURL,
    models: [providerProfile.model],
    ...(providerProfile.apiKeyEnv === undefined
      ? {}
      : { apiKeyEnv: providerProfile.apiKeyEnv }),
  }
}

export async function inspectHarnessCompatibility(
  homeDir?: string,
): Promise<HarnessCompatibilityReport> {
  const packages = [
    '@deepseek-ai/dsh',
    '@deepseek-ai/dsh-sdk-client',
    '@deepseek-ai/dsh-sdk-jsonrpc-server',
    '@dsh-cyber/harness-bundle',
  ]
  const report: HarnessCompatibilityReport = {
    ok: true,
    expectedVersion: SUPPORTED_HARNESS_VERSION,
    packages: {},
    errors: [],
  }
  const require = createRequire(import.meta.url)
  for (const packageName of packages) {
    try {
      const manifestPath = require.resolve(`${packageName}/package.json`)
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
        version?: unknown
        dsh?: { bundle?: { patch?: unknown } }
      }
      const version = typeof manifest.version === 'string' ? manifest.version : undefined
      report.packages[packageName] = {
        ...(version === undefined ? {} : { version }),
        path: manifestPath,
      }
      if (packageName.startsWith('@deepseek-ai/') && version !== SUPPORTED_HARNESS_VERSION) {
        report.errors.push(
          `${packageName} is ${version ?? 'unknown'}, expected ${SUPPORTED_HARNESS_VERSION}`,
        )
      }
      if (
        packageName === '@dsh-cyber/harness-bundle' &&
        typeof manifest.dsh?.bundle?.patch !== 'string'
      ) {
        report.errors.push('@dsh-cyber/harness-bundle does not declare dsh.bundle.patch')
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      report.packages[packageName] = { error: message }
      report.errors.push(`${packageName}: ${message}`)
    }
  }
  if (homeDir !== undefined) {
    try {
      report.profile = await ensureHarnessProfile(homeDir)
    } catch (error) {
      report.errors.push(`profile: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  report.ok = report.errors.length === 0
  return report
}

export function resolveDshBin(): string {
  const require = createRequire(import.meta.url)
  const manifestPath = require.resolve('@deepseek-ai/dsh/package.json')
  return join(dirname(manifestPath), 'lib', 'bin.js')
}

async function writeTextAtomic(destination: string, content: string): Promise<void> {
  const temporary = `${destination}.tmp-${randomUUID()}`
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporary, destination)
}

async function ensurePackageLink(linkPath: string, targetPath: string): Promise<void> {
  await mkdir(dirname(linkPath), { recursive: true })
  try {
    const info = await lstat(linkPath)
    if (!info.isSymbolicLink()) {
      throw new Error(`Managed profile package path is not a link: ${linkPath}`)
    }
    const current = resolve(dirname(linkPath), await readlink(linkPath))
    if (current === resolve(targetPath)) return
    await unlink(linkPath)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') throw error
  }
  await symlink(resolve(targetPath), linkPath, 'junction')
}

function validateProviderProfile(profile: HarnessProviderProfile): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(profile.route)) throw new Error('Invalid provider route')
  if (!profile.displayName.trim() || !profile.api.trim() || !profile.model.id.trim()) {
    throw new Error('Provider display name, API and model are required')
  }
  const endpoint = new URL(profile.baseURL)
  const local = endpoint.hostname === '127.0.0.1' || endpoint.hostname === 'localhost' || endpoint.hostname === '::1'
  if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && local)) {
    throw new Error('Provider URL must use HTTPS, except loopback HTTP endpoints')
  }
  if (profile.apiKeyEnv !== undefined && !/^[A-Z_][A-Z0-9_]*$/.test(profile.apiKeyEnv)) {
    throw new Error('Invalid provider credential environment variable')
  }
}

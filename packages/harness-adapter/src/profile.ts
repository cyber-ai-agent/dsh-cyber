import { createRequire } from 'node:module'
import { isIP } from 'node:net'
import { lstat, mkdir, open, readFile, readlink, rename, symlink, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

export const SUPPORTED_HARNESS_VERSION = '0.1.2-alpha.3' as const
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
    reasoningEfforts?: false | Partial<Record<'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max', string | null>>
    compat?: { thinkingFormat?: string; supportsReasoningEffort?: boolean }
  }
  reasoning?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  apiKeyEnv?: string
  webSearch?: {
    baseURL: string
    apiKeyEnv: string
  }
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
      : `${JSON.stringify(providerPatch(providerProfile), null, 2)}\n`,
  )
  if (providerProfile !== undefined) {
    validateProviderProfile(providerProfile)
    const route = providerRoute(providerProfile)
    await writeTextAtomic(
      settingsPath,
      `${JSON.stringify({
        'llm-pi-ai': { providers: { [providerProfile.route]: route } },
        ...(providerProfile.webSearch === undefined
          ? {}
          : {
              'web-search-deepseek': {
                apiKeyEnv: providerProfile.webSearch.apiKeyEnv,
                baseURL: providerProfile.webSearch.baseURL,
              },
            }),
      }, null, 2)}\n`,
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

function providerPatch(providerProfile: HarnessProviderProfile): Array<Record<string, unknown>> {
  const patch: Array<Record<string, unknown>> = [{
    id: 'llm-pi-ai',
    config: { providers: { [providerProfile.route]: providerRoute(providerProfile) } },
  }]
  if (providerProfile.webSearch !== undefined) {
    patch.push({
      id: 'web-search-deepseek',
      config: {
        apiKeyEnv: providerProfile.webSearch.apiKeyEnv,
        baseURL: providerProfile.webSearch.baseURL,
      },
    })
  }
  return patch
}

function providerRoute(providerProfile: HarnessProviderProfile): Record<string, unknown> {
  validateProviderProfile(providerProfile)
  return {
    displayName: providerProfile.displayName,
    api: providerProfile.api,
    baseURL: providerProfile.baseURL,
    models: [providerProfile.model],
    ...(providerProfile.reasoning === undefined ? {} : { reasoning: providerProfile.reasoning }),
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

export function validateProviderProfile(profile: HarnessProviderProfile): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(profile.route)) throw new Error('Invalid provider route')
  if (!profile.displayName.trim() || !profile.api.trim() || !profile.model.id.trim()) {
    throw new Error('Provider display name, API and model are required')
  }
  const endpoint = new URL(profile.baseURL)
  // Plain HTTP is safe on a private network: loopback and RFC1918-style
  // addresses follow the same policy the server applies when saving model
  // profiles (model-url-policy.assertModelBaseUrl), so a LAN vLLM/Ollama box
  // is not rejected at worker-launch time after passing the settings form.
  // Anything else — public hosts, or hostnames that could resolve there —
  // still requires HTTPS.
  if (endpoint.protocol !== 'https:' && !isExplicitPrivateHostname(normalizeHostname(endpoint.hostname))) {
    throw new Error('Provider URL must use HTTPS, except loopback or private-network HTTP endpoints')
  }
  if (profile.apiKeyEnv !== undefined && !/^[A-Z_][A-Z0-9_]*$/.test(profile.apiKeyEnv)) {
    throw new Error('Invalid provider credential environment variable')
  }
  if (profile.webSearch !== undefined) {
    const searchEndpoint = new URL(profile.webSearch.baseURL)
    if (searchEndpoint.protocol !== 'https:') throw new Error('Web search URL must use HTTPS')
    if (!/^[A-Z_][A-Z0-9_]*$/.test(profile.webSearch.apiKeyEnv)) {
      throw new Error('Invalid web search credential environment variable')
    }
  }
}

function normalizeHostname(value: string): string {
  return value.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
}

function parseIpv4(value: string): readonly [number, number, number, number] | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value)
  if (m === null) return undefined
  const o = m.slice(1).map(Number)
  if (o.some((n) => n > 255)) return undefined
  return o as [number, number, number, number]
}

function parseIpv6(value: string): bigint | undefined {
  const m = /^([0-9a-fA-F]{1,4}):([0-9a-fA-F]{1,4}):([0-9a-fA-F]{1,4}):([0-9a-fA-F]{1,4}):([0-9a-fA-F]{1,4}):([0-9a-fA-F]{1,4}):([0-9a-fA-F]{1,4}):([0-9a-fA-F]{1,4})$/.exec(value)
  if (m !== null) {
    let result = 0n
    for (let i = 1; i <= 8; i++) {
      result = (result << 16n) | BigInt(parseInt(m[i]!, 16))
    }
    return result
  }
  // Handle :: compression
  const parts = value.split('::')
  if (parts.length === 2) {
    const left = parts[0] ? parts[0].split(':') : []
    const right = parts[1] ? parts[1].split(':') : []
    const missing = 8 - left.length - right.length
    const all = [...left, ...Array(missing).fill('0'), ...right]
    if (all.length !== 8) return undefined
    let result = 0n
    for (const part of all) {
      result = (result << 16n) | BigInt(parseInt(part, 16))
    }
    return result
  }
  return undefined
}

function inIpv6Range(value: bigint, rangeStr: string, prefixBits: number): boolean {
  const range = parseIpv6(rangeStr)
  if (range === undefined) return false
  const mask = (~0n << BigInt(128 - prefixBits))
  return (value & mask) === (range & mask)
}

function isPrivateAddress(address: string): boolean {
  const normalized = normalizeHostname(address)
  if (isIP(normalized) === 4) {
    const octets = parseIpv4(normalized)
    if (octets === undefined) return false
    const [first, second] = octets
    return first === 10 || first === 127
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168)
  }
  if (isIP(normalized) === 6) {
    const value = parseIpv6(normalized)
    if (value === undefined) return false
    return inIpv6Range(value, 'fc00::', 7) || inIpv6Range(value, '::1', 128)
  }
  return false
}

function isExplicitPrivateHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname.endsWith('.localhost')
    || hostname === 'host.docker.internal' || hostname === 'host.containers.internal'
    || hostname.endsWith('.local')) return true
  return isIP(hostname) !== 0 && isPrivateAddress(hostname)
}

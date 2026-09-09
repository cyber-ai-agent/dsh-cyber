import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import { promisify } from 'node:util'
import { contextContentHash, ENVIRONMENT_PROFILE_SCHEMA_VERSION, type EnvironmentProfile, type EnvironmentProfileTool } from '@dsh-cyber/contracts'
import { presenceSignature } from './environment-change-collector.js'

const execFileAsync = promisify(execFile)

/**
 * The fixed probe battery.
 *
 * Every version command is a constant - no user input is ever concatenated
 * into a shell line. Presence is answered by a pure PATH scan in Node, not by
 * shelling out, so the fast tier costs only a handful of stat calls and stays
 * deterministic under test.
 */
export interface EnvironmentToolProbe {
  name: string
  versionArgs?: readonly string[]
  /**
   * Owner-added tools have no known version flag: try the fixed ladder
   * instead of accepting a command line from the owner.
   */
  useVersionLadder?: boolean
}

export const BUILTIN_ENVIRONMENT_TOOLS: readonly EnvironmentToolProbe[] = [
  { name: 'node', versionArgs: ['-v'] },
  { name: 'npm', versionArgs: ['--version'] },
  { name: 'pnpm', versionArgs: ['--version'] },
  { name: 'yarn', versionArgs: ['--version'] },
  { name: 'deno', versionArgs: ['--version'] },
  { name: 'bun', versionArgs: ['--version'] },
  { name: 'tsx', versionArgs: ['--version'] },
  { name: 'git', versionArgs: ['--version'] },
  { name: 'python', versionArgs: ['--version'] },
  { name: 'python3', versionArgs: ['--version'] },
  { name: 'pip', versionArgs: ['--version'] },
  { name: 'java', versionArgs: ['-version'] },
  { name: 'dotnet', versionArgs: ['--version'] },
  { name: 'ruby', versionArgs: ['--version'] },
  { name: 'go', versionArgs: ['version'] },
  { name: 'rustc', versionArgs: ['--version'] },
  { name: 'cargo', versionArgs: ['--version'] },
  { name: 'make', versionArgs: ['--version'] },
  { name: 'cmake', versionArgs: ['--version'] },
  { name: 'docker', versionArgs: ['--version'] },
  { name: 'docker-compose', versionArgs: ['--version'] },
  { name: 'podman', versionArgs: ['--version'] },
  { name: 'kubectl', versionArgs: ['--version'] },
  { name: 'helm', versionArgs: ['version'] },
  { name: 'terraform', versionArgs: ['version'] },
  { name: 'gh', versionArgs: ['--version'] },
  { name: 'jq', versionArgs: ['--version'] },
  { name: 'curl', versionArgs: ['--version'] },
  { name: 'wget', versionArgs: ['--version'] },
  { name: 'ffmpeg', versionArgs: ['-version'] },
  { name: 'sqlite3', versionArgs: ['--version'] },
  { name: 'rg', versionArgs: ['--version'] },
  { name: 'tar', versionArgs: ['--version'] },
  { name: 'zip', versionArgs: ['-v'] },
  { name: 'unzip', versionArgs: ['-v'] },
  { name: '7z' },
  { name: 'pwsh', versionArgs: ['--version'] },
  { name: 'powershell' },
  { name: 'bash', versionArgs: ['--version'] },
  { name: 'zsh', versionArgs: ['--version'] },
]

export function builtinToolNames(): readonly string[] {
  return BUILTIN_ENVIRONMENT_TOOLS.map((probe) => probe.name)
}

export type EnvironmentProbePlatform = 'win32' | 'darwin' | 'linux'

/**
 * A tool the PATH scan actually found, together with how it must be launched.
 *
 * Windows ships several flavours of one command: a real `.exe`, a `cmd` shim,
 * a PowerShell shim and an extensionless POSIX script. `execFile` can only
 * start the `.exe` directly, so the launch shape is part of the resolved fact
 * instead of something the version probe guesses later.
 */
export interface ResolvedEnvironmentTool {
  name: string
  path: string
  kind: 'exe' | 'cmd' | 'bat' | 'ps1' | 'bare'
}

function candidateSuffixes(platform: EnvironmentProbePlatform): readonly string[] {
  // A real executable wins over a shim (`node.exe` over `node.cmd`), and the
  // extensionless POSIX script comes last because no Windows shell runs it.
  return platform === 'win32'
    ? ['.exe', '.cmd', '.bat', '.ps1', '']
    : ['']
}

function kindOf(suffix: string): ResolvedEnvironmentTool['kind'] {
  if (suffix === '.exe') return 'exe'
  if (suffix === '.cmd') return 'cmd'
  if (suffix === '.bat') return 'bat'
  if (suffix === '.ps1') return 'ps1'
  return 'bare'
}

/** Pure PATH scan: which of `names` resolve to something runnable. No shell, no side effects. */
export function resolveTools(
  names: readonly string[],
  pathEntries: readonly string[],
  platform: EnvironmentProbePlatform,
): Map<string, ResolvedEnvironmentTool> {
  const suffixes = candidateSuffixes(platform)
  const found = new Map<string, ResolvedEnvironmentTool>()
  for (const name of names) {
    for (const directory of pathEntries) {
      if (!directory) continue
      let resolved: ResolvedEnvironmentTool | undefined
      for (const suffix of suffixes) {
        try {
          const path = join(directory, `${name}${suffix}`)
          if (existsSync(path)) {
            resolved = { name, path, kind: kindOf(suffix) }
            break
          }
        } catch {
          // An unreadable directory is "not present there", not an error.
        }
      }
      if (resolved !== undefined) {
        found.set(name, resolved)
        break
      }
    }
  }
  return found
}

/** The names the scan resolved, for callers that only need presence. */
export function resolveToolPresence(
  names: readonly string[],
  pathEntries: readonly string[],
  platform: EnvironmentProbePlatform,
): Set<string> {
  return new Set(resolveTools(names, pathEntries, platform).keys())
}

function comSpec(): string {
  return process.env.ComSpec ?? process.env.COMSPEC ?? 'cmd.exe'
}

/**
 * Turns one raw version line into a short fact.
 *
 * Tools disagree wildly: `node -v` prints `v24.18.0`, `git --version` prints
 * `git version 2.45.1.windows.1`, `pip` appends the interpreter path. The
 * injected layer only needs the version itself, so the self-reference and the
 * trailing prose are stripped and the result is bounded.
 */
export function normalizeVersionLine(toolName: string, line: string): string {
  const escaped = toolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const text = line.trim()
    .replace(new RegExp(`^${escaped}\\s+`, 'i'), '')
    .replace(/^version\s+/i, '')
    .trim()
  const match = /v?\d+(?:\.\d+)+(?:[-+][\w.]+)?/.exec(text)
  if (match !== null) return match[0].slice(0, 32)
  return (text || line.trim()).slice(0, 32)
}

/**
 * One version probe.
 *
 * The first non-empty output line is the version fact; several tools print it
 * to stderr (java), so both streams are joined. A Windows `cmd`/`bat` shim
 * cannot be exec'd directly, and handing its absolute path to `cmd /c` breaks
 * inside directories with spaces, so the bare file name is used and resolves
 * through the very PATH the scan walked. A PowerShell-only shim stays
 * unversioned rather than spawning a second shell to read one line.
 */
export async function probeToolVersion(tool: ResolvedEnvironmentTool, args: readonly string[]): Promise<string | undefined> {
  if (tool.kind === 'ps1') return undefined
  const viaCommandProcessor = tool.kind === 'cmd' || tool.kind === 'bat'
  const command = viaCommandProcessor ? comSpec() : tool.path
  const argv = viaCommandProcessor ? ['/c', basename(tool.path), ...args] : [...args]
  try {
    const { stdout, stderr } = await execFileAsync(command, argv, {
      timeout: 2_000,
      windowsHide: true,
      maxBuffer: 64 * 1024,
    })
    const line = [stdout, stderr].join('\n').split('\n').map((entry) => entry.trim()).find((entry) => entry !== '')
    if (line === undefined || line === '') return undefined
    return line.slice(0, 64)
  } catch {
    return undefined
  }
}

export interface EnvironmentProbeDeps {
  /** Override the host platform (tests, or probing through a remote battery in P3). */
  platform?: EnvironmentProbePlatform
  arch?: string
  /** Profile identity; defaults to `local`. */
  profileId?: string
  /** The PATH directories to scan. Defaults to the live process PATH. */
  pathEntries?: string[]
  /**
   * `fast` answers presence only - a pure PATH scan that spawns nothing and
   * costs a few stat calls, so it may run inside a live turn. `full` adds the
   * fixed version battery and belongs to an explicit refresh.
   */
  tier?: EnvironmentProbeTier
  /** ISO timestamp for `probedAt`/`lastCheckedAt`; defaults to the live clock. */
  clock?: () => string
  /** Runs one version probe; defaults to the fixed execFile battery. */
  runVersionProbe?: (tool: ResolvedEnvironmentTool, args: readonly string[]) => Promise<string | undefined>
  /** Concurrency cap for the version tier. */
  versionConcurrency?: number
  /**
   * User-added CLI names. They are probed exactly like the built-in battery
   * but carry `source: 'custom'`, so a refresh can tell them apart from the
   * shipped list instead of dropping them.
   */
  extraTools?: readonly EnvironmentToolProbe[]
}

export type EnvironmentProbeTier = 'fast' | 'full'

const OS_LABELS: Record<EnvironmentProbePlatform, EnvironmentProfile['os']> = {
  win32: 'windows',
  darwin: 'macos',
  linux: 'linux',
}

/**
 * Best-effort shell dialect. P0 records which dialect the host commands run
 * through; the constrained-language flag stays optional and is filled by a
 * dedicated probe tier later, never guessed.
 */
function detectShell(presence: Set<string>, platform: EnvironmentProbePlatform): string {
  if (platform === 'win32') {
    if (presence.has('pwsh')) return 'pwsh'
    if (presence.has('powershell')) return 'powershell'
    return 'cmd'
  }
  if (presence.has('zsh')) return 'zsh'
  if (presence.has('bash')) return 'bash'
  return 'sh'
}

export async function probeLocalEnvironment(deps: EnvironmentProbeDeps = {}): Promise<EnvironmentProfile> {
  const platform = deps.platform ?? (process.platform as EnvironmentProbePlatform)
  const arch = deps.arch ?? process.arch
  const pathEntries = deps.pathEntries ?? (typeof process.env.PATH === 'string' ? process.env.PATH.split(platform === 'win32' ? ';' : ':') : [])
  const clock = deps.clock ?? (() => new Date().toISOString())
  const runVersionProbe = deps.runVersionProbe ?? probeToolVersion
  const concurrency = Math.max(1, deps.versionConcurrency ?? 8)

  const probes = [...BUILTIN_ENVIRONMENT_TOOLS, ...(deps.extraTools ?? [])]
  const builtin = new Set(builtinToolNames())
  const resolved = resolveTools(probes.map((probe) => probe.name), pathEntries, platform)
  const presence = new Set(resolved.keys())
  const shell = detectShell(presence, platform)

  // The version battery only runs on the full tier, and only for tools the
  // PATH scan actually found. The fast tier must never spawn a process: it is
  // the one that may execute inside a live conversation turn.
  const pending = deps.tier === 'fast'
    ? []
    : probes.flatMap((probe) => {
        const tool = resolved.get(probe.name)
        if (tool === undefined) return []
        if (probe.useVersionLadder === true) return CUSTOM_VERSION_LADDER.map((args) => ({ tool, args }))
        return probe.versionArgs === undefined ? [] : [{ tool, args: probe.versionArgs }]
      })
  const versions = new Map<string, string>()
  let cursor = 0
  const workers = Array.from({ length: Math.min(concurrency, pending.length) }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= pending.length) return
      const entry = pending[index]!
      const version = await runVersionProbe(entry.tool, entry.args)
      // The first rung that answers wins; later ladder attempts must not
      // overwrite a real version with usage text.
      if (version !== undefined && !versions.has(entry.tool.name)) {
        versions.set(entry.tool.name, normalizeVersionLine(entry.tool.name, version))
      }
    }
  })
  await Promise.all(workers)

  const now = clock()
  const tools: Record<string, EnvironmentProfileTool> = {}
  for (const probe of probes) {
    const version = versions.get(probe.name)
    tools[probe.name] = {
      present: presence.has(probe.name),
      source: builtin.has(probe.name) ? 'builtin' : 'custom',
      lastCheckedAt: now,
      ...(version === undefined ? {} : { version }),
    }
  }

  const presenceIdentity = presenceSignature(tools)
  const os = OS_LABELS[platform]
  return {
    schemaVersion: ENVIRONMENT_PROFILE_SCHEMA_VERSION,
    profileId: deps.profileId ?? 'local',
    os,
    arch,
    shell,
    tools,
    notes: [],
    probedAt: now,
    fastSignature: presenceIdentity,
    fullDirty: false,
  }
}

/**
 * Fixed argument ladder for a user-added CLI. The owner never gets to type a
 * command line: one of these four constant invocations either prints a version
 * or it does not.
 */
const CUSTOM_VERSION_LADDER: readonly (readonly string[])[] = [['--version'], ['-v'], ['-V'], ['version']]

/** Presence (pure PATH scan) plus a best-effort version for one added name. */
export async function probeCustomTool(
  name: string,
  deps: EnvironmentProbeDeps = {},
): Promise<{ present: boolean; version?: string }> {
  const platform = deps.platform ?? (process.platform as EnvironmentProbePlatform)
  const pathEntries = deps.pathEntries ?? (typeof process.env.PATH === 'string' ? process.env.PATH.split(platform === 'win32' ? ';' : ':') : [])
  const tool = resolveTools([name], pathEntries, platform).get(name)
  if (tool === undefined) return { present: false }
  const runVersionProbe = deps.runVersionProbe ?? probeToolVersion
  for (const args of CUSTOM_VERSION_LADDER) {
    const version = await runVersionProbe(tool, args)
    if (version !== undefined) return { present: true, version: normalizeVersionLine(name, version) }
  }
  return { present: true }
}

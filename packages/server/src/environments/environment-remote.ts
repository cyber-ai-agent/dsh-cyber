import type { EnvironmentProfile, EnvironmentProfileTool } from '@dsh-cyber/contracts'
import { ENVIRONMENT_PROFILE_SCHEMA_VERSION } from '@dsh-cyber/contracts'

import { presenceSignature } from './environment-change-collector.js'
import {
  BUILTIN_ENVIRONMENT_TOOLS,
  normalizeVersionLine,
  type EnvironmentProbeTier,
  type EnvironmentToolProbe,
} from './environment-probe.js'

/**
 * Remote machine profiles, probed over the SSH integration the owner already
 * configured.
 *
 * `sshExecOnce` opens a fresh connection per call, so the whole battery is ONE
 * compound command: `uname`, `$SHELL`, then one `command -v` per whitelisted
 * tool (plus its fixed version invocation on the full tier). Nothing from the
 * model or the conversation is ever concatenated into that command - the only
 * interpolated values are the fixed tool names and their fixed argument lists.
 *
 * A host that answers without `uname` (Windows over SSH) yields no profile at
 * all: the contract's `os` is a fact, never a guess.
 */

export type EnvironmentExec = (command: string) => Promise<{ code: number | null; stdout: string; stderr: string }>

export interface EnvironmentDeviceTarget {
  /** `ssh:<connectionId>`; the same key the character's grants use. */
  profileId: string
  displayName: string
  host: string
  exec: EnvironmentExec
}

/**
 * Which devices a character may actually reach. Implementations resolve the
 * character's durable connection grants, so a device the character was never
 * granted can never appear in its prompt.
 */
export interface EnvironmentDeviceSource {
  targets(input: { worldId: string; characterId: string }): Promise<readonly EnvironmentDeviceTarget[]>
}

/** One compound command; the only interpolations are fixed tool names and args. */
export function buildRemoteProbeCommand(tier: EnvironmentProbeTier, extraTools: readonly EnvironmentToolProbe[] = []): string {
  const parts = [
    'printf "OS:%s\\n" "$(uname -s 2>/dev/null)"',
    'printf "ARCH:%s\\n" "$(uname -m 2>/dev/null)"',
    'printf "SHELL:%s\\n" "${SHELL:-}"',
  ]
  for (const probe of [...BUILTIN_ENVIRONMENT_TOOLS, ...extraTools]) {
    const name = probe.name
    if (tier === 'fast') {
      parts.push(`command -v ${name} >/dev/null 2>&1 && printf "T:${name}=1\\n" || printf "T:${name}=0\\n"`)
      continue
    }
    const args = (probe.versionArgs ?? ['--version']).join(' ')
    parts.push(
      `if command -v ${name} >/dev/null 2>&1; then printf "T:${name}=1\\n"; printf "V:${name}=%s\\n" "$(${name} ${args} 2>&1 | head -n 1)"; else printf "T:${name}=0\\n"; fi`,
    )
  }
  return parts.join('; ')
}

export interface RemoteProbeFacts {
  os?: EnvironmentProfile['os']
  arch?: string
  shell?: string
  tools: Record<string, { present: boolean; version?: string }>
}

const OS_LABELS: Record<string, EnvironmentProfile['os']> = {
  Linux: 'linux',
  Darwin: 'macos',
}

/** Parses the marker lines the battery prints. Unknown markers are ignored. */
export function parseRemoteProbeOutput(stdout: string): RemoteProbeFacts {
  const facts: RemoteProbeFacts = { tools: {} }
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('OS:')) {
      const os = OS_LABELS[line.slice(3).trim()]
      if (os !== undefined) facts.os = os
      continue
    }
    if (line.startsWith('ARCH:')) {
      const arch = line.slice(5).trim()
      if (arch !== '') facts.arch = arch
      continue
    }
    if (line.startsWith('SHELL:')) {
      const shell = line.slice(6).trim().split(/[/\\]/).pop() ?? ''
      if (shell !== '') facts.shell = shell
      continue
    }
    if (line.startsWith('T:')) {
      const [name, flag] = line.slice(2).split('=')
      if (name === undefined || name === '' || (flag !== '0' && flag !== '1')) continue
      facts.tools[name] = { present: flag === '1' }
      continue
    }
    if (line.startsWith('V:')) {
      const [name, ...rest] = line.slice(2).split('=')
      const version = rest.join('=').trim()
      if (name === undefined || name === '' || version === '') continue
      const existing = facts.tools[name] ?? { present: true }
      facts.tools[name] = { ...existing, version: normalizeVersionLine(name, version) }
    }
  }
  return facts
}

export interface RemoteProbeInput {
  profileId: string
  tier: EnvironmentProbeTier
  exec: EnvironmentExec
  clock?: () => string
  extraTools?: readonly EnvironmentToolProbe[]
}

/**
 * Probes one device. Returns undefined when the host answered in a shape the
 * contract cannot describe truthfully (no `uname`, or an empty answer).
 */
export async function probeRemoteEnvironment(input: RemoteProbeInput): Promise<EnvironmentProfile | undefined> {
  const result = await input.exec(buildRemoteProbeCommand(input.tier, input.extraTools ?? []))
  const facts = parseRemoteProbeOutput(result.stdout)
  if (facts.os === undefined) return undefined
  const now = (input.clock ?? (() => new Date().toISOString()))()
  const tools: Record<string, EnvironmentProfileTool> = {}
  for (const probe of [...BUILTIN_ENVIRONMENT_TOOLS, ...(input.extraTools ?? [])]) {
    const fact = facts.tools[probe.name]
    const present = fact?.present === true
    tools[probe.name] = {
      present,
      source: BUILTIN_ENVIRONMENT_TOOLS.some((builtin) => builtin.name === probe.name) ? 'builtin' : 'custom',
      lastCheckedAt: now,
      ...(present && fact?.version !== undefined ? { version: fact.version } : {}),
    }
  }
  return {
    schemaVersion: ENVIRONMENT_PROFILE_SCHEMA_VERSION,
    profileId: input.profileId,
    os: facts.os,
    arch: facts.arch ?? 'unknown',
    shell: facts.shell ?? 'sh',
    tools,
    notes: [],
    probedAt: now,
    fastSignature: presenceSignature(tools),
    fullDirty: input.tier === 'fast',
  }
}

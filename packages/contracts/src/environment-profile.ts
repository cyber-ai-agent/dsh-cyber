/**
 * The machine (or device) profile: host-probed, deterministic facts about the
 * environment an agent turn runs on.
 *
 * The profile is data, never instructions. Every field is produced by the host
 * (probe, deterministic failure signature, or explicit user entry) - model
 * narrative must never reach it, because its rendered layer sits in the
 * cacheable prefix of every turn.
 *
 * What is durable here and what is not:
 * - `tools`, `os`, `arch`, `shell` are facts the probe re-derives;
 * - `notes` are bounded host-owned operating notes that survive refreshes;
 * - `probedAt` and `fastSignature` are metadata for refresh decisions and are
 *   deliberately excluded from any rendered context text.
 */

export const ENVIRONMENT_PROFILE_SCHEMA_VERSION = 1 as const

export type EnvironmentProfileOs = 'windows' | 'macos' | 'linux'

export type EnvironmentProfileNoteSource = 'probe' | 'failure-signature' | 'user'

export interface EnvironmentProfileTool {
  present: boolean
  /** Populated by the full probe tier; absent when unknown. */
  version?: string
  source: 'builtin' | 'custom'
  lastCheckedAt: string
}

export interface EnvironmentProfileNote {
  id: string
  /** Bounded, host-owned statement. No model text. */
  text: string
  source: EnvironmentProfileNoteSource
  createdAt: string
}

export interface EnvironmentProfile {
  schemaVersion: typeof ENVIRONMENT_PROFILE_SCHEMA_VERSION
  /** `local` for the host machine, an integration id for a remote device. */
  profileId: string
  os: EnvironmentProfileOs
  arch: string
  /** The shell dialect the host runs commands through (pwsh, bash, zsh). */
  shell: string
  /** Best-effort flag, e.g. PowerShell constrained-language mode. */
  shellRestricted?: boolean
  tools: Record<string, EnvironmentProfileTool>
  notes: EnvironmentProfileNote[]
  /** When the full tier last ran. Metadata only; never rendered. */
  probedAt: string
  /** Content identity of the presence list; fast-tier change detection. */
  fastSignature: string
  /** A full refresh is owed. Set by the fast tier and TTL, cleared by one. */
  fullDirty: boolean
}

export const ENVIRONMENT_PROFILE_MAX_NOTES = 10
export const ENVIRONMENT_PROFILE_NOTE_TEXT_LIMIT = 120

const NOTE_TEXT_RE = /^[\p{L}\p{N}\p{M}\p{P}\p{S}\s]{1,}$/u

/** Normalizes and validates a persisted profile. Returns undefined for data that must not be trusted. */
export function normalizeEnvironmentProfile(value: unknown): EnvironmentProfile | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const input = value as Record<string, unknown>
  if (input.schemaVersion !== ENVIRONMENT_PROFILE_SCHEMA_VERSION) return undefined
  if (typeof input.profileId !== 'string' || !/^[a-z0-9][a-z0-9._:-]*$/i.test(input.profileId)) return undefined
  if (input.os !== 'windows' && input.os !== 'macos' && input.os !== 'linux') return undefined
  if (typeof input.arch !== 'string' || !input.arch.trim() || input.arch.length > 32) return undefined
  if (typeof input.shell !== 'string' || !input.shell.trim() || input.shell.length > 32) return undefined
  if (typeof input.probedAt !== 'string' || input.probedAt.length > 40) return undefined
  if (typeof input.fastSignature !== 'string' || !/^[0-9a-f]{32}$/.test(input.fastSignature)) return undefined
  if (typeof input.fullDirty !== 'boolean') return undefined

  if (typeof input.tools !== 'object' || input.tools === null || Array.isArray(input.tools)) return undefined
  const tools: Record<string, EnvironmentProfileTool> = {}
  for (const [name, raw] of Object.entries(input.tools)) {
    if (!/^[a-z0-9][a-z0-9._:-]{0,63}$/i.test(name)) continue
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue
    const tool = raw as Record<string, unknown>
    if (typeof tool.present !== 'boolean') continue
    const entry: EnvironmentProfileTool = {
      present: tool.present,
      source: tool.source === 'custom' ? 'custom' : 'builtin',
      lastCheckedAt: typeof tool.lastCheckedAt === 'string' && tool.lastCheckedAt.length <= 40 ? tool.lastCheckedAt : '',
    }
    if (typeof tool.version === 'string' && tool.version.trim() && tool.version.length <= 64) entry.version = tool.version.trim()
    tools[name] = entry
  }

  const notes: EnvironmentProfileNote[] = []
  if (Array.isArray(input.notes)) {
    for (const raw of input.notes) {
      if (notes.length >= ENVIRONMENT_PROFILE_MAX_NOTES) break
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue
      const note = raw as Record<string, unknown>
      if (typeof note.id !== 'string' || note.id.length > 64) continue
      const text = typeof note.text === 'string' ? note.text.trim().replace(/\s+/g, ' ').slice(0, ENVIRONMENT_PROFILE_NOTE_TEXT_LIMIT) : ''
      if (!text || !NOTE_TEXT_RE.test(text)) continue
      const source: EnvironmentProfileNoteSource =
        note.source === 'probe' || note.source === 'failure-signature' || note.source === 'user' ? note.source : 'probe'
      notes.push({
        id: note.id,
        text,
        source,
        createdAt: typeof note.createdAt === 'string' && note.createdAt.length <= 40 ? note.createdAt : '',
      })
    }
    notes.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
  }

  return {
    schemaVersion: ENVIRONMENT_PROFILE_SCHEMA_VERSION,
    profileId: input.profileId,
    os: input.os,
    arch: input.arch.trim(),
    shell: input.shell.trim(),
    ...(typeof input.shellRestricted === 'boolean' ? { shellRestricted: input.shellRestricted } : {}),
    tools,
    notes,
    probedAt: input.probedAt,
    fastSignature: input.fastSignature,
    fullDirty: input.fullDirty,
  }
}

import {
  contextContentHash,
  ENVIRONMENT_PROFILE_MAX_NOTES,
  ENVIRONMENT_PROFILE_NOTE_TEXT_LIMIT,
  type EnvironmentProfile,
  type EnvironmentProfileNote,
  type EnvironmentProfileTool,
} from '@dsh-cyber/contracts'

/**
 * Learns environment facts from what actually ran.
 *
 * The collector is deliberately deaf to model prose: it reads only host
 * observations - the command a shell tool was given, whether the call failed,
 * its exit code and its own output - and only three deterministic signatures
 * may change the profile:
 *
 * 1. a tool the profile calls absent ran successfully;
 * 2. a tool the profile calls present failed with a command-not-found shape;
 * 3. a call failed with a concrete host restriction (EPERM/EACCES/...).
 *
 * Everything else, including a model saying "ffmpeg is not installed", is
 * ignored. That is what keeps the rendered layer free of prompt-injection
 * surface and free of hallucinated facts.
 */

export interface EnvironmentSignal {
  /** The harness tool that ran, e.g. `pwsh`, `read`, `write`. */
  toolName?: string
  /** Raw parameter text when the call was command-shaped: the command line. */
  command?: string
  failed: boolean
  exitCode?: number
  /** The tool's own output text, bounded by the caller. */
  output?: string
}

export interface EnvironmentChangeDeps {
  clock?: () => string
}

export interface EnvironmentChange {
  profile: EnvironmentProfile
  /** Host-worded statements describing what this signal taught. */
  changes: string[]
}

const SHELL_TOOL = /^(?:pwsh|powershell|bash|sh|zsh|cmd|exec|shell|run_command|runcommand|terminal|local_shell|ssh|ssh-exec)$/i

/** Output shapes that only a failed command lookup produces. */
const COMMAND_NOT_FOUND = [
  /command not found/i,
  /is not recognized as an internal or external command/i,
  /is not recognized as the name of a cmdlet/i,
  /不是内部或外部命令/,
  /无法将.{0,60}识别为/,
  /系统找不到指定的文件/,
]

/** Concrete host restrictions; deliberately excludes prose that merely mentions sandboxes. */
const RESTRICTED: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /\bEPERM\b|operation not permitted/i, label: '权限被拒绝（EPERM）' },
  { pattern: /\bEACCES\b|permission denied/i, label: '权限被拒绝（EACCES）' },
  { pattern: /ConstrainedLanguage/i, label: 'PowerShell 受限语言模式' },
  { pattern: /read-only file system/i, label: '只读文件系统' },
  { pattern: /拒绝访问|不允许的操作/, label: '权限被拒绝' },
]

/**
 * The bare command name a shell tool was asked to run.
 *
 * Deterministic and conservative: first token of the first non-empty line,
 * quotes stripped, directory dropped, a Windows launcher suffix removed.
 * Anything that does not look like a command name yields undefined, and a
 * signal without a name can only ever contribute a restriction note.
 */
export function commandName(command: string | undefined): string | undefined {
  if (command === undefined) return undefined
  const line = command.split(/\r?\n/).map((entry) => entry.trim()).find((entry) => entry !== '') ?? ''
  const withoutOperators = line.replace(/^[&;|]+\s*/, '')
  // A quoted first token may contain spaces: "C:\Program Files\Git\cmd\git.exe".
  const quoted = /^["']([^"']+)["']/.exec(withoutOperators)
  const token = quoted === null ? (withoutOperators.split(/\s+/)[0] ?? '') : quoted[1]!
  const base = token.split(/[\\/]/).pop() ?? ''
  const name = base.replace(/\.(?:exe|cmd|bat|ps1)$/i, '').toLowerCase()
  return /^[a-z0-9][a-z0-9._+-]{0,63}$/.test(name) ? name : undefined
}

/** True when the output is a command lookup failure for exactly this name. */
export function isCommandNotFound(name: string, output: string): boolean {
  if (COMMAND_NOT_FOUND.some((pattern) => pattern.test(output))) return true
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // `sh: 1: ffmpeg: not found` and a bare exec failure. The name must own the
  // line, so `python missing.py` complaining about a file cannot match.
  return new RegExp(`^\\s*(?:\\S+:\\s+)?(?:\\d+:\\s+)?${escaped}:\\s+(?:not found|no such file or directory)\\s*$`, 'im').test(output)
}

export function restrictedLabel(output: string): string | undefined {
  return RESTRICTED.find(({ pattern }) => pattern.test(output))?.label
}

/** One deterministic signal folded into a profile. Never throws; never mutates the input. */
export function applyEnvironmentSignal(
  profile: EnvironmentProfile,
  signal: EnvironmentSignal,
  deps: EnvironmentChangeDeps = {},
): EnvironmentChange {
  const output = signal.output ?? ''
  const shellCall = signal.toolName !== undefined && SHELL_TOOL.test(signal.toolName)
  const name = shellCall ? commandName(signal.command) : undefined
  const known = name === undefined ? undefined : profile.tools[name]

  // ① The profile said absent, the host ran it successfully.
  if (!signal.failed && known !== undefined && !known.present) {
    const tools = { ...profile.tools, [name!]: { ...known, present: true } }
    return {
      profile: withPresence(profile, tools),
      changes: [`新增可用：${name!}`],
    }
  }

  // ② The profile said present, the host could not find it.
  if (signal.failed && known !== undefined && known.present && isCommandNotFound(name!, output)) {
    const tools = {
      ...profile.tools,
      [name!]: { present: false, source: known.source, lastCheckedAt: known.lastCheckedAt },
    }
    return {
      profile: withNote(withPresence(profile, tools), {
        text: `${name!} 在本机不可用：命令未找到`,
        source: 'failure-signature',
        ...(deps.clock === undefined ? {} : { clock: deps.clock }),
      }),
      changes: [`不再可用：${name!}`],
    }
  }

  // ③ A concrete host restriction, recorded as a bounded host-owned note.
  if (signal.failed) {
    const label = restrictedLabel(output)
    if (label !== undefined) {
      const subject = name ?? signal.toolName ?? '命令'
      const text = `${subject} 受限制：${label}`
      const next = withNote(profile, { text, source: 'failure-signature', ...(deps.clock === undefined ? {} : { clock: deps.clock }) })
      return next === profile ? { profile, changes: [] } : { profile: next, changes: [`受限制：${subject}（${label}）`] }
    }
  }

  return { profile, changes: [] }
}

function withPresence(profile: EnvironmentProfile, tools: Record<string, EnvironmentProfileTool>): EnvironmentProfile {
  return {
    ...profile,
    tools,
    fastSignature: presenceSignature(tools),
    // Presence moved without a full probe, so the version tier is owed.
    fullDirty: true,
  }
}

function withNote(
  profile: EnvironmentProfile,
  note: { text: string; source: EnvironmentProfileNote['source']; clock?: () => string },
): EnvironmentProfile {
  const text = note.text.trim().replace(/\s+/g, ' ').slice(0, ENVIRONMENT_PROFILE_NOTE_TEXT_LIMIT)
  if (!text) return profile
  if (profile.notes.some((existing) => existing.text === text)) return profile
  const entry: EnvironmentProfileNote = {
    id: `sig-${contextContentHash(text).slice(0, 12)}`,
    text,
    source: note.source,
    createdAt: (note.clock ?? (() => new Date().toISOString()))(),
  }
  const notes = [...profile.notes, entry].slice(-ENVIRONMENT_PROFILE_MAX_NOTES)
  return { ...profile, notes }
}

/** Presence identity: the same hash the probe publishes as `fastSignature`. */
export function presenceSignature(tools: Record<string, EnvironmentProfileTool>): string {
  return contextContentHash(Object.fromEntries(
    Object.entries(tools)
      .map(([name, tool]): [string, boolean] => [name, tool.present])
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  ))
}

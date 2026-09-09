import {
  composeContextLayer,
  estimateTextTokens,
  type ContextLayer,
  type ContextSourceRef,
  type EnvironmentProfile,
} from '@dsh-cyber/contracts'

/**
 * Renders machine profiles into the cacheable `environment` context layer.
 *
 * The text is a pure function of the profile content: tool names are sorted
 * by byte order, notes keep their id order, and no timestamp or counter
 * leaks in - the layer sits in the prompt's stable prefix, and any moving
 * byte would defeat the cache it protects. `probedAt` and `fastSignature`
 * are refresh metadata and are deliberately absent from the text.
 *
 * One layer can carry several profiles - the host machine plus the devices the
 * character was actually granted. They share one deterministic degradation
 * ladder, and remote blocks are dropped before the local one.
 */

export const ENVIRONMENT_LAYER_DEFAULT_BUDGET_TOKENS = 300
export const ENVIRONMENT_LAYER_INSTRUCTION = '命令是否可用的实时确认请用 shell 现场查询（where / command -v / Get-Command），不要盲试。'

export interface ComposeEnvironmentLayerOptions {
  /** Layer identity; defaults to `environment:<profileId>`. */
  id?: string
  /** Hard token bound for the layer text. */
  budgetTokens?: number
}

export interface EnvironmentProfileEntry {
  profile: EnvironmentProfile
  /** Reader-facing device name; the local profile needs none. */
  label?: string
}

const OS_LABELS: Record<EnvironmentProfile['os'], string> = {
  windows: 'Windows',
  macos: 'macOS',
  linux: 'Linux',
}

interface RenderOptions {
  /** Keep version strings next to tool names. */
  versions: boolean
  missing: boolean
  notes: boolean
}

function sortToolNames(names: string[]): string[] {
  return [...names].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
}

function renderInstalled(profile: EnvironmentProfile, options: RenderOptions): string | undefined {
  const entries = Object.entries(profile.tools)
    .filter(([, tool]) => tool.present)
    .map(([name, tool]) => (options.versions && tool.version !== undefined ? `${name} ${tool.version}` : name))
  if (entries.length === 0) return undefined
  return `已安装: ${sortToolNames(entries).join(', ')}`
}

function renderMissing(profile: EnvironmentProfile): string | undefined {
  const names = sortToolNames(Object.entries(profile.tools).filter(([, tool]) => !tool.present).map(([name]) => name))
  if (names.length === 0) return undefined
  return `未安装: ${names.join(', ')}`
}

function headerFor(entry: EnvironmentProfileEntry): string {
  if (entry.profile.profileId === 'local') return '[本机环境档案]'
  return `[设备档案 ${entry.label ?? entry.profile.profileId}]`
}

function renderBlock(entry: EnvironmentProfileEntry, options: RenderOptions): string[] {
  const { profile } = entry
  const lines: string[] = [
    headerFor(entry),
    `系统: ${OS_LABELS[profile.os]} ${profile.arch} · shell: ${profile.shell}${profile.shellRestricted ? '（受限模式）' : ''}`,
  ]
  const installed = renderInstalled(profile, options)
  if (installed !== undefined) lines.push(installed)
  if (options.missing) {
    const missing = renderMissing(profile)
    if (missing !== undefined) lines.push(missing)
  }
  if (options.notes && profile.notes.length > 0) {
    lines.push('注意事项:')
    lines.push(...profile.notes.map((note) => `- ${note.text}`))
  }
  return lines
}

function renderText(entries: readonly EnvironmentProfileEntry[], options: RenderOptions): string {
  return [...entries.flatMap((entry) => renderBlock(entry, options)), ENVIRONMENT_LAYER_INSTRUCTION].join('\n')
}

function layerBudget(budgetTokens: number | undefined): number {
  return Number.isSafeInteger(budgetTokens) && (budgetTokens ?? 0) > 0
    ? Math.min(4096, budgetTokens!)
    : ENVIRONMENT_LAYER_DEFAULT_BUDGET_TOKENS
}

function layerId(entries: readonly EnvironmentProfileEntry[], requested: string | undefined): string {
  if (requested !== undefined) return requested
  if (entries.length === 1) return `environment:${entries[0]!.profile.profileId}`
  return 'environment:machine'
}

function sourceRefs(entries: readonly EnvironmentProfileEntry[]): ContextSourceRef[] {
  return entries.map((entry) => ({
    kind: 'environment',
    id: entry.profile.profileId,
    revision: entry.profile.fastSignature,
  }))
}

/**
 * Composes one layer from one or more profiles, degrading deterministically
 * until the text fits: remote device blocks first, then versions, then missing
 * lists, then notes, then trailing installed entries. The local block's header,
 * system line and the live-check instruction survive every step.
 */
export function composeEnvironmentLayerSet(
  entries: readonly EnvironmentProfileEntry[],
  options: ComposeEnvironmentLayerOptions = {},
): ContextLayer | undefined {
  if (entries.length === 0) return undefined
  const budget = layerBudget(options.budgetTokens)
  const full: RenderOptions = { versions: true, missing: true, notes: true }

  let kept = [...entries]
  let text = renderText(kept, full)
  // A device is useful, never load-bearing: shed remote blocks before the host's own.
  while (estimateTextTokens(text) > budget && kept.length > 1) {
    kept = kept.slice(0, -1)
    text = renderText(kept, full)
  }
  if (estimateTextTokens(text) > budget) {
    text = renderText(kept, { ...full, versions: false })
    if (estimateTextTokens(text) > budget) text = renderText(kept, { versions: false, missing: false, notes: true })
    if (estimateTextTokens(text) > budget) text = renderText(kept, { versions: false, missing: false, notes: false })
  }
  if (estimateTextTokens(text) > budget) {
    // Last resort: drop installed entries from the tail of the last block.
    const last = kept[kept.length - 1]!
    let names = Object.keys(last.profile.tools)
    while (names.length > 1) {
      names = names.filter((name) => last.profile.tools[name]?.present).slice(0, -1)
      const reduced: EnvironmentProfileEntry = {
        ...last,
        profile: {
          ...last.profile,
          tools: Object.fromEntries(Object.entries(last.profile.tools).filter(([name]) => names.includes(name))),
        },
      }
      text = renderText([...kept.slice(0, -1), reduced], { versions: false, missing: false, notes: false })
      if (estimateTextTokens(text) <= budget) break
    }
  }

  return composeContextLayer({
    id: layerId(kept, options.id),
    kind: 'environment',
    text,
    sourceRefs: sourceRefs(kept),
  })
}

/** The single-profile case, kept for callers that only ever have the host. */
export function composeEnvironmentLayer(profile: EnvironmentProfile, options: ComposeEnvironmentLayerOptions = {}): ContextLayer {
  const layer = composeEnvironmentLayerSet([{ profile }], options)
  if (layer === undefined) throw new Error('环境档案层需要至少一个档案')
  return layer
}

import type { ContextLayer, EnvironmentProfile } from '@dsh-cyber/contracts'
import { composeEnvironmentLayerSet, type ComposeEnvironmentLayerOptions, type EnvironmentProfileEntry } from './environment-context-layer.js'
import { applyEnvironmentSignal, presenceSignature, type EnvironmentSignal } from './environment-change-collector.js'
import { probeCustomTool, probeLocalEnvironment, type EnvironmentProbeDeps, type EnvironmentProbeTier } from './environment-probe.js'
import { probeRemoteEnvironment, type EnvironmentDeviceSource, type EnvironmentDeviceTarget } from './environment-remote.js'
import { EnvironmentProfileStore } from './environment-store.js'

export const LOCAL_ENVIRONMENT_PROFILE_ID = 'local'

/**
 * One rendered machine profile plus the facts a caller needs to describe a
 * later change without re-parsing the text.
 */
export interface EnvironmentSnapshot {
  layer: ContextLayer
  /** Tool names the profile confirmed present, sorted. */
  present: readonly string[]
}

/**
 * How stale a stored profile may be before a conversation boundary re-probes.
 *
 * Presence is cheap to re-derive (a PATH scan, no process), so it is allowed
 * to drift for half an hour; versions cost a real subprocess battery, so they
 * are only re-derived once a day - or when the owner asks.
 */
export const FAST_REFRESH_TTL_MS = 30 * 60_000
export const FULL_REFRESH_TTL_MS = 24 * 60 * 60_000

export interface EnvironmentSnapshotInput {
  worldId: string
  characterId: string
  /**
   * True on the first turn of a conversation lane. Only a boundary may probe:
   * mid-lane the profile stays exactly what the lane pinned.
   */
  laneBoundary?: boolean
}

/**
 * The narrow port the character runtime consumes for environment injection.
 *
 * It returns undefined instead of an empty layer so legacy embedders and
 * pre-probe states keep their exact prompt - a machine profile is data the
 * host owns, never a placeholder.
 */
export interface EnvironmentContextPort {
  snapshot(input: EnvironmentSnapshotInput): Promise<EnvironmentSnapshot | undefined>
  /** Host-observed run facts. Implementations may ignore them entirely. */
  applySignals?(signals: readonly EnvironmentSignal[], profileId?: string): Promise<unknown>
}

export interface EnvironmentServiceOptions {
  /** Injected probe for tests; defaults to the fixed local battery. */
  probe?: (tier: EnvironmentProbeTier) => Promise<EnvironmentProfile>
  /** Injected single-tool probe for tests; defaults to the PATH scan + fixed ladder. */
  probeCustomTool?: (name: string) => Promise<{ present: boolean; version?: string }>
  /** Injected remote probe for tests; defaults to one batched SSH round trip. */
  probeDevice?: (target: EnvironmentDeviceTarget, tier: EnvironmentProbeTier) => Promise<EnvironmentProfile | undefined>
  /** Which devices a character may reach; absent means local-only injection. */
  devices?: EnvironmentDeviceSource
  /** Extra dependencies passed through to the default probe (platform overrides, clocks). */
  probeDeps?: EnvironmentProbeDeps
  /** Timestamp source for learned notes; defaults to the live clock. */
  clock?: () => string
}

/**
 * The only shape a user-added CLI name may take.
 *
 * A name is a name, never a command line: the probe runs it with a fixed
 * argument ladder, so nothing the owner types is ever concatenated into a
 * shell invocation.
 */
export const CUSTOM_TOOL_NAME = /^[a-z0-9][a-z0-9._+-]{0,63}$/

/**
 * Host facade over the machine profile.
 *
 * P0 owns the local profile: probed on the first lane that needs it, durable
 * under `stateRoot/environments/`, and rendered into a cache-stable layer for
 * context injection. Remote device profiles share this facade in P3 with a
 * different profileId.
 */
export class EnvironmentService implements EnvironmentContextPort {
  readonly #store: EnvironmentProfileStore
  readonly #options: EnvironmentServiceOptions
  /**
   * One local probe at a time. Several lanes can cross their first boundary
   * together; they must share the fast PATH scan and its durable publish
   * instead of each lane paying for a separate fsync.
   */
  #localRefresh: { tier: EnvironmentProbeTier; promise: Promise<EnvironmentProfile> } | undefined

  constructor(store: EnvironmentProfileStore, options: EnvironmentServiceOptions = {}) {
    this.#store = store
    this.#options = options
  }

  /** The stored local profile, or undefined before the first successful refresh. */
  currentLocal(): EnvironmentProfile | undefined {
    return this.#store.load(LOCAL_ENVIRONMENT_PROFILE_ID)
  }

  /**
   * Refreshes the local profile.
   *
   * `fast` is the presence-only tier that may run inside a live turn: it
   * spawns nothing, keeps any version a previous full probe learned for a
   * tool that is still present, and marks the profile as still owing a full
   * refresh. `full` runs the whole version battery and belongs to an explicit
   * refresh trigger. Learned notes survive either tier - they are host
   * knowledge, not probe facts.
   */
  async refreshLocal(tier: EnvironmentProbeTier = 'full'): Promise<EnvironmentProfile> {
    const active = this.#localRefresh
    if (active !== undefined) {
      // A full refresh is at least as strong as a fast one, so a fast caller
      // can safely consume it. If a full refresh arrives while a fast one is
      // publishing, chain it after that publish instead of racing two writes.
      if (active.tier === 'full' || active.tier === tier) return active.promise
      if (tier === 'full') {
        const promise = active.promise
          .catch(() => undefined)
          .then(() => this.#refreshLocal(tier))
        this.#localRefresh = { tier, promise }
        return this.#awaitLocalRefresh(promise)
      }
    }
    const promise = this.#refreshLocal(tier)
    this.#localRefresh = { tier, promise }
    return this.#awaitLocalRefresh(promise)
  }

  async #refreshLocal(tier: EnvironmentProbeTier): Promise<EnvironmentProfile> {
    const existing = this.#store.load(LOCAL_ENVIRONMENT_PROFILE_ID)
    // Custom names are part of the battery from now on; a refresh that forgot
    // them would silently delete the owner's own entries.
    const extraTools = Object.entries(existing?.tools ?? {})
      .filter(([, tool]) => tool.source === 'custom')
      .map(([name]) => ({ name, useVersionLadder: true }))
    const probe = this.#options.probe
      ?? ((wanted: EnvironmentProbeTier) => probeLocalEnvironment({
        ...(this.#options.probeDeps ?? {}),
        tier: wanted,
        ...(extraTools.length === 0 ? {} : { extraTools }),
      }))
    const probed = await probe(tier)
    const presenceChanged = existing !== undefined && existing.fastSignature !== probed.fastSignature
    const profile: EnvironmentProfile = {
      ...probed,
      tools: mergeToolFacts(probed.tools, tier === 'fast' ? existing?.tools : undefined),
      notes: existing?.notes ?? probed.notes,
      // A full probe settles the version debt; a fast one keeps it and takes
      // it on whenever presence moved (or the profile is brand new and no
      // version was ever read), so the next boundary knows versions are owed.
      fullDirty: tier === 'full' ? false : (existing === undefined || existing.fullDirty === true || presenceChanged),
    }
    await this.#store.save(profile)
    return profile
  }

  async #awaitLocalRefresh(promise: Promise<EnvironmentProfile>): Promise<EnvironmentProfile> {
    try {
      return await promise
    } finally {
      if (this.#localRefresh?.promise === promise) this.#localRefresh = undefined
    }
  }

  /**
   * Adds one owner-declared CLI name and probes it once.
   *
   * The name is validated and used only as an executable name; its version is
   * read through a fixed argument ladder, never through a command line the
   * owner supplied. The entry is marked `custom` so a later refresh keeps it.
   */
  async addCustomTool(name: string): Promise<EnvironmentProfile> {
    const normalized = name.trim().toLowerCase()
    if (!CUSTOM_TOOL_NAME.test(normalized)) throw new Error('自定义工具名无效')
    const profile = this.currentLocal() ?? await this.refreshLocal('fast')
    if (profile.tools[normalized]?.source === 'builtin') throw new Error('内置工具无需添加')
    const probeCustom = this.#options.probeCustomTool
      ?? ((wanted: string) => probeCustomTool(wanted, this.#options.probeDeps ?? {}))
    const probed = await probeCustom(normalized)
    const tools: EnvironmentProfile['tools'] = {
      ...profile.tools,
      [normalized]: {
        present: probed.present,
        source: 'custom',
        lastCheckedAt: (this.#options.clock ?? (() => new Date().toISOString()))(),
        ...(probed.version === undefined ? {} : { version: probed.version }),
      },
    }
    const next: EnvironmentProfile = { ...profile, tools, fastSignature: presenceSignature(tools) }
    await this.#store.save(next)
    return next
  }

  /** Removes one owner-declared CLI name. Built-in entries are not removable. */
  async removeCustomTool(name: string): Promise<EnvironmentProfile> {
    const normalized = name.trim().toLowerCase()
    const profile = this.currentLocal()
    if (profile === undefined) throw new Error('本机环境档案尚未生成')
    if (profile.tools[normalized]?.source !== 'custom') throw new Error('只能删除自定义工具')
    const tools = { ...profile.tools }
    delete tools[normalized]
    const next: EnvironmentProfile = { ...profile, tools, fastSignature: presenceSignature(tools) }
    await this.#store.save(next)
    return next
  }

  /**
   * The cache-stable context layer for the local profile.
   *
   * The first lane that asks for it pays the fast probe once and the result is
   * durable from then on; later lanes read the stored profile. Probing here
   * rather than at process construction is deliberate: the write lands under
   * `stateRoot`, so it must finish inside a turn instead of racing a shutdown,
   * an upgrade or a state-root move. A failed probe returns nothing and leaves
   * the prompt untouched.
   */
  /** Local-only convenience for callers with no character context. */
  async snapshotLayer(options: ComposeEnvironmentLayerOptions = {}): Promise<ContextLayer | undefined> {
    return (await this.snapshot({ worldId: '', characterId: '' }, options))?.layer
  }

  /** The stored profile for any id: `local`, or `ssh:<connectionId>`. */
  profile(profileId: string): EnvironmentProfile | undefined {
    return this.#store.load(profileId)
  }

  /**
   * Probes one device over its own transport and stores the result.
   *
   * Remote probing is never implicit: it costs a real SSH round trip, so it
   * happens on an explicit refresh (the owner's button, or a dirty marker),
   * never inside a turn. A host that answers without `uname` yields no
   * profile rather than a guessed one.
   */
  async refreshDevice(target: EnvironmentDeviceTarget, tier: EnvironmentProbeTier = 'full'): Promise<EnvironmentProfile | undefined> {
    const existing = this.#store.load(target.profileId)
    const extraTools = Object.entries(existing?.tools ?? {})
      .filter(([, tool]) => tool.source === 'custom')
      .map(([name]) => ({ name, useVersionLadder: true }))
    const probe = this.#options.probeDevice
      ?? ((wanted: EnvironmentDeviceTarget, wantedTier: EnvironmentProbeTier) => probeRemoteEnvironment({
        profileId: wanted.profileId,
        tier: wantedTier,
        exec: wanted.exec,
        ...(this.#options.clock === undefined ? {} : { clock: this.#options.clock }),
        ...(extraTools.length === 0 ? {} : { extraTools }),
      }))
    const probed = await probe(target, tier)
    if (probed === undefined) return undefined
    const profile: EnvironmentProfile = {
      ...probed,
      tools: mergeToolFacts(probed.tools, tier === 'fast' ? existing?.tools : undefined),
      notes: existing?.notes ?? probed.notes,
    }
    await this.#store.save(profile)
    return profile
  }

  /**
   * The cache-stable layer for this character's machine facts.
   *
   * Probing happens only at a conversation boundary, and only when the stored
   * profile is owed a refresh: presence every half hour (or after a learned
   * change), versions once a day. Mid-lane this reads the stored profile, so a
   * turn never waits on a probe and the lane's pinned prefix cannot move.
   * Device blocks are added only for devices the character's durable grants
   * allow AND that already have a stored profile - a turn never waits on SSH.
   */
  async snapshot(input: EnvironmentSnapshotInput, options: ComposeEnvironmentLayerOptions = {}): Promise<EnvironmentSnapshot | undefined> {
    let profile = this.currentLocal()
    const tier = profile === undefined
      ? 'fast'
      : input.laneBoundary === true
        ? laneRefreshTier(profile, this.#options.clock ?? (() => new Date().toISOString()))
        : undefined
    if (tier !== undefined) {
      try {
        profile = await this.refreshLocal(tier)
      } catch {
        // A failed probe keeps whatever the host already knew.
      }
    }
    const entries: EnvironmentProfileEntry[] = []
    if (profile !== undefined) entries.push({ profile })
    for (const target of await this.#deviceTargets(input)) {
      const stored = this.#store.load(target.profileId)
      if (stored === undefined) continue
      entries.push({ profile: stored, label: `${target.displayName} (${target.host})` })
    }
    const layer = composeEnvironmentLayerSet(entries, options)
    if (layer === undefined) return undefined
    const present = [...new Set(entries.flatMap((entry) => Object.entries(entry.profile.tools)
      .filter(([, tool]) => tool.present)
      .map(([name]) => name)))]
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    return { layer, present }
  }

  async #deviceTargets(input: { worldId: string; characterId: string }): Promise<readonly EnvironmentDeviceTarget[]> {
    if (this.#options.devices === undefined) return []
    try {
      return await this.#options.devices.targets(input)
    } catch {
      // A device source that cannot answer must not cost the turn its prompt.
      return []
    }
  }

  /**
   * Folds host-observed run facts into one stored profile.
   *
   * Returns whether the durable profile actually changed, so a caller can
   * decide to tell the model on its next turn. A signal that teaches nothing
   * costs one file read and no write, and a failing write never reaches the
   * turn that produced the signal.
   */
  async applySignals(signals: readonly EnvironmentSignal[], profileId: string = LOCAL_ENVIRONMENT_PROFILE_ID): Promise<boolean> {
    if (signals.length === 0) return false
    const existing = this.#store.load(profileId)
    if (existing === undefined) return false
    const clock = this.#options.clock ?? (() => new Date().toISOString())
    let profile = existing
    let changed = false
    for (const signal of signals) {
      const result = applyEnvironmentSignal(profile, signal, { clock })
      if (result.changes.length > 0) changed = true
      profile = result.profile
    }
    if (!changed) return false
    await this.#store.save(profile)
    return true
  }
}

/**
 * Composition-root seam for the server: builds the local profile service.
 *
 * Construction is side-effect free on purpose - the first conversation lane
 * triggers the fast probe through `snapshot()`, so startup never spawns
 * version commands and never writes into a state root that may be closing.
 */
export function createEnvironmentService(stateRoot: string, options: EnvironmentServiceOptions = {}): EnvironmentService {
  return new EnvironmentService(new EnvironmentProfileStore(stateRoot), options)
}

/**
 * Which tier, if any, a conversation boundary owes this profile.
 *
 * A version debt (a brand-new profile, a learned change, or a day of drift)
 * escalates to the full battery; otherwise a half-hour-old presence list is
 * worth the free re-scan; anything else is just a read.
 */
function laneRefreshTier(profile: EnvironmentProfile, clock: () => string): EnvironmentProbeTier | undefined {
  const age = Date.parse(clock()) - Date.parse(profile.probedAt)
  if (!Number.isFinite(age)) return 'full'
  if (age >= FULL_REFRESH_TTL_MS || profile.fullDirty) return 'full'
  if (age >= FAST_REFRESH_TTL_MS) return 'fast'
  return undefined
}

/**
 * Keeps a version a previous full probe learned while a fast tier only
 * re-confirms presence. A tool that disappeared loses its version with it; a
 * tool that just appeared stays unversioned until the next full refresh.
 */
function mergeToolFacts(
  probed: EnvironmentProfile['tools'],
  previous: EnvironmentProfile['tools'] | undefined,
): EnvironmentProfile['tools'] {
  if (previous === undefined) return probed
  const merged: EnvironmentProfile['tools'] = {}
  for (const [name, tool] of Object.entries(probed)) {
    const version = tool.version ?? (tool.present ? previous[name]?.version : undefined)
    merged[name] = { ...tool, ...(version === undefined ? {} : { version }) }
  }
  return merged
}

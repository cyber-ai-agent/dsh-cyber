import type { CyberMarketPackage } from './index.js'
import type { CharacterSourceInput } from './character-generator.js'

/**
 * Plugin Generator — the fourth generator, reusing the Character Generator's
 * Analyze / Preview / Publish / Package / Install product pattern.
 *
 * A generated plugin is a *plugin package*: the same declaration-only
 * artifact the official plugins ship as (`kind: 'plugin'`, exactly
 * `prompt:transform`, no data egress, one `prompt-transform` entrypoint whose
 * JSON the runtime's own parser validates). The only content is a list of
 * prompt transforms — a slash trigger and the prose the host adds to the
 * user's message when it is typed. Nothing here is code, a capability grant,
 * a URL or a credential; the draft below is review-only and only becomes
 * durable through the caller's explicit publish step.
 */

/** Same envelope as the Character Generator: untrusted user material. */
export type PluginSourceInput = CharacterSourceInput

/** The three modes the runtime's prompt-transform parser accepts. */
export type PluginTransformMode = 'prepend' | 'append' | 'replace'

/** One reviewed prompt transform, in exactly the shape the runtime parser accepts. */
export interface PluginTransformDraft {
  /** Lowercase hyphenated id, unique within the plugin; derived from the trigger when not given. */
  id: string
  /** An explicit slash command (`/name`). Generated plugins never get `always`. */
  trigger: string
  description: string
  /** The prose the host prepends, appends or substitutes for the user's message. */
  instruction: string
  mode: PluginTransformMode
  priority: number
}

/** A review-only plugin suggestion. It is not an installed plugin. */
export interface PluginDraft {
  schemaVersion: 1
  displayName: string
  summary: string
  transforms: PluginTransformDraft[]
  sourceSummary: string
  sourceRefs: string[]
}

/** The entrypoint a generated plugin ships: the runtime's `PromptTransformDefinition` shape. */
export interface PluginTransformDefinitionV1 {
  schemaVersion: 1
  transforms: PluginTransformDraft[]
}

/** The runtime parser's limits, projected for the review UI. The parser stays the authority. */
export interface PluginGeneratorLimits {
  maxTransforms: number
  maxIdLength: number
  maxTriggerLength: number
  maxDescriptionLength: number
  maxInstructionLength: number
}

/** A trigger a plugin in the shared marketplace already owns; a generated plugin may not reuse it. */
export interface PluginGeneratorReservedTrigger {
  trigger: string
  packageId: string
  displayName: string
}

export interface PluginGeneratorCatalog {
  limits: PluginGeneratorLimits
  modes: PluginTransformMode[]
  reservedTriggers: PluginGeneratorReservedTrigger[]
}

export interface PluginImportAnalyzeInput {
  workspaceId: string
  source: PluginSourceInput
}

export interface PluginImportAnalyzeResult {
  draft: PluginDraft
}

export interface PluginImportPublishInput {
  workspaceId: string
  draft: PluginDraft
  source: PluginSourceInput
}

export interface PluginImportPublishResult {
  /** The generated plugin package as the marketplace lists it. */
  item: CyberMarketPackage
  /** The transform entrypoint exactly as written, after the runtime parser normalized it. */
  definition: PluginTransformDefinitionV1
}

export type PluginGeneratorAnalyzeInput = PluginImportAnalyzeInput
export type PluginGeneratorAnalyzeResult = PluginImportAnalyzeResult
export type PluginGeneratorPublishInput = PluginImportPublishInput
export type PluginGeneratorPublishResult = PluginImportPublishResult

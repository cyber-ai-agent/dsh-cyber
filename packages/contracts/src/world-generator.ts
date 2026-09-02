import type { CyberMarketPackage } from './index.js'
import type {
  CharacterBlueprintDraft,
  CharacterGeneratorAvatarMimeType,
  CharacterGeneratorCapabilityCatalogItem,
  CharacterSourceInput,
} from './character-generator.js'
import type { SkillCatalogEntry } from './skill-runtime.js'
import type { WorldThemeManifestV1 } from './world-runtime.js'

/**
 * World Generator — the second generator, reusing the Character Generator's
 * Analyze / Preview / Publish / Package / Install product pattern.
 *
 * A generated world is a *theme package*: the same artifact the official
 * themes ship as (a `WorldThemeManifestV1` carrying terminology, workflow and
 * rules, plus a default 2D scene) together with a default cast of employee
 * blueprints published as ordinary talent packages. Nothing here is a new
 * world, theme or agent type; the draft below is review-only and only becomes
 * durable through the caller's explicit publish step.
 */

/** Same envelope as the Character Generator: untrusted user material. */
export type WorldSourceInput = CharacterSourceInput

/** The four vocabulary slots every official theme declares. */
export interface WorldThemeTerminologyDraft {
  world: string
  participant: string
  session: string
  milestone: string
}

/** A review-only world theme suggestion. It is not an installed theme. */
export interface WorldThemeDraft {
  schemaVersion: 1
  /** Host-owned base template the generated world is created from. */
  targetWorldTemplateId: string
  displayName: string
  summary: string
  terminology: WorldThemeTerminologyDraft
  /** The scenario loop, in order (e.g. 知识拆解 → 课程计划 → …). */
  workflow: string[]
  /** World rules every cast member works under. */
  rules: string[]
  /**
   * Default cast. Each member is a Character Generator draft and goes through
   * the same blueprint parser and the same "a request is not a grant"
   * recruitment path as a standalone generated character.
   */
  cast: CharacterBlueprintDraft[]
  sourceSummary: string
  sourceRefs: string[]
}

/** An official 2D scene the generator may clone; arbitrary packages are not admitted. */
export interface WorldGeneratorSceneCatalogItem {
  id: string
  displayName: string
  packageId: string
  packageVersion: string
  /** Scene id inside the official theme manifest. */
  sceneId: string
  source: 'official'
}

export interface WorldGeneratorCatalog {
  targetWorldTemplateId: string
  scenes: WorldGeneratorSceneCatalogItem[]
  skills: SkillCatalogEntry[]
  capabilities: CharacterGeneratorCapabilityCatalogItem[]
}

export interface WorldImportAnalyzeInput {
  workspaceId: string
  source: WorldSourceInput
}

export interface WorldImportAnalyzeResult {
  draft: WorldThemeDraft
  /** A scene pick from the host catalog the analyzer found fitting, if any. */
  suggestedSceneId?: string
}

/**
 * The scene answer, mirroring the Character Generator's avatar answer:
 * an official pick, or a user upload. An upload replaces the background
 * raster ONLY — `id` still names the official scene whose anchors,
 * navigation and interactables the generated theme keeps. The wire shape and
 * the server boundary (magic-byte sniff, byte budget, file name validation)
 * are the avatar upload's.
 */
export type WorldGeneratorSceneSelection =
  | { kind: 'official'; id: string }
  | {
      kind: 'upload'
      /** Official scene lending its layout; must be in the host allowlist. */
      id: string
      fileName: string
      mimeType: CharacterGeneratorAvatarMimeType
      dataBase64: string
    }

export interface WorldImportPublishInput {
  workspaceId: string
  draft: WorldThemeDraft
  source: WorldSourceInput
  scene?: WorldGeneratorSceneSelection
}

export interface WorldImportPublishResult {
  /** The generated world-theme package as the marketplace lists it. */
  item: CyberMarketPackage
  theme: WorldThemeManifestV1
  /** The generated cast, one talent package per member. */
  cast: CyberMarketPackage[]
}

export type WorldGeneratorAnalyzeInput = WorldImportAnalyzeInput
export type WorldGeneratorAnalyzeResult = WorldImportAnalyzeResult
export type WorldGeneratorPublishInput = WorldImportPublishInput
export type WorldGeneratorPublishResult = WorldImportPublishResult

import type { CyberMarketPackage, CyberSkinManifestV1, CyberSkinPaletteV1 } from './index.js'
import type { CharacterSourceInput } from './character-generator.js'

/**
 * Skin Generator — the third generator, reusing the Character Generator's
 * Analyze / Preview / Publish / Package / Install product pattern.
 *
 * A generated skin is a *skin package*: the same declaration-only artifact
 * the official skins ship as (`kind: 'skin'`, `ui:skin`, one `skin.json`
 * entrypoint), carrying a six-colour palette plus a bounded opacity and,
 * optionally, the id of an official skin whose bundled scene it reuses as
 * the conversation backdrop. Nothing here is code, a stylesheet, a URL or a
 * capability; the draft below is review-only and only becomes durable
 * through the caller's explicit publish step.
 */

/** Same envelope as the Character Generator: untrusted user material. */
export type SkinSourceInput = CharacterSourceInput

/** A review-only skin suggestion. It is not an installed skin. */
export interface SkinDraft {
  schemaVersion: 1
  displayName: string
  summary: string
  palette: CyberSkinPaletteV1
  sourceSummary: string
  sourceRefs: string[]
}

/** An official skin whose scene the generator may reuse as a backdrop; arbitrary packages are not admitted. */
export interface SkinGeneratorBackdropCatalogItem {
  id: string
  displayName: string
  packageId: string
  packageVersion: string
  source: 'official'
}

export interface SkinGeneratorCatalog {
  backdrops: SkinGeneratorBackdropCatalogItem[]
}

export interface SkinImportAnalyzeInput {
  workspaceId: string
  source: SkinSourceInput
}

export interface SkinImportAnalyzeResult {
  draft: SkinDraft
  /** A backdrop pick from the host catalog the analyzer found fitting, if any. */
  suggestedBackdropId?: string
}

export type SkinGeneratorBackdropSelection = { kind: 'official'; id: string }

export interface SkinImportPublishInput {
  workspaceId: string
  draft: SkinDraft
  source: SkinSourceInput
  backdrop?: SkinGeneratorBackdropSelection
}

export interface SkinImportPublishResult {
  /** The generated skin package as the marketplace lists it. */
  item: CyberMarketPackage
  skin: CyberSkinManifestV1
}

export type SkinGeneratorAnalyzeInput = SkinImportAnalyzeInput
export type SkinGeneratorAnalyzeResult = SkinImportAnalyzeResult
export type SkinGeneratorPublishInput = SkinImportPublishInput
export type SkinGeneratorPublishResult = SkinImportPublishResult

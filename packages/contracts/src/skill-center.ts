import type { CharacterSourceInput } from './character-generator.js'
import type { CyberMarketPackage, IsoTimestamp } from './index.js'
import type { SkillCatalogEntry, SkillDependency } from './skill-runtime.js'

export type SkillSettingsScope = 'workspace' | 'world'

/** Exact Skill references selected for one workspace default or World override. */
export interface SkillScopeSettings {
  workspaceId: string
  scope: SkillSettingsScope
  scopeId: string
  skillIds: string[]
  updatedAt: IsoTimestamp
}

export interface SkillScopeView {
  scope: SkillSettingsScope
  scopeId: string
  displayName: string
  configured: boolean
  inherited: boolean
  skillIds: string[]
}

export interface SkillSettingsView {
  global: SkillScopeView
  worlds: SkillScopeView[]
}

export interface SkillDetailFile {
  path: string
  content: string
  language: 'markdown' | 'json' | 'text'
  editable: boolean
}

export interface SkillDetailView {
  entry: SkillCatalogEntry
  tree: Array<{ path: string; kind: 'file' }>
  files: SkillDetailFile[]
  editable: boolean
  packageId?: string
  packageVersion?: string
}

export type SkillAuthoringSource = CharacterSourceInput

/** Review-only Skill draft. Publishing always creates an immutable package version. */
export interface SkillAuthoringDraft {
  schemaVersion: 1
  id: string
  displayName: string
  summary: string
  routingHints: string[]
  integrationId: 'builtin.recipe'
  /** Connections or Skills needed by the authored declaration. */
  dependencies?: SkillDependency[]
  dataEgress: []
  instructions: string
  sourceSummary: string
}

export interface SkillAuthoringAnalyzeInput {
  workspaceId: string
  source: SkillAuthoringSource
  current?: SkillAuthoringDraft
}

export interface SkillAuthoringAnalyzeResult {
  draft: SkillAuthoringDraft
}

export interface SkillAuthoringPublishResult {
  item: CyberMarketPackage
  draft: SkillAuthoringDraft
}

import type { WorldThemeManifestV1 } from '@dsh-cyber/contracts'

import type { ArtifactRecord } from '../../artifacts/useWorldArtifacts.js'

/**
 * The world scene area doubles as the place where a world shows what its
 * characters actually produced: a board of worked-through content, the world
 * knowledge graph, result/lesson cards and animation or video artifacts.
 *
 * Nothing here creates a result. Every lane presents something the world
 * already holds — a published World Artifact, or the existing world knowledge
 * graph — so an empty world says so plainly instead of drawing a fake board.
 *
 * A Theme opts into teaching vocabulary through its existing `terminology`
 * object; no new manifest type is involved:
 *
 * ```json
 * "terminology": {
 *   "resultSurface": "teaching",
 *   "resultSurfaceLabel": "教学结果",
 *   "blackboard": "板书",
 *   "knowledgeGraph": "知识图",
 *   "lessonCards": "课程卡片",
 *   "resultMedia": "动画 · 影像"
 * }
 * ```
 *
 * A Theme that already declares a teaching scene — an interactable whose kind
 * is a blackboard, a lesson-card shelf, a syllabus board or a knowledge-graph
 * wall — is read as a teaching scenario without repeating itself in
 * terminology. An explicit `resultSurface` declaration always wins.
 */
export type TeachingLaneId = 'blackboard' | 'knowledge-graph' | 'lesson-cards' | 'media'

export const TEACHING_LANE_ORDER: readonly TeachingLaneId[] = ['blackboard', 'knowledge-graph', 'lesson-cards', 'media']

export interface TeachingSurfaceVocabulary {
  mode: 'teaching' | 'generic'
  surfaceLabel: string
  laneLabels: Record<TeachingLaneId, string>
}

export interface TeachingResultLane {
  id: TeachingLaneId
  label: string
  /** A live lane renders an existing world service instead of stored artifacts. */
  live: boolean
  artifacts: ArtifactRecord[]
}

export interface TeachingSurfaceModel {
  lanes: TeachingResultLane[]
  presentedCount: number
  otherCount: number
  hasPresentableResult: boolean
  defaultLaneId: TeachingLaneId
}

export interface TeachingLessonCard {
  title: string
  summary?: string
  points: string[]
}

const GENERIC_LANE_LABELS: Record<TeachingLaneId, string> = {
  blackboard: '结果板',
  'knowledge-graph': '知识图',
  'lesson-cards': '结果卡片',
  media: '动画 · 影像',
}

const TEACHING_LANE_LABELS: Record<TeachingLaneId, string> = {
  blackboard: '板书',
  'knowledge-graph': '知识图',
  'lesson-cards': '课程卡片',
  media: '动画 · 影像',
}

const LANE_TERMINOLOGY_KEYS: Record<TeachingLaneId, string> = {
  blackboard: 'blackboard',
  'knowledge-graph': 'knowledgeGraph',
  'lesson-cards': 'lessonCards',
  media: 'resultMedia',
}

const ANIMATION_EXTENSIONS = /\.(?:mp4|webm|mov|m4v|ogv|gif|apng)$/i
const VIDEO_EXTENSIONS = /\.(?:mp4|webm|mov|m4v|ogv)$/i
const BOARD_TEXT_EXTENSIONS = /\.(?:md|markdown|txt|text)$/i

/** What the surface reads from an already shipped Theme manifest. */
export interface TeachingSurfaceThemeInput {
  terminology?: WorldThemeManifestV1['terminology']
  scenes?: ReadonlyArray<{ interactables?: ReadonlyArray<{ kind?: string }> }>
}

/** Interactable kinds a theme uses to declare a teaching scene. */
const TEACHING_SCENE_KINDS = new Set(['blackboard', 'lesson-card-shelf', 'syllabus-board', 'knowledge-graph-wall'])

/** Reads the surface vocabulary a Theme declares in its existing manifest. */
export function teachingSurfaceVocabulary(manifest?: TeachingSurfaceThemeInput): TeachingSurfaceVocabulary {
  const terminology = manifest?.terminology
  const declared = terminology === undefined ? undefined : readString(terminology, 'resultSurface')
  const mode: TeachingSurfaceVocabulary['mode'] = declared === undefined
    ? (declaresTeachingScene(manifest) ? 'teaching' : 'generic')
    : declared === 'teaching' ? 'teaching' : 'generic'
  const defaults = mode === 'teaching' ? TEACHING_LANE_LABELS : GENERIC_LANE_LABELS
  const laneLabels = { ...defaults }
  for (const lane of TEACHING_LANE_ORDER) {
    const override = terminology === undefined ? undefined : readString(terminology, LANE_TERMINOLOGY_KEYS[lane])
    if (override !== undefined) laneLabels[lane] = override
  }
  const surfaceLabel = (terminology === undefined ? undefined : readString(terminology, 'resultSurfaceLabel'))
    ?? (mode === 'teaching' ? '教学结果' : '世界结果')
  return { mode, surfaceLabel, laneLabels }
}

/**
 * Decides which lane a published artifact belongs to. An artifact that is not a
 * presentable result (code, archives, project trees) returns undefined and is
 * only counted, never dressed up as a teaching result.
 */
export function classifyTeachingArtifact(artifact: ArtifactRecord): TeachingLaneId | undefined {
  const path = artifactPath(artifact)
  const mimeType = artifact.currentVersionInfo?.mimeType ?? ''
  if (artifact.kind === 'html' || mimeType.startsWith('video/') || ANIMATION_EXTENSIONS.test(path)) return 'media'
  if (artifact.kind === 'markdown' || artifact.kind === 'document' || artifact.kind === 'image') return 'blackboard'
  if (artifact.kind === 'data') return 'lesson-cards'
  if (artifact.kind === 'other' && (BOARD_TEXT_EXTENSIONS.test(path) || mimeType.startsWith('text/'))) return 'blackboard'
  return undefined
}

/** True when a plain `<video>` element can actually take this artifact. */
export function isVideoResultArtifact(artifact: ArtifactRecord): boolean {
  const mimeType = artifact.currentVersionInfo?.mimeType ?? ''
  return mimeType.startsWith('video/') || VIDEO_EXTENSIONS.test(artifactPath(artifact))
}

export function buildTeachingSurfaceModel(
  artifacts: ArtifactRecord[],
  vocabulary: TeachingSurfaceVocabulary,
): TeachingSurfaceModel {
  const grouped = new Map<TeachingLaneId, ArtifactRecord[]>(TEACHING_LANE_ORDER.map((lane) => [lane, []]))
  let otherCount = 0
  for (const artifact of artifacts) {
    if (artifact.status !== 'active') continue
    const lane = classifyTeachingArtifact(artifact)
    if (lane === undefined || lane === 'knowledge-graph') {
      otherCount += 1
      continue
    }
    grouped.get(lane)?.push(artifact)
  }
  for (const list of grouped.values()) list.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  const lanes: TeachingResultLane[] = TEACHING_LANE_ORDER.map((lane) => ({
    id: lane,
    label: vocabulary.laneLabels[lane],
    live: lane === 'knowledge-graph',
    artifacts: lane === 'knowledge-graph' ? [] : grouped.get(lane) ?? [],
  }))
  const presentedCount = lanes.reduce((total, lane) => total + lane.artifacts.length, 0)
  return {
    lanes,
    presentedCount,
    otherCount,
    hasPresentableResult: presentedCount > 0,
    defaultLaneId: lanes.find((lane) => lane.artifacts.length > 0)?.id ?? 'blackboard',
  }
}

/**
 * Reads a lesson definition into cards. Anything that is not really a lesson —
 * unparsable text, an unrelated JSON document, entries without a title — comes
 * back undefined so the caller falls back to the plain artifact reader.
 */
export function parseLessonCards(content: string | undefined): TeachingLessonCard[] | undefined {
  if (content === undefined || content.trim().length === 0) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(content) as unknown
  } catch {
    return undefined
  }
  const entries = lessonEntries(parsed)
  if (entries === undefined) return undefined
  const cards: TeachingLessonCard[] = []
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const title = readString(record, 'title') ?? readString(record, 'name')
    if (title === undefined) continue
    const summary = readString(record, 'summary') ?? readString(record, 'description')
    cards.push({
      title,
      ...(summary === undefined ? {} : { summary }),
      points: readStringList(record, 'points') ?? readStringList(record, 'objectives') ?? readStringList(record, 'steps') ?? [],
    })
  }
  return cards.length === 0 ? undefined : cards
}

function lessonEntries(parsed: unknown): unknown[] | undefined {
  if (Array.isArray(parsed)) return parsed
  if (parsed === null || typeof parsed !== 'object') return undefined
  const record = parsed as Record<string, unknown>
  for (const key of ['cards', 'lessons', 'lessonCards']) {
    const value = record[key]
    if (Array.isArray(value)) return value
  }
  return undefined
}

function declaresTeachingScene(manifest: TeachingSurfaceThemeInput | undefined): boolean {
  return manifest?.scenes?.some((scene) => scene.interactables?.some((item) => item.kind !== undefined && TEACHING_SCENE_KINDS.has(item.kind))) === true
}

function artifactPath(artifact: ArtifactRecord): string {
  return artifact.currentVersionInfo?.sourceRelativePath
    ?? artifact.currentVersionInfo?.relativePath
    ?? artifact.title
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

function readStringList(record: Record<string, unknown>, key: string): string[] | undefined {
  const value = record[key]
  if (!Array.isArray(value)) return undefined
  const items = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim())
  return items.length === 0 ? undefined : items
}

import type { IsoTimestamp, ModelTokenUsage } from './index.js'
import type { WorldArtifactKind } from './world-artifact.js'

export const WORLD_TRACE_CATEGORIES = [
  'agent',
  'tool',
  'skill',
  'task',
  'collaboration',
  'world',
  'schedule',
  'system',
] as const

export type WorldTraceCategory = (typeof WORLD_TRACE_CATEGORIES)[number]

export const WORLD_TRACE_STATUSES = [
  'pending',
  'running',
  'waiting',
  'success',
  'failed',
  'cancelled',
  'info',
] as const

export type WorldTraceStatus = (typeof WORLD_TRACE_STATUSES)[number]

export type WorldTraceSourceKind =
  | 'domain-event'
  | 'runtime-event'
  | 'skill-action'
  | 'conversation'
  | 'scheduled-run'
  | 'agent-run'

export interface WorldTraceToolStep {
  callId: string
  name?: string
  label: string
  description?: string
  status: 'running' | 'success' | 'failed'
  createdAt?: IsoTimestamp
  completedAt?: IsoTimestamp
}

/**
 * A durable Artifact this run actually published, as a pointer only.
 *
 * The trace answers "产出了什么结果" by naming the registry rows a run created,
 * never by describing them. Rendering and preview stay with the Artifact
 * Center; the trace only carries enough identity to link there.
 */
export interface WorldTraceArtifactRef {
  artifactId: string
  title: string
  kind: WorldArtifactKind
  /** The version this run published, not the artifact's current version. */
  version: number
  createdAt: IsoTimestamp
}

/**
 * Provider- and renderer-neutral read model for meaningful activity in a world.
 *
 * Entries reference canonical facts; they are not a second source of truth.
 * Details are display-safe summaries and must have passed the host sanitizer.
 */
export interface WorldTraceEntry {
  id: string
  worldId: string
  category: WorldTraceCategory
  status: WorldTraceStatus
  summary: string
  detail?: string
  actorId?: string
  sessionId?: string
  taskId?: string
  skillId?: string
  scheduleId?: string
  runId?: string
  workTurnId?: string
  /**
   * A public reasoning summary the runtime actually emitted.
   *
   * Absent means the runtime supplied none. A renderer must show nothing there
   * rather than substitute filler or a narrative of what the model "thought";
   * hidden chain-of-thought never reaches this field.
   */
  reasoningSummary?: string
  tools?: WorldTraceToolStep[]
  /** Artifacts this entry's run published. Absent when it published none. */
  artifacts?: WorldTraceArtifactRef[]
  tokenUsage?: ModelTokenUsage
  durationMs?: number
  modelId?: string
  provider?: string
  sourceKind: WorldTraceSourceKind
  sourceId: string
  sourceSequence?: number
  createdAt: IsoTimestamp
  updatedAt: IsoTimestamp
}

export interface WorldTraceQuery {
  after?: string
  limit?: number
  category?: WorldTraceCategory
  status?: WorldTraceStatus
  actorId?: string
  date?: string
  search?: string
}

export interface WorldTracePage {
  items: WorldTraceEntry[]
  nextCursor?: string
}

/** Reserved input boundary for a future scheduler without coupling Trace to one scheduler. */
export interface ScheduledRunTraceFact {
  id: string
  worldId: string
  scheduleId: string
  runId: string
  status: WorldTraceStatus
  summary: string
  detail?: string
  actorId?: string
  createdAt: IsoTimestamp
  updatedAt: IsoTimestamp
}

import { createHash } from 'node:crypto'

import type {
  AgentRuntimeEvent,
  AgentRun,
  ContextSnapshotSummary,
  DomainEvent,
  ModelInteractionLog,
  ScheduledRunTraceFact,
  WorkMessage,
  WorkSession,
  WorldTraceArtifactRef,
  WorldTraceEntry,
  WorldTraceSourceKind,
} from '@dsh-cyber/contracts'
import type { CharacterSkillAction } from '@dsh-cyber/contracts/skill-runtime'

import type { TraceSanitizer } from './trace-sanitizer.js'

export interface RuntimeTraceFact {
  worldId: string
  sessionId: string
  actorId: string
  event: AgentRuntimeEvent
  createdAt: string
  workTurnId?: string
  agentRunId?: string
}

export interface AgentRunTraceFact {
  worldId: string
  run: AgentRun
  messages: WorkMessage[]
  interaction?: ModelInteractionLog
  /** Artifact versions the registry recorded against this run. */
  artifacts?: WorldTraceArtifactRef[]
  /**
   * The WorkTask this run was recorded against, resolved from `task_runs`.
   *
   * Absent for a plain conversation run. The adapter publishes no task at all
   * in that case; it never derives one from the turn.
   */
  task?: { id: string; title: string }
  /** The run's durable context snapshot, reduced to its numbers. Absent when none exists. */
  context?: ContextSnapshotSummary
}

export interface ConsolidationTraceFact {
  worldId: string
  jobId: string
  sourceType: string
  sourceId: string
  errorCode?: string
  attempt: number
  updatedAt: string
}

export type WorldTraceFact =
  | { kind: 'agent-run'; value: AgentRunTraceFact }
  | { kind: 'domain-event'; value: DomainEvent }
  | { kind: 'runtime-event'; value: RuntimeTraceFact }
  | { kind: 'skill-action'; value: CharacterSkillAction }
  | { kind: 'conversation'; value: { worldId: string; session: WorkSession; message: WorkMessage } }
  | { kind: 'scheduled-run'; value: ScheduledRunTraceFact }
  | { kind: 'consolidation'; value: ConsolidationTraceFact }

export interface WorldTraceAdapterContext {
  sanitizer: TraceSanitizer
  actorName(actorId: string): string | undefined
}

export interface WorldTraceAdapter<K extends WorldTraceSourceKind = WorldTraceSourceKind> {
  readonly kind: K
  adapt(fact: Extract<WorldTraceFact, { kind: K }>, context: WorldTraceAdapterContext): WorldTraceEntry[]
}

export class WorldTraceAdapterRegistry {
  readonly #adapters = new Map<WorldTraceSourceKind, WorldTraceAdapter>()

  register(adapter: WorldTraceAdapter): void {
    if (this.#adapters.has(adapter.kind)) throw new Error(`World Trace adapter already registered: ${adapter.kind}`)
    this.#adapters.set(adapter.kind, adapter)
  }

  adapt(fact: WorldTraceFact, context: WorldTraceAdapterContext): WorldTraceEntry[] {
    const adapter = this.#adapters.get(fact.kind)
    if (adapter === undefined) return []
    return adapter.adapt(fact as never, context).map((entry) => context.sanitizer.entry(entry))
  }
}

export function traceId(...parts: Array<string | number | undefined>): string {
  const digest = createHash('sha256')
    .update(parts.map((part) => String(part ?? '')).join('\u001f'))
    .digest('hex')
    .slice(0, 24)
  return `trace-${digest}`
}

export function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key]
  return typeof field === 'string' && field.trim().length > 0 ? field : undefined
}

export function numberField(value: Record<string, unknown>, key: string): number | undefined {
  const field = value[key]
  return typeof field === 'number' && Number.isFinite(field) ? field : undefined
}

export function booleanField(value: Record<string, unknown>, key: string): boolean | undefined {
  const field = value[key]
  return typeof field === 'boolean' ? field : undefined
}

export function runtimeIdentity(input: {
  kind: AgentRuntimeEvent['kind']
  source: string
  sourceSessionId: string
  sourceSequence?: number
  callId?: string
  content?: string
  traceTurnId?: string
}): string {
  if (input.kind === 'turn.started' || input.kind === 'turn.completed' || input.kind === 'turn.failed') {
    return traceId('runtime-turn', input.traceTurnId ?? `${input.source}:${input.sourceSessionId}`)
  }
  if (input.kind === 'tool.started' || input.kind === 'tool.completed') {
    return traceId('runtime-tool', input.traceTurnId ?? `${input.source}:${input.sourceSessionId}`, input.callId ?? input.sourceSequence)
  }
  return traceId(
    'runtime-event',
    input.traceTurnId ?? `${input.source}:${input.sourceSessionId}`,
    input.sourceSequence,
    input.kind,
    input.sourceSequence === undefined ? input.content : undefined,
  )
}

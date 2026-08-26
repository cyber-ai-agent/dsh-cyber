import type {
  WorkMessage,
  WorldTraceEntry,
  WorldTracePage,
  WorldTraceQuery,
} from '@dsh-cyber/contracts'
import type { ConversationRealtimeEnvelope } from '@dsh-cyber/orchestration'
import type { SqliteStore } from '@dsh-cyber/persistence'

import type { CharacterSkillActionRepository } from '../skills/skill-action-repository.js'
import {
  AgentRunTraceAdapter,
  ConversationTraceAdapter,
  DomainEventTraceAdapter,
  TRACE_INVISIBLE_EVENT_TYPES,
  RuntimeEventTraceAdapter,
  ScheduleTraceAdapter,
  SkillActionTraceAdapter,
  TraceSanitizer,
  WorldTraceAdapterRegistry,
  type WorldTraceFact,
} from '../world-trace/index.js'

interface TraceCursor {
  createdAt: string
  id: string
}

export class InvalidWorldTraceCursorError extends Error {
  constructor() {
    super('Invalid World Trace cursor')
    this.name = 'InvalidWorldTraceCursorError'
  }
}

export interface WorldTraceServiceOptions {
  store: SqliteStore
  actions: CharacterSkillActionRepository
  registry?: WorldTraceAdapterRegistry
  sanitizer?: TraceSanitizer
  clock?: () => string
}

export type WorldTraceCheckpoint = ReadonlyMap<string, string>

export class WorldTraceService {
  readonly #store: SqliteStore
  readonly #actions: CharacterSkillActionRepository
  readonly #registry: WorldTraceAdapterRegistry
  readonly #sanitizer: TraceSanitizer
  readonly #clock: () => string
  readonly #liveRuns = new Map<string, WorldTraceEntry>()

  constructor(options: WorldTraceServiceOptions) {
    this.#store = options.store
    this.#actions = options.actions
    this.#registry = options.registry ?? createWorldTraceRegistry()
    this.#sanitizer = options.sanitizer ?? new TraceSanitizer()
    this.#clock = options.clock ?? (() => new Date().toISOString())
  }

  async list(worldId: string, query: WorldTraceQuery = {}): Promise<WorldTracePage> {
    const world = this.#store.getWorld(worldId)
    if (world === undefined) return { items: [] }
    const actorNames = new Map(this.#store.listEmployees(worldId, true).map((employee) => [employee.id, employee.displayName]))
    const search = query.search?.trim().toLocaleLowerCase('zh-CN')
    const entries = (await this.#materialize(worldId))
      .filter((entry) => query.category === undefined || entry.category === query.category)
      .filter((entry) => query.status === undefined || entry.status === query.status)
      .filter((entry) => query.actorId === undefined || entry.actorId === query.actorId)
      .filter((entry) => query.date === undefined || localCalendarDate(entry.createdAt) === query.date)
      .filter((entry) => search === undefined || search.length === 0 || traceSearchText(entry, actorNames).includes(search))
      .sort(compareTraceEntries)
    const cursor = query.after === undefined ? undefined : decodeTraceCursor(query.after)
    const after = cursor === undefined
      ? entries
      : entries.filter((entry) => compareCursor(entry, cursor) < 0)
    const limit = Math.min(200, Math.max(1, query.limit ?? 50))
    const items = after.slice(0, limit)
    return {
      items,
      ...(after.length <= limit || items.length === 0 ? {} : { nextCursor: encodeTraceCursor(items.at(-1)!) }),
    }
  }

  async checkpoint(worldId: string): Promise<WorldTraceCheckpoint> {
    return new Map((await this.#materialize(worldId)).map((entry) => [entry.id, entry.updatedAt]))
  }

  async changesSince(worldId: string, checkpoint: WorldTraceCheckpoint): Promise<WorldTraceEntry[]> {
    return (await this.#materialize(worldId))
      .filter((entry) => checkpoint.get(entry.id) !== entry.updatedAt)
      .sort(compareTraceEntries)
  }

  adaptRuntime(envelope: ConversationRealtimeEnvelope): WorldTraceEntry[] {
    const updates = this.#registry.adapt({
      kind: 'runtime-event',
      value: {
        worldId: envelope.worldId,
        sessionId: envelope.sessionId,
        actorId: envelope.agentId,
        event: envelope.event,
        workTurnId: envelope.workTurnId,
        agentRunId: envelope.agentRunId,
        createdAt: envelope.event.sourceTime === undefined
          ? this.#clock()
          : new Date(envelope.event.sourceTime).toISOString(),
      },
    }, this.#context(envelope.worldId))
    return updates.map((update) => {
      const merged = mergeTraceEntry(this.#liveRuns.get(update.id), update)
      this.#liveRuns.set(update.id, merged)
      if (merged.status !== 'running') setTimeout(() => this.#liveRuns.delete(merged.id), 30_000).unref?.()
      return merged
    })
  }

  #context(worldId: string) {
    const names = new Map(this.#store.listEmployees(worldId, true).map((employee) => [employee.id, employee.displayName]))
    return {
      sanitizer: this.#sanitizer,
      actorName: (actorId: string) => names.get(actorId),
    }
  }

  async #materialize(worldId: string): Promise<WorldTraceEntry[]> {
    const context = this.#context(worldId)
    // Each run only ever reads its own messages. Handing the whole world's
    // transcript to every run made this quadratic: at 6,400 runs / 38,400
    // messages a single materialization spent over 1.6s in the nested scan,
    // and a chat POST materializes twice.
    const messagesByRun = groupMessagesByRun(this.#store.listWorldTraceMessages(worldId))
    const interactions = new Map(this.#store.listWorldModelInteractions(worldId)
      .filter((interaction) => interaction.agentRunId !== undefined)
      .map((interaction) => [interaction.agentRunId!, interaction]))
    const facts: WorldTraceFact[] = [
      ...this.#store.listWorldAgentRuns(worldId).map((run) => ({
        kind: 'agent-run' as const,
        value: {
          worldId,
          run,
          messages: messagesByRun.get(run.id) ?? [],
          ...(interactions.get(run.id) === undefined ? {} : { interaction: interactions.get(run.id)! }),
        },
      })),
      ...this.#store.listWorldTraceDomainEvents(worldId, TRACE_INVISIBLE_EVENT_TYPES).map((value) => ({ kind: 'domain-event' as const, value })),
      ...(await this.#actions.listByWorld(worldId)).map((value) => ({ kind: 'skill-action' as const, value })),
    ]
    const persisted = deduplicate(facts.flatMap((fact) => this.#registry.adapt(fact, context)))
    const live = [...this.#liveRuns.values()].filter((entry) => entry.worldId === worldId)
    return deduplicate([...persisted, ...live])
  }
}

/**
 * Indexes trace messages by the run they belong to.
 *
 * A message is claimed by `agentRunId` and by `traceTurnId`, and the two can
 * differ, so a message may legitimately land under both keys — exactly what the
 * per-run filter used to accept.
 */
export function groupMessagesByRun(messages: readonly WorkMessage[]): Map<string, WorkMessage[]> {
  const grouped = new Map<string, WorkMessage[]>()
  const add = (runId: unknown, message: WorkMessage): void => {
    if (typeof runId !== 'string' || runId.length === 0) return
    const bucket = grouped.get(runId)
    if (bucket === undefined) grouped.set(runId, [message])
    else if (bucket.at(-1) !== message) bucket.push(message)
  }
  for (const message of messages) {
    add(message.metadata.agentRunId, message)
    add(message.metadata.traceTurnId, message)
  }
  return grouped
}

export function createWorldTraceRegistry(): WorldTraceAdapterRegistry {
  const registry = new WorldTraceAdapterRegistry()
  registry.register(new AgentRunTraceAdapter())
  registry.register(new DomainEventTraceAdapter())
  registry.register(new RuntimeEventTraceAdapter())
  registry.register(new SkillActionTraceAdapter())
  registry.register(new ConversationTraceAdapter())
  registry.register(new ScheduleTraceAdapter())
  return registry
}

export function encodeTraceCursor(entry: Pick<WorldTraceEntry, 'createdAt' | 'id'>): string {
  return Buffer.from(JSON.stringify({ createdAt: entry.createdAt, id: entry.id }), 'utf8').toString('base64url')
}

export function decodeTraceCursor(value: string): TraceCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>
    if (typeof parsed.createdAt !== 'string' || !Number.isFinite(Date.parse(parsed.createdAt)) || typeof parsed.id !== 'string' || parsed.id.length === 0) {
      throw new InvalidWorldTraceCursorError()
    }
    return { createdAt: parsed.createdAt, id: parsed.id }
  } catch (error) {
    if (error instanceof InvalidWorldTraceCursorError) throw error
    throw new InvalidWorldTraceCursorError()
  }
}

function deduplicate(entries: WorldTraceEntry[]): WorldTraceEntry[] {
  const result = new Map<string, WorldTraceEntry>()
  for (const entry of entries) {
    const current = result.get(entry.id)
    if (current === undefined) {
      result.set(entry.id, entry)
      continue
    }
    const latest = current.updatedAt.localeCompare(entry.updatedAt) <= 0 ? entry : current
    result.set(entry.id, {
      ...current,
      ...latest,
      createdAt: current.createdAt.localeCompare(entry.createdAt) <= 0 ? current.createdAt : entry.createdAt,
      updatedAt: current.updatedAt.localeCompare(entry.updatedAt) >= 0 ? current.updatedAt : entry.updatedAt,
    })
  }
  return [...result.values()]
}

function compareTraceEntries(left: WorldTraceEntry, right: WorldTraceEntry): number {
  return right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)
}

function compareCursor(entry: WorldTraceEntry, cursor: TraceCursor): number {
  return entry.createdAt.localeCompare(cursor.createdAt) || entry.id.localeCompare(cursor.id)
}

function traceSearchText(entry: WorldTraceEntry, actorNames: ReadonlyMap<string, string>): string {
  return [
    entry.summary,
    entry.detail,
    entry.reasoningSummary,
    entry.actorId === undefined ? undefined : actorNames.get(entry.actorId),
    entry.modelId,
    entry.provider,
    ...((entry.tools ?? []).flatMap((tool) => [tool.label, tool.name])),
  ].filter((value): value is string => typeof value === 'string')
    .join('\n')
    .toLocaleLowerCase('zh-CN')
}

function localCalendarDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return ''
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function mergeTraceEntry(current: WorldTraceEntry | undefined, next: WorldTraceEntry): WorldTraceEntry {
  if (current === undefined) return next
  const tools = new Map((current.tools ?? []).map((tool) => [tool.callId, tool]))
  for (const tool of next.tools ?? []) {
    const previous = tools.get(tool.callId)
    const completedWithoutIdentity = previous?.name !== undefined && tool.name === undefined
    tools.set(tool.callId, {
      ...previous,
      ...tool,
      ...(completedWithoutIdentity ? { name: previous.name, label: previous.label, description: previous.description } : {}),
    })
  }
  const reasoning = [current.reasoningSummary, next.reasoningSummary]
    .filter((value, index, values): value is string => Boolean(value) && values.indexOf(value) === index)
    .join('\n\n')
  return {
    ...current,
    ...next,
    category: tools.size > 0 ? 'tool' : next.category,
    createdAt: current.createdAt.localeCompare(next.createdAt) <= 0 ? current.createdAt : next.createdAt,
    updatedAt: current.updatedAt.localeCompare(next.updatedAt) >= 0 ? current.updatedAt : next.updatedAt,
    ...(reasoning ? { reasoningSummary: reasoning } : {}),
    ...(tools.size > 0 ? { tools: [...tools.values()] } : {}),
  }
}

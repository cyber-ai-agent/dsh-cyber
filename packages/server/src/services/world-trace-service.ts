import type {
  WorldTraceEntry,
  WorldTracePage,
  WorldTraceQuery,
} from '@dsh-cyber/contracts'
import type { ConversationRealtimeEnvelope } from '@dsh-cyber/orchestration'
import type { SqliteStore } from '@dsh-cyber/persistence'

import type { CharacterSkillActionRepository } from '../skills/skill-action-repository.js'
import {
  ConversationTraceAdapter,
  DomainEventTraceAdapter,
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
    const entries = (await this.#materialize(worldId))
      .filter((entry) => query.category === undefined || entry.category === query.category)
      .filter((entry) => query.status === undefined || entry.status === query.status)
      .filter((entry) => query.actorId === undefined || entry.actorId === query.actorId)
      .sort(compareTraceEntries)
    const cursor = query.after === undefined ? undefined : decodeTraceCursor(query.after)
    const after = cursor === undefined
      ? entries
      : entries.filter((entry) => compareCursor(entry, cursor) > 0)
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
    return this.#registry.adapt({
      kind: 'runtime-event',
      value: {
        worldId: envelope.worldId,
        sessionId: envelope.sessionId,
        actorId: envelope.agentId,
        event: envelope.event,
        createdAt: envelope.event.sourceTime === undefined
          ? this.#clock()
          : new Date(envelope.event.sourceTime).toISOString(),
      },
    }, this.#context(envelope.worldId))
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
    const facts: WorldTraceFact[] = [
      ...this.#store.listWorldDomainEvents(worldId).map((value) => ({ kind: 'domain-event' as const, value })),
      ...this.#store.listSessions(worldId).flatMap((session) =>
        this.#store.listMessages(session.id).map((message) => ({
          kind: 'conversation' as const,
          value: { worldId, session, message },
        }))),
      ...(await this.#actions.listByWorld(worldId)).map((value) => ({ kind: 'skill-action' as const, value })),
    ]
    return deduplicate(facts.flatMap((fact) => this.#registry.adapt(fact, context)))
  }
}

export function createWorldTraceRegistry(): WorldTraceAdapterRegistry {
  const registry = new WorldTraceAdapterRegistry()
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
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
}

function compareCursor(entry: WorldTraceEntry, cursor: TraceCursor): number {
  return entry.createdAt.localeCompare(cursor.createdAt) || entry.id.localeCompare(cursor.id)
}

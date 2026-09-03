import type {
  AgentRun,
  TaskRun,
  WorkMessage,
  WorkTask,
  WorldArtifactRunProvenance,
  WorldTraceArtifactRef,
  WorldTraceEntry,
  WorldTracePage,
  WorldTraceQuery,
  WorldTraceToolStep,
} from '@dsh-cyber/contracts'
import type { ConversationRealtimeEnvelope } from '@dsh-cyber/orchestration'
import type { SqliteStore } from '@dsh-cyber/persistence'

import type { CharacterSkillActionRepository } from '../skills/skill-action-repository.js'
import type { ContextSnapshotService } from './context-snapshot-service.js'
import {
  AgentRunTraceAdapter,
  ConsolidationTraceAdapter,
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

/**
 * The only thing the trace needs from the Artifact registry.
 *
 * Narrow on purpose: the trace links to artifacts, it does not own them, and
 * it must never gain the ability to read or write artifact files.
 */
export interface WorldTraceArtifactProvenancePort {
  listRunProvenance(worldId: string): readonly WorldArtifactRunProvenance[]
}

/**
 * The only thing the trace needs from the Work System: which runs each task
 * recorded, and what the task is called. Read-only, and only durable rows.
 */
export interface WorldTraceTaskPort {
  listTasks(worldId: string): readonly Pick<WorkTask, 'id' | 'title'>[]
  listWorldTaskRuns(worldId: string): readonly Pick<TaskRun, 'taskId' | 'workTurnId' | 'agentRunIds'>[]
}

/** A trace's reference to a real task: the id to filter by, the title to read. */
export interface WorldTraceTaskRef {
  id: string
  title: string
}

export interface WorldTraceServiceOptions {
  store: SqliteStore
  actions: CharacterSkillActionRepository
  /** Optional: without it a run simply reports no artifacts, never a guessed one. */
  artifacts?: WorldTraceArtifactProvenancePort
  /** Optional: without it no run carries a task, never a placeholder for one. */
  tasks?: WorldTraceTaskPort
  /** Optional: without it no run carries context numbers, never zeros. */
  contexts?: Pick<ContextSnapshotService, 'summarizeWorld'>
  registry?: WorldTraceAdapterRegistry
  sanitizer?: TraceSanitizer
  clock?: () => string
}

export type WorldTraceCheckpoint = ReadonlyMap<string, string>

/** Bump whenever adapters/sanitizing change, so cached projections rebuild. */
const TRACE_PROJECTION_VERSION = 3
const MAX_CACHED_PROJECTIONS = 8

interface CachedTraceProjection {
  key: string
  entries: WorldTraceEntry[]
}

export class WorldTraceService {
  readonly #store: SqliteStore
  readonly #actions: CharacterSkillActionRepository
  readonly #artifacts: WorldTraceArtifactProvenancePort | undefined
  readonly #tasks: WorldTraceTaskPort | undefined
  readonly #contexts: Pick<ContextSnapshotService, 'summarizeWorld'> | undefined
  readonly #registry: WorldTraceAdapterRegistry
  readonly #sanitizer: TraceSanitizer
  readonly #clock: () => string
  readonly #liveRuns = new Map<string, WorldTraceEntry>()
  readonly #projections = new Map<string, CachedTraceProjection>()

  constructor(options: WorldTraceServiceOptions) {
    this.#store = options.store
    this.#actions = options.actions
    this.#artifacts = options.artifacts
    this.#tasks = options.tasks
    this.#contexts = options.contexts
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
      .filter((entry) => query.taskId === undefined || entry.taskId === query.taskId)
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
      const previous = this.#liveRuns.get(update.id)
      // A live envelope knows its turn, not its task, and `task_runs` cannot
      // exist yet. The first event of a run resolves the turn's seed hint once;
      // later events inherit the link through the merge and never re-read it.
      const merged = previous === undefined
        ? this.#withLiveTask(mergeTraceEntry(previous, update))
        : mergeTraceEntry(previous, update)
      this.#liveRuns.set(update.id, merged)
      if (merged.status !== 'running') setTimeout(() => this.#liveRuns.delete(merged.id), 30_000).unref?.()
      return merged
    })
  }

  #withLiveTask(entry: WorldTraceEntry): WorldTraceEntry {
    if (entry.status !== 'running' || entry.taskId !== undefined || entry.workTurnId === undefined) return entry
    const task = this.#liveTasksByTurn(entry.worldId).get(entry.workTurnId)
    if (task === undefined) return entry
    return this.#sanitizer.entry({ ...entry, taskId: task.id, taskTitle: task.title })
  }

  /**
   * The verified seed hints of a world: only ids that resolve to a task the
   * Work System lists for this same world. Without a task port there is no
   * verification, so there is no hint either.
   */
  #liveTasksByTurn(worldId: string): ReadonlyMap<string, WorldTraceTaskRef> {
    if (this.#tasks === undefined) return new Map()
    return groupTasksByRun(this.#tasks.listTasks(worldId), [], this.#store.listWorldTurnTaskHints(worldId)).hintedByTurn
  }

  #context(worldId: string) {
    const names = new Map(this.#store.listEmployees(worldId, true).map((employee) => [employee.id, employee.displayName]))
    return {
      sanitizer: this.#sanitizer,
      actorName: (actorId: string) => names.get(actorId),
    }
  }

  async #materialize(worldId: string): Promise<WorldTraceEntry[]> {
    const persisted = await this.#persistedProjection(worldId)
    // The persisted projection has already resolved durable task links. Strip
    // only the live card's hinted task fields before merging so a transient
    // seed hint cannot outrank a task_runs link that has landed meanwhile.
    const live = [...this.#liveRuns.values()]
      .filter((entry) => entry.worldId === worldId)
      .map(({ taskId: _hintedTaskId, taskTitle: _hintedTaskTitle, ...entry }) => entry)
    return live.length === 0 ? persisted : deduplicate([...persisted, ...live])
  }

  /**
   * The persisted projection is deterministic for a data state: while the
   * cheap watermark holds, reuse it instead of re-adapting the world's whole
   * history — a single chat turn used to trigger several full materializations
   * through list, checkpoint and changesSince. Callers only ever filter or
   * copy the returned array.
   */
  async #persistedProjection(worldId: string): Promise<WorldTraceEntry[]> {
    const watermark = this.#store.worldTraceWatermark(worldId)
    const key = `${TRACE_PROJECTION_VERSION}:${watermark}`
    const cached = this.#projections.get(worldId)
    if (cached !== undefined && cached.key === key) {
      this.#projections.delete(worldId)
      this.#projections.set(worldId, cached)
      return cached.entries
    }
    const context = this.#context(worldId)
    // Each run only ever reads its own messages. Handing the whole world's
    // transcript to every run made this quadratic: at 6,400 runs / 38,400
    // messages a single materialization spent over 1.6s in the nested scan,
    // and a chat POST materializes twice.
    const messagesByRun = groupMessagesByRun(this.#store.listWorldTraceMessages(worldId))
    const interactions = new Map(this.#store.listWorldModelInteractions(worldId)
      .filter((interaction) => interaction.agentRunId !== undefined)
      .map((interaction) => [interaction.agentRunId!, interaction]))
    const artifactsByRun = groupArtifactsByRun(this.#artifacts?.listRunProvenance(worldId) ?? [])
    const tasks = this.#tasks === undefined
      ? groupTasksByRun([], [])
      : groupTasksByRun(this.#tasks.listTasks(worldId), this.#tasks.listWorldTaskRuns(worldId), this.#store.listWorldTurnTaskHints(worldId))
    const contextsByRun = this.#contexts?.summarizeWorld(worldId) ?? new Map()
    const facts: WorldTraceFact[] = [
      ...this.#store.listWorldAgentRuns(worldId).map((run) => {
        const artifacts = artifactsByRun.get(run.id)
        // The durable `task_runs` link first. It cannot exist while the run is
        // live, so only in that window does the verified seed hint stand in;
        // once the run has ended, an unrecorded run carries no task.
        const task = tasks.byRun.get(run.id) ?? tasks.byTurn.get(run.turnId)
          ?? (isLiveRun(run) ? tasks.hintedByTurn.get(run.turnId) : undefined)
        const context = contextsByRun.get(run.id)
        return {
          kind: 'agent-run' as const,
          value: {
            worldId,
            run,
            messages: messagesByRun.get(run.id) ?? [],
            ...(interactions.get(run.id) === undefined ? {} : { interaction: interactions.get(run.id)! }),
            ...(artifacts === undefined ? {} : { artifacts }),
            ...(task === undefined ? {} : { task }),
            ...(context === undefined ? {} : { context }),
          },
        }
      }),
      ...this.#store.listWorldTraceDomainEvents(worldId, TRACE_INVISIBLE_EVENT_TYPES).map((value) => ({ kind: 'domain-event' as const, value })),
      ...(await this.#actions.listByWorld(worldId)).map((value) => ({ kind: 'skill-action' as const, value })),
      ...this.#store.listWorldConsolidationFailures(worldId).map(({ id, ...job }) => ({ kind: 'consolidation' as const, value: { worldId, jobId: id, ...job } })),
    ]
    const persisted = deduplicate(facts.flatMap((fact) => this.#registry.adapt(fact, context)))
    if (this.#projections.size >= MAX_CACHED_PROJECTIONS) {
      const oldest = this.#projections.keys().next()
      if (!oldest.done) this.#projections.delete(oldest.value)
    }
    this.#projections.set(worldId, { key, entries: persisted })
    return persisted
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

/**
 * Indexes published artifact versions by the run that produced them.
 *
 * Only a durable AgentRun id is precise enough for an AgentRun trace card. One
 * WorkTurn may contain several runs, so a version carrying only workTurnId is
 * deliberately omitted here rather than being duplicated onto every sibling.
 */
export function groupArtifactsByRun(
  provenance: readonly WorldArtifactRunProvenance[],
): Map<string, WorldTraceArtifactRef[]> {
  const grouped = new Map<string, WorldTraceArtifactRef[]>()
  for (const version of provenance) {
    const key = version.agentRunId
    if (key === undefined) continue
    const reference: WorldTraceArtifactRef = {
      artifactId: version.artifactId,
      title: version.title,
      kind: version.kind,
      version: version.version,
      createdAt: version.createdAt,
    }
    const bucket = grouped.get(key)
    if (bucket === undefined) grouped.set(key, [reference])
    else bucket.push(reference)
  }
  return grouped
}

/**
 * Indexes the tasks of a world by the runs that worked on them.
 *
 * `task_runs` is the one durable statement that a run belonged to a task. It
 * names the runs directly (`agentRunIds`) and the turn they ran in; both keys
 * are kept because a run recorded before the id list was complete is still
 * reachable through its turn. A task row that no longer exists yields no
 * link — the trace never names a task it cannot show.
 *
 * `hints` are the seed messages' `workTaskId`s, kept apart in `hintedByTurn`:
 * they are host-written but read back from message metadata, so one counts
 * only when it names a task in `tasks` — the same world's list — and the
 * caller decides in which window (a live run) a hint may stand in.
 */
export function groupTasksByRun(
  tasks: readonly Pick<WorkTask, 'id' | 'title'>[],
  runs: readonly Pick<TaskRun, 'taskId' | 'workTurnId' | 'agentRunIds'>[],
  hints: readonly { workTurnId: string; workTaskId: string }[] = [],
): { byRun: Map<string, WorldTraceTaskRef>; byTurn: Map<string, WorldTraceTaskRef>; hintedByTurn: Map<string, WorldTraceTaskRef> } {
  const titles = new Map(tasks.map((task) => [task.id, task.title]))
  const byRun = new Map<string, WorldTraceTaskRef>()
  const byTurn = new Map<string, WorldTraceTaskRef>()
  const hintedByTurn = new Map<string, WorldTraceTaskRef>()
  for (const run of runs) {
    const title = titles.get(run.taskId)
    if (title === undefined) continue
    const reference: WorldTraceTaskRef = { id: run.taskId, title }
    byTurn.set(run.workTurnId, reference)
    for (const agentRunId of run.agentRunIds) byRun.set(agentRunId, reference)
  }
  for (const hint of hints) {
    const title = titles.get(hint.workTaskId)
    if (title === undefined) continue
    hintedByTurn.set(hint.workTurnId, { id: hint.workTaskId, title })
  }
  return { byRun, byTurn, hintedByTurn }
}

/** A run `task_runs` cannot know yet: the Work System records a turn only after every run in it has ended. */
function isLiveRun(run: Pick<AgentRun, 'status'>): boolean {
  return run.status === 'queued' || run.status === 'running'
}

export function createWorldTraceRegistry(): WorldTraceAdapterRegistry {
  const registry = new WorldTraceAdapterRegistry()
  registry.register(new AgentRunTraceAdapter())
  registry.register(new DomainEventTraceAdapter())
  registry.register(new RuntimeEventTraceAdapter())
  registry.register(new SkillActionTraceAdapter())
  registry.register(new ConversationTraceAdapter())
  registry.register(new ScheduleTraceAdapter())
  registry.register(new ConsolidationTraceAdapter())
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
    entry.taskTitle,
    entry.actorId === undefined ? undefined : actorNames.get(entry.actorId),
    entry.modelId,
    entry.provider,
    ...((entry.tools ?? []).flatMap((tool) => [tool.label, tool.name])),
    ...((entry.artifacts ?? []).map((artifact) => artifact.title)),
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
    const merged: WorldTraceToolStep = {
      ...previous,
      ...tool,
      ...(completedWithoutIdentity ? { name: previous.name, label: previous.label, description: previous.description } : {}),
    }
    if (merged.durationMs === undefined && merged.createdAt !== undefined && merged.completedAt !== undefined) {
      const span = Date.parse(merged.completedAt) - Date.parse(merged.createdAt)
      if (Number.isFinite(span) && span >= 0) merged.durationMs = span
    }
    tools.set(tool.callId, merged)
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

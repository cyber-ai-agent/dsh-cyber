import type {
  ContextEnvelope,
  ContextSnapshot,
  ContextSnapshotLayer,
  ContextSourceRef,
  EmployeeMemoryIndexEntry,
  EmployeeMemoryScope,
  WorkMessage,
} from '@dsh-cyber/contracts'
import { composeContextSnapshot } from '@dsh-cyber/contracts'
import type { SqliteStore } from '@dsh-cyber/persistence'

import { sessionMemoryScope, visibleMemoryScopes } from './employee-conversation-memory-service.js'

/**
 * Saving and reading back what an AgentRun ran with (slice D4).
 *
 * The snapshot itself holds no prompt text — only layer structure, hashes,
 * token counts and pointers at durable rows. That is a deliberate trade: the
 * stored record is small and carries no user content of its own, and the price
 * is that reading the actual content back is a *read of the originals*, not a
 * read of the snapshot.
 *
 * Which is the whole point. A copy of the prompt would keep whatever the
 * composer decided a group turn could see at the moment it ran, and would keep
 * it in a table with no scope of its own. A pointer has to be dereferenced,
 * and dereferencing goes through the same rules the composer applied:
 *
 *  - the visible scopes come from the run's own durable `WorkSession`, never
 *    from the caller, exactly as in `ConversationContextComposer`;
 *  - every relocated message is re-checked against the scope of the session it
 *    actually lives in, exactly as in `hydrateMemorySources`.
 *
 * So a snapshot cannot become a side door onto a private message: if a private
 * id ever ends up referenced by a group run's snapshot, reconstruction refuses
 * it and says so, rather than rendering it.
 */

type SnapshotStore = Pick<SqliteStore, 'getAgentRun' | 'getSession' | 'getMessages'>
  & Partial<Pick<
    SqliteStore,
    'saveAgentRunContextSnapshot' | 'getAgentRunContextSnapshot' | 'getEmployeeMemoryIndexEntry'
  >>

/** One layer, rebuilt from the rows its pointers still resolve to. */
export interface ReconstructedContextLayer {
  id: string
  kind: ContextSnapshotLayer['kind']
  contentHash: string
  tokenEstimate: number
  /** Durable messages this layer pointed at, that this scope may read. */
  messages: WorkMessage[]
  /** Memory index entries this layer pointed at, that this scope may read. */
  memories: EmployeeMemoryIndexEntry[]
  /** Pointers this view does not dereference at all (employee, skill, request…). */
  unresolvedRefs: ContextSourceRef[]
  /** Pointers a scope check refused, or that no longer resolve to a row. */
  refusedRefs: ContextSourceRef[]
}

/**
 * The safe view: original rows, re-checked, never a stored copy of the prompt.
 */
export interface ReconstructedContextView {
  agentRunId: string
  sessionId: string
  employeeId: string
  stablePrefixHash: string
  structureHash: string
  totalTokenEstimate: number
  /** The scopes the run's own conversation is allowed to see. */
  visibleScopes: EmployeeMemoryScope[]
  layers: ReconstructedContextLayer[]
  /** Pointers refused across every layer. Non-zero is worth investigating. */
  refusedRefCount: number
}

/** Ref kinds this view knows how to dereference; everything else stays a pointer. */
const RESOLVED_KINDS: ReadonlySet<ContextSourceRef['kind']> = new Set<ContextSourceRef['kind']>([
  'message',
  'memory',
])

export class ContextSnapshotService {
  readonly #store: SnapshotStore

  constructor(store: SnapshotStore) {
    this.#store = store
  }

  /**
   * Saves the snapshot for a run. Returns `undefined` when the store predates
   * the snapshot table or the run is unknown, because a missing observability
   * record must never fail the turn that produced it.
   */
  save(input: { agentRunId: string; envelope: ContextEnvelope }): ContextSnapshot | undefined {
    const write = this.#store.saveAgentRunContextSnapshot
    if (write === undefined) return undefined
    if (this.#store.getAgentRun(input.agentRunId) === undefined) return undefined
    return write.call(this.#store, {
      agentRunId: input.agentRunId,
      snapshot: composeContextSnapshot({ envelope: input.envelope }),
    })
  }

  /**
   * Rebuilds the debuggable view of a run's context from its pointers.
   *
   * Scope is taken from the run's own session on every call. A caller cannot
   * widen it, and a snapshot whose refs disagree with it loses the argument.
   */
  reconstruct(agentRunId: string): ReconstructedContextView | undefined {
    const read = this.#store.getAgentRunContextSnapshot
    if (read === undefined) return undefined
    const snapshot = read.call(this.#store, agentRunId)
    const run = this.#store.getAgentRun(agentRunId)
    if (snapshot === undefined || run === undefined) return undefined
    const session = this.#store.getSession(run.sessionId)
    if (session === undefined) return undefined

    const visible = new Set(visibleMemoryScopes(session))
    const messages = this.#readableMessages(snapshot, run.worldId, visible)

    let refusedRefCount = 0
    const layers = snapshot.layers.map((layer): ReconstructedContextLayer => {
      const rebuilt: ReconstructedContextLayer = {
        id: layer.id,
        kind: layer.kind,
        contentHash: layer.contentHash,
        tokenEstimate: layer.tokenEstimate,
        messages: [],
        memories: [],
        unresolvedRefs: [],
        refusedRefs: [],
      }
      for (const ref of layer.sourceRefs) {
        if (!RESOLVED_KINDS.has(ref.kind)) {
          rebuilt.unresolvedRefs.push(ref)
          continue
        }
        if (ref.kind === 'message') {
          const message = messages.get(ref.id)
          if (message === undefined) rebuilt.refusedRefs.push(ref)
          else rebuilt.messages.push(message)
          continue
        }
        const memory = this.#readableMemory(ref.id, run.employeeId, run.worldId, visible)
        if (memory === undefined) rebuilt.refusedRefs.push(ref)
        else rebuilt.memories.push(memory)
      }
      refusedRefCount += rebuilt.refusedRefs.length
      return rebuilt
    })

    return {
      agentRunId,
      sessionId: run.sessionId,
      employeeId: run.employeeId,
      stablePrefixHash: snapshot.stablePrefixHash,
      structureHash: snapshot.structureHash,
      totalTokenEstimate: snapshot.totalTokenEstimate,
      visibleScopes: [...visible],
      layers,
      refusedRefCount,
    }
  }

  /**
   * Relocates the referenced messages and drops the ones this scope may not read.
   *
   * `getMessages` is a pure relocation by id and applies no rule of its own, so
   * the scope of the session each message actually lives in is what decides —
   * the same second opinion `hydrateMemorySources` takes, for the same reason:
   * a snapshot is derived data, and derived data must never be the only thing
   * standing between a private message and a reader.
   */
  #readableMessages(
    snapshot: ContextSnapshot,
    worldId: string,
    visible: ReadonlySet<EmployeeMemoryScope>,
  ): Map<string, WorkMessage> {
    const wanted = new Set<string>()
    for (const layer of snapshot.layers) {
      for (const ref of layer.sourceRefs) {
        if (ref.kind === 'message') wanted.add(ref.id)
      }
    }
    const readable = new Map<string, WorkMessage>()
    if (wanted.size === 0) return readable
    for (const message of this.#store.getMessages([...wanted])) {
      const origin = this.#store.getSession(message.sessionId)
      if (origin === undefined || origin.worldId !== worldId) continue
      if (!visible.has(sessionMemoryScope(origin))) continue
      readable.set(message.id, message)
    }
    return readable
  }

  /** A memory entry is readable only for its own character, world and scope. */
  #readableMemory(
    memoryId: string,
    employeeId: string,
    worldId: string,
    visible: ReadonlySet<EmployeeMemoryScope>,
  ): EmployeeMemoryIndexEntry | undefined {
    const entry = this.#store.getEmployeeMemoryIndexEntry?.(memoryId)
    if (entry === undefined) return undefined
    if (entry.employeeId !== employeeId || entry.worldId !== worldId) return undefined
    return visible.has(entry.scope) ? entry : undefined
  }
}

/**
 * Builds the service for a store that carries the rows it needs.
 *
 * A narrower store (a legacy embedder, a unit-test stub) simply gets none and
 * keeps the previous behaviour: no snapshot is written, and nothing fails.
 */
export function defaultContextSnapshotService(
  store: Partial<SnapshotStore> & Record<string, unknown>,
): ContextSnapshotService | undefined {
  if (typeof store.getAgentRun !== 'function') return undefined
  if (typeof store.getSession !== 'function' || typeof store.getMessages !== 'function') return undefined
  if (typeof store.saveAgentRunContextSnapshot !== 'function') return undefined
  return new ContextSnapshotService(store as SnapshotStore)
}

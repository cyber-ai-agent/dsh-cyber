import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { open, readFile, rename } from 'node:fs/promises'

import type { ConversationHubItem } from '@dsh-cyber/contracts/creative-platform'
import type { SqliteStore } from '@dsh-cyber/persistence'

import { WorldRootService } from './world-root-service.js'
import { ServiceError } from './service-error.js'

interface ConversationEntryState {
  pinned?: boolean
  hidden?: boolean
}

interface ConversationHubState {
  version: 1
  entries: Record<string, ConversationEntryState>
}

/** Upper bound for the last-prompt preview carried in hub payloads. */
const LAST_PROMPT_PREVIEW_MAX = 120

function compactPromptPreview(content: string | undefined): string | undefined {
  if (content === undefined) return undefined
  const compact = content.replace(/\s+/gu, ' ').trim()
  if (compact.length === 0) return undefined
  return compact.length > LAST_PROMPT_PREVIEW_MAX ? `${compact.slice(0, LAST_PROMPT_PREVIEW_MAX)}…` : compact
}

export class ConversationHubService {
  readonly #store: SqliteStore
  readonly #roots: WorldRootService

  constructor(store: SqliteStore) {
    this.#store = store
    this.#roots = new WorldRootService(stateRootFromStore(store))
  }

  async ensureDirectSessions(worldId: string): Promise<void> {
    const world = this.#store.getWorld(worldId)
    if (world === undefined) throw new ServiceError('not-found', 'world_not_found', 'World not found')
    const sessions = this.#store.listSessions(worldId, 'open')
    const directOwners = new Set<string>()
    for (const session of sessions.filter((item) => item.kind === 'direct')) {
      const employeeIds = this.#store
        .listParticipants(session.id)
        .filter((item) => item.kind === 'employee')
        .map((item) => item.participantId)
      if (employeeIds.length === 1) directOwners.add(employeeIds[0]!)
    }
    for (const character of this.#store.listEmployees(worldId).filter((item) => item.status !== 'archived')) {
      if (directOwners.has(character.id)) continue
      this.#store.createSession({
        workspaceId: world.workspaceId,
        worldId,
        kind: 'direct',
        title: `与 ${character.displayName} 对话`,
        participants: [
          { participantId: 'owner', kind: 'owner' },
          { participantId: character.id, kind: 'employee' },
        ],
        actorId: 'system',
      })
    }
  }

  async list(worldId: string): Promise<ConversationHubItem[]> {
    await this.ensureDirectSessions(worldId)
    const state = await this.#read(worldId)
    const items: ConversationHubItem[] = []
    for (const session of this.#store.listSessions(worldId, 'open')) {
      const participantIds = this.#store
        .listParticipants(session.id)
        .filter((item) => item.kind === 'employee')
        .map((item) => item.participantId)
      const canonicalCharacterId = session.kind === 'direct' && participantIds.length === 1
        ? participantIds[0]
        : undefined
      const character = canonicalCharacterId === undefined
        ? undefined
        : this.#store.getEmployee(canonicalCharacterId)
      const explicit = state.entries[session.id]
      const pinned = explicit?.pinned ?? character?.blueprintId === 'core.butler'
      const lastPrompt = compactPromptPreview(this.#store.latestMessageBySender(session.id, 'owner')?.content)
      items.push({
        session,
        participantIds,
        pinned,
        hidden: explicit?.hidden ?? false,
        ...(canonicalCharacterId === undefined ? {} : { canonicalCharacterId }),
        ...(lastPrompt === undefined ? {} : { lastPrompt }),
      })
    }
    return items.sort((left, right) => {
      if (left.hidden !== right.hidden) return left.hidden ? 1 : -1
      if (left.pinned !== right.pinned) return left.pinned ? -1 : 1
      const updated = right.session.updatedAt.localeCompare(left.session.updatedAt)
      return updated === 0 ? left.session.id.localeCompare(right.session.id) : updated
    })
  }

  async setPinned(sessionId: string, pinned: boolean): Promise<ConversationHubItem[]> {
    const session = this.#requireSession(sessionId)
    const state = await this.#read(session.worldId)
    state.entries[session.id] = { ...state.entries[session.id], pinned }
    await this.#write(session.worldId, state)
    return this.list(session.worldId)
  }

  async setHidden(sessionId: string, hidden: boolean): Promise<ConversationHubItem[]> {
    const session = this.#requireSession(sessionId)
    const state = await this.#read(session.worldId)
    state.entries[session.id] = { ...state.entries[session.id], hidden }
    await this.#write(session.worldId, state)
    return this.list(session.worldId)
  }

  async restoreCanonicalDirect(sessionId: string): Promise<void> {
    const session = this.#store.getSession(sessionId)
    if (session === undefined || session.kind !== 'direct') return
    const state = await this.#read(session.worldId)
    if (state.entries[session.id]?.hidden !== true) return
    state.entries[session.id] = { ...state.entries[session.id], hidden: false }
    await this.#write(session.worldId, state)
  }

  #requireSession(sessionId: string) {
    const session = this.#store.getSession(sessionId)
    if (session === undefined) throw new ServiceError('not-found', 'session_not_found', 'Session not found')
    return session
  }

  async #path(worldId: string): Promise<string> {
    return join((await this.#roots.ensure(worldId)).rootPath, 'conversation-hub.json')
  }

  async #read(worldId: string): Promise<ConversationHubState> {
    try {
      const value = JSON.parse(await readFile(await this.#path(worldId), 'utf8')) as Partial<ConversationHubState>
      if (value.version !== 1 || value.entries === null || typeof value.entries !== 'object' || Array.isArray(value.entries)) {
        return { version: 1, entries: {} }
      }
      return { version: 1, entries: value.entries as Record<string, ConversationEntryState> }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, entries: {} }
      throw error
    }
  }

  async #write(worldId: string, state: ConversationHubState): Promise<void> {
    const path = await this.#path(worldId)
    const temporary = `${path}.tmp-${randomUUID()}`
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, path)
  }
}

function stateRootFromStore(store: SqliteStore): string {
  return dirname(dirname(store.databasePath))
}

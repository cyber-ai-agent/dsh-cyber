import { createHash } from 'node:crypto'

import type { WorkMessage, WorldArtifactPublication } from '@dsh-cyber/contracts'
import type { SqliteStore } from '@dsh-cyber/persistence'

import { ServiceError } from './service-error.js'
import type { WorldArtifactService } from './world-artifact-service.js'

/**
 * "Keep this reply" is a different fact from "this run produced a file".
 *
 * A reply the owner chooses to keep becomes a real document in the World, but
 * the Host watched nobody execute anything to make it: the bytes are the ones
 * already stored in the conversation. That is exactly `owner-published`, and
 * this service is the only path to it, so it fixes every input the grade
 * depends on rather than accepting them:
 *
 * - the body is read back from the Host's own message store, never from the
 *   caller, so a browser cannot dress arbitrary text as a character's reply;
 * - the World and workspace come from the message's own conversation, so a
 *   reply cannot be filed into a World it was never said in;
 * - nothing here can name an AgentRun, a WorkTurn or an employee, because the
 *   publish input it calls has no field for one.
 */
export interface SavedReplyDocumentServiceOptions {
  store: SqliteStore
  artifacts: WorldArtifactService
}

export interface SaveAssistantReplyInput {
  /** The World the owner is filing the document into. */
  worldId: string
  messageId: string
  /** An owner-chosen name; the reply's own opening line is used otherwise. */
  title?: string
}

/** How much of a reply's opening line may become the document's name. */
const MAX_DERIVED_TITLE_LENGTH = 40
const MAX_TITLE_LENGTH = 120

export class SavedReplyDocumentService {
  readonly #store: SqliteStore
  readonly #artifacts: WorldArtifactService

  constructor(options: SavedReplyDocumentServiceOptions) {
    this.#store = options.store
    this.#artifacts = options.artifacts
  }

  async saveAssistantReply(input: SaveAssistantReplyInput): Promise<WorldArtifactPublication> {
    const messageId = input.messageId.trim()
    if (messageId === '') throw invalid('artifact_reply_not_found', '找不到这条回复')
    const message = this.#store.getMessages([messageId]).find((candidate) => candidate.id === messageId)
    if (message === undefined) throw notFound('artifact_reply_not_found', '找不到这条回复')
    const session = this.#store.getSession(message.sessionId)
    if (session === undefined) throw notFound('artifact_reply_not_found', '找不到这条回复所在的会话')
    // A message id is not an authority to publish anywhere: the conversation it
    // belongs to decides which World and workspace may receive the document.
    if (session.worldId !== input.worldId) throw forbidden('artifact_reply_world_mismatch', '这条回复不属于当前世界')
    if (message.kind !== 'assistant' || message.senderKind !== 'employee') {
      throw invalid('artifact_reply_not_assistant', '只能把角色回复保存为文档')
    }
    if (message.content.trim() === '') throw invalid('artifact_reply_empty', '这条回复没有可保存的正文')

    const title = ownerTitle(input.title) ?? derivedTitle(message)
    return await this.#artifacts.publishOwnerDocument({
      workspaceId: session.workspaceId,
      worldId: session.worldId,
      text: message.content,
      title,
      description: '你从会话中保存下来的回复正文；没有角色运行执行过它。',
      // The reply is immutable, so message id plus content digest names the
      // same document on every retry: a double click keeps one document, and a
      // crash between the file move and the registry commit repairs itself.
      artifactId: savedReplyArtifactId(session.worldId, message.id, message.content),
      idempotencyKey: `owner-reply:v1:${message.id}:${digest(message.content)}`,
    })
  }
}

function ownerTitle(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  if (trimmed === undefined || trimmed === '') return undefined
  return [...trimmed].slice(0, MAX_TITLE_LENGTH).join('')
}

/**
 * A name the owner will recognise in the artifact list, taken from the reply.
 *
 * The opening line is the closest thing a Markdown reply has to a title, so
 * its heading marks, list bullets, quote marks and emphasis are peeled off and
 * the rest is used verbatim. Nothing is invented: an unusable line falls back
 * to a plainly generic name rather than to a guess about the content.
 */
function derivedTitle(message: WorkMessage): string {
  const line = message.content
    .split(/\r?\n/)
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.replace(/[#>\-*_`\s]/gu, '') !== '')
  const cleaned = (line ?? '')
    .replace(/^#{1,6}\s*/u, '')
    .replace(/^[>\-*+]\s*/u, '')
    .replace(/^\d+[.)]\s*/u, '')
    .replaceAll('`', '')
    .replace(/\*\*(.+?)\*\*/gu, '$1')
    .replace(/\s+/gu, ' ')
    .trim()
  if (cleaned === '') return '会话文档'
  const characters = [...cleaned]
  return characters.length <= MAX_DERIVED_TITLE_LENGTH
    ? cleaned
    : `${characters.slice(0, MAX_DERIVED_TITLE_LENGTH).join('').trim()}…`
}

function savedReplyArtifactId(worldId: string, messageId: string, content: string): string {
  const value = createHash('sha256').update(`${worldId}\0owner-reply\0${messageId}\0${digest(content)}`).digest('hex')
  // UUID-shaped so the id stays a familiar public contract and a safe
  // directory name, while remaining stable across restarts.
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-5${value.slice(13, 16)}-8${value.slice(17, 20)}-${value.slice(20, 32)}`
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function notFound(code: string, message: string): ServiceError { return new ServiceError('not-found', code, message) }
function invalid(code: string, message: string): ServiceError { return new ServiceError('invalid', code, message) }
function forbidden(code: string, message: string): ServiceError { return new ServiceError('forbidden', code, message) }

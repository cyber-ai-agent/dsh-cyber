import type { ConversationHistoryEntry, WorkMessage } from '@dsh-cyber/contracts'

/**
 * Display identity for one participant of a conversation.
 *
 * Group history has to keep who actually spoke. Collapsing every character
 * into a single "assistant" voice destroys role identity, which is the exact
 * failure this project refuses to ship.
 */
export interface ConversationHistorySpeaker {
  id: string
  displayName: string
}

export interface ConversationHistoryBudget {
  /** Maximum number of recovered messages, newest first. */
  maxMessages: number
  /** Maximum number of characters across all recovered messages. */
  maxCharacters: number
}

/** Roughly twelve exchanges, bounded by characters rather than tokens. */
export const DEFAULT_CONVERSATION_HISTORY_BUDGET: ConversationHistoryBudget = {
  maxMessages: 24,
  maxCharacters: 16_000,
}

export const CONVERSATION_HISTORY_TRUNCATION_NOTICE = '[内容因上下文预算已截断]'

/** Below this a truncated remainder carries no usable context. */
const MINIMUM_TRUNCATED_CHARACTERS = 120

const OWNER_SPEAKER_NAME = '用户'

const CREDENTIAL_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
  /\b(?:api[-_ ]?key|authorization|password|passphrase|secret|token|credential)\s*[:=]\s*[^\s,;]+/gi,
]

const CREDENTIAL_PLACEHOLDER = '[已隐藏敏感信息]'

/**
 * Metadata flags that mark a message as something other than a durable chat
 * fact: optimistic client bubbles, product notices and failure banners.
 */
const NON_CONVERSATIONAL_FLAGS = [
  'localPending',
  'transient',
  'hidden',
  'ephemeral',
  'failed',
  'historyExcluded',
] as const

/**
 * Recovers the user-visible chat history of a single conversation.
 *
 * The function is pure: it never mutates `messages`, never reads any store and
 * never calls a model. Callers pass the messages of exactly one WorkSession, so
 * a direct chat can never inherit group context and no world can leak into
 * another.
 *
 * Selection walks from the newest message backwards until either budget is
 * exhausted, then restores chronological order.
 */
export function buildConversationHistory(
  messages: readonly WorkMessage[],
  participants: readonly ConversationHistorySpeaker[],
  budget: ConversationHistoryBudget = DEFAULT_CONVERSATION_HISTORY_BUDGET,
): ConversationHistoryEntry[] {
  const maxMessages = Math.max(0, Math.trunc(budget.maxMessages))
  const maxCharacters = Math.max(0, Math.trunc(budget.maxCharacters))
  if (maxMessages === 0 || maxCharacters === 0) return []

  const names = new Map(participants.map((participant) => [participant.id, participant.displayName]))
  const ordered = [...messages].sort((left, right) => left.sequence - right.sequence)
  const selected: ConversationHistoryEntry[] = []
  let usedCharacters = 0

  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const message = ordered[index]!
    if (!isConversationalMessage(message)) continue
    const content = redactCredentials(message.content).trim()
    if (content.length === 0) continue
    if (selected.length >= maxMessages) break

    const remaining = maxCharacters - usedCharacters
    if (remaining <= 0) break

    if (content.length <= remaining) {
      selected.push(entryFor(message, content, names))
      usedCharacters += content.length
      continue
    }

    const allowance = remaining - CONVERSATION_HISTORY_TRUNCATION_NOTICE.length - 1
    if (allowance < MINIMUM_TRUNCATED_CHARACTERS && selected.length > 0) break
    const kept = allowance > 0 ? content.slice(0, allowance) : ''
    selected.push(entryFor(
      message,
      kept.length > 0 ? `${kept}\n${CONVERSATION_HISTORY_TRUNCATION_NOTICE}` : CONVERSATION_HISTORY_TRUNCATION_NOTICE,
      names,
    ))
    break
  }

  return selected.reverse()
}

function isConversationalMessage(message: WorkMessage): boolean {
  if (message.kind !== 'user' && message.kind !== 'assistant') return false
  // A user/assistant row authored by the system is a product notice, not chat.
  if (message.senderKind === 'system') return false
  return !NON_CONVERSATIONAL_FLAGS.some((flag) => message.metadata[flag] === true)
}

function entryFor(
  message: WorkMessage,
  content: string,
  names: ReadonlyMap<string, string>,
): ConversationHistoryEntry {
  const role = message.kind === 'user' ? 'user' : 'assistant'
  return {
    role,
    speakerId: message.senderId,
    speakerName: speakerName(message, role, names),
    content,
    createdAt: message.createdAt,
  }
}

function speakerName(
  message: WorkMessage,
  role: ConversationHistoryEntry['role'],
  names: ReadonlyMap<string, string>,
): string {
  if (message.senderKind === 'owner') return OWNER_SPEAKER_NAME
  const known = names.get(message.senderId)
  if (known !== undefined && known.trim().length > 0) return known.trim()
  return role === 'user' ? OWNER_SPEAKER_NAME : message.senderId
}

function redactCredentials(value: string): string {
  let redacted = value
  for (const pattern of CREDENTIAL_PATTERNS) {
    redacted = redacted.replace(pattern, CREDENTIAL_PLACEHOLDER)
  }
  return redacted
}

import { useSyncExternalStore } from 'react'
import type { ComposerAttachmentDraft } from './composer-draft-store.js'

const STORAGE_KEY = 'dsh-cyber:chat-submissions:v1'

/** A receipt awaiting confirmation. Retries use the exact same ingress body. */
export interface ChatSubmission {
  id: string
  ownerKey: string
  queueKey: string
  worldId: string
  title: string
  employeeIds: string[]
  createdAt: string
  sessionId?: string
  body: string
  draft: { text: string; attachments: ComposerAttachmentDraft[]; modelProfileId?: string }
  status: 'sending' | 'uncertain' | 'rejected'
  error?: string
}

export class ChatSubmissionStore {
  #items: ChatSubmission[] = []
  #loaded = false
  readonly #listeners = new Set<() => void>()

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  getSnapshot = (): readonly ChatSubmission[] => {
    if (!this.#loaded) {
      this.#loaded = true
      try {
        const value: unknown = JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) ?? '[]')
        if (Array.isArray(value)) this.#items = value.flatMap((item) => {
          if (!isSubmission(item)) return []
          // A tab reload ends our knowledge of the transport, not the host's work.
          return [{ ...item, status: item.status === 'sending' ? 'uncertain' as const : item.status }]
        })
      } catch { /* The current tab still retains its in-memory receipts. */ }
    }
    return this.#items
  }

  put(item: ChatSubmission): void {
    this.getSnapshot()
    this.#items = [...this.#items.filter((entry) => entry.id !== item.id), item]
    this.#commit()
  }

  remove(id: string): void {
    this.getSnapshot()
    this.#items = this.#items.filter((entry) => entry.id !== id)
    this.#commit()
  }

  #commit(): void {
    try { window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(this.#items)) } catch { /* Preserve the in-memory copy. */ }
    for (const listener of this.#listeners) listener()
  }
}

function isSubmission(value: unknown): value is ChatSubmission {
  if (value === null || typeof value !== 'object') return false
  const item = value as Partial<ChatSubmission>
  if (typeof item.id !== 'string' || typeof item.ownerKey !== 'string' || typeof item.queueKey !== 'string'
    || typeof item.worldId !== 'string' || typeof item.title !== 'string' || typeof item.createdAt !== 'string'
    || typeof item.body !== 'string' || !Array.isArray(item.employeeIds) || !item.employeeIds.every((id) => typeof id === 'string')
    || !['sending', 'uncertain', 'rejected'].includes(item.status ?? '')
    || typeof item.draft?.text !== 'string' || !Array.isArray(item.draft.attachments)) return false
  try {
    const body = JSON.parse(item.body) as { clientTurnId?: unknown; prompt?: unknown }
    const owner = JSON.parse(item.ownerKey) as unknown
    return body.clientTurnId === item.id && typeof body.prompt === 'string'
      && Array.isArray(owner) && owner[0] === item.worldId && owner[1] === item.queueKey
      && item.draft.attachments.every((entry) => entry.status === 'ready' && typeof entry.attachment?.assetId === 'string'
        && typeof entry.attachment?.name === 'string' && typeof entry.attachment?.mimeType === 'string'
        && typeof entry.attachment?.url === 'string' && entry.attachment.url.startsWith('/api/'))
  } catch { return false }
}

export const chatSubmissionStore = new ChatSubmissionStore()

export function useChatSubmissions(): readonly ChatSubmission[] {
  return useSyncExternalStore(chatSubmissionStore.subscribe, chatSubmissionStore.getSnapshot, chatSubmissionStore.getSnapshot)
}

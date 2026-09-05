import { useSyncExternalStore } from 'react'
import type { ChatAttachment, LocalAssetMimeType } from '@dsh-cyber/contracts'

const STORAGE_KEY = 'dsh-cyber:composer-drafts:v1'
const SESSION_ALIAS_STORAGE_KEY = 'dsh-cyber:composer-session-aliases:v1'
const MAX_DRAFT_ATTACHMENTS = 8

export type ComposerAttachmentStatus = 'uploading' | 'ready' | 'failed' | 'interrupted'

/** One attachment in the local composer draft, including a visible upload state. */
export interface ComposerAttachmentDraft {
  id: string
  name: string
  mimeType?: LocalAssetMimeType
  byteLength?: number
  status: ComposerAttachmentStatus
  attachment?: ChatAttachment
  error?: string
}

export interface ComposerDraft {
  text: string
  attachments: ComposerAttachmentDraft[]
  /** Temporary per-conversation model override; durable role assignments live elsewhere. */
  modelProfileId?: string
  /** Changes whenever this owner draft is edited, consumed, or cleared. */
  revision: number
}

export interface ComposerDraftSnapshot {
  text: string
  attachmentIds: readonly string[]
  /** Revision observed immediately before submitting the snapshot. */
  revision: number
}

const EMPTY_DRAFT: ComposerDraft = Object.freeze({ text: '', attachments: [], revision: 0 })

/**
 * Serializes the owner identity as data instead of concatenating delimiter
 * separated ids. World and conversation ids can therefore never collide when
 * either one contains a delimiter character.
 */
export function composerDraftOwnerKey(worldId: string, conversationKey: string): string {
  return JSON.stringify([worldId, conversationKey])
}

/**
 * A small external store keeps the App shell from accumulating composer state
 * machinery while allowing ChatWorkbench callbacks to update one owner even
 * after the visible world or session has changed.
 */
export class ComposerDraftStore {
  readonly #drafts = new Map<string, ComposerDraft>()
  readonly #sessionAliases = new Map<string, string>()
  readonly #listeners = new Set<() => void>()
  #loaded = false
  #aliasesLoaded = false

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  get(ownerKey: string | undefined): ComposerDraft {
    if (ownerKey === undefined) return EMPTY_DRAFT
    this.#load()
    return this.#drafts.get(ownerKey) ?? EMPTY_DRAFT
  }

  setText(ownerKey: string | undefined, text: string): void {
    if (ownerKey === undefined) return
    this.#update(ownerKey, (current) => ({
      ...current,
      // Keep the user's text intact. The server's prompt boundary reports an
      // over-limit submission explicitly; the local draft must never lose
      // content silently while the user is still composing it.
      text,
    }))
  }

  setModelProfile(ownerKey: string | undefined, modelProfileId: string | undefined): void {
    if (ownerKey === undefined) return
    this.#update(ownerKey, (current) => {
      if (modelProfileId === undefined || modelProfileId.trim() === '') {
        if (current.modelProfileId === undefined) return current
        const next = { ...current }
        delete next.modelProfileId
        return next
      }
      if (current.modelProfileId === modelProfileId) return current
      return { ...current, modelProfileId }
    })
  }

  setAttachments(ownerKey: string | undefined, attachments: ComposerAttachmentDraft[]): void {
    if (ownerKey === undefined) return
    this.#update(ownerKey, (current) => ({ ...current, attachments: [...attachments].slice(0, MAX_DRAFT_ATTACHMENTS) }))
  }

  updateAttachments(
    ownerKey: string | undefined,
    updater: (current: readonly ComposerAttachmentDraft[]) => ComposerAttachmentDraft[],
  ): void {
    if (ownerKey === undefined) return
    this.#update(ownerKey, (current) => ({
      ...current,
      attachments: updater(current.attachments).slice(0, MAX_DRAFT_ATTACHMENTS),
    }))
  }

  /**
   * Consume exactly the submitted text and attachment records. New typing or
   * uploads made while the request is in flight stay in the same owner draft.
   */
  consume(ownerKey: string | undefined, snapshot: ComposerDraftSnapshot): void {
    if (ownerKey === undefined) return
    const submittedIds = new Set(snapshot.attachmentIds)
    this.#update(ownerKey, (current) => {
      // Revision guards against an ABA edit: typing the same text again after
      // the request starts is still a new draft and must survive completion.
      const sameRevision = current.revision === snapshot.revision
      const text = sameRevision && current.text === snapshot.text
        ? ''
        : current.text
      const attachments = current.attachments.filter((item) => (
        !submittedIds.has(item.id)
        && (item.attachment === undefined || !sameRevision || !submittedIds.has(item.attachment.assetId))
      ))
      return { ...current, text, attachments }
    })
  }

  /** Persist the stable queue key used to own a session's composer draft. */
  setSessionOwnerAlias(worldId: string, sessionId: string, conversationKey: string): void {
    const aliasKey = composerDraftOwnerKey(worldId, sessionId)
    this.#loadAliases()
    if (this.#sessionAliases.get(aliasKey) === conversationKey) return
    this.#sessionAliases.set(aliasKey, conversationKey)
    this.#commitAliases()
  }

  getSessionOwnerAlias(worldId: string, sessionId: string): string | undefined {
    this.#loadAliases()
    return this.#sessionAliases.get(composerDraftOwnerKey(worldId, sessionId))
  }

  /** Clear local compose state. It does not delete sent messages or server assets. */
  clear(ownerKey: string | undefined): void {
    if (ownerKey === undefined) return
    this.#update(ownerKey, (current) => ({
      text: '',
      attachments: [],
      revision: current.revision,
      // Clearing a local draft also clears its temporary model override. Any
      // durable employee/world assignment is owned by the model settings
      // layer and is unaffected.
    }))
  }

  /** Remove all local drafts for a world when its local workspace is discarded. */
  clearWorld(worldId: string): void {
    this.#load()
    this.#loadAliases()
    let changed = false
    for (const ownerKey of this.#drafts.keys()) {
      if (!isOwnerKeyForWorld(ownerKey, worldId)) continue
      this.#drafts.delete(ownerKey)
      changed = true
    }
    for (const aliasKey of this.#sessionAliases.keys()) {
      if (!isOwnerKeyForWorld(aliasKey, worldId)) continue
      this.#sessionAliases.delete(aliasKey)
      changed = true
    }
    if (changed) {
      this.#commit()
      this.#commitAliases()
      this.#notify()
    }
  }

  #update(ownerKey: string, updater: (current: ComposerDraft) => ComposerDraft): void {
    this.#load()
    const current = this.#drafts.get(ownerKey) ?? { text: '', attachments: [], revision: 0 }
    const updated = updater(current)
    if (updated === current) return
    const next: ComposerDraft = {
      ...updated,
      attachments: [...updated.attachments],
      revision: current.revision + 1,
    }
    this.#drafts.set(ownerKey, next)
    this.#commit()
    this.#notify()
  }

  #notify(): void {
    for (const listener of this.#listeners) listener()
  }

  #load(): void {
    if (this.#loaded) return
    this.#loaded = true
    if (typeof window === 'undefined') return
    try {
      const raw = window.sessionStorage.getItem(STORAGE_KEY)
      if (raw === null) return
      const parsed: unknown = JSON.parse(raw)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return
      for (const [ownerKey, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (!isOwnerKey(ownerKey)) continue
        const draft = deserializeDraft(value)
        if (draft !== undefined) this.#drafts.set(ownerKey, draft)
      }
    } catch {
      // sessionStorage may be disabled or contain an invalid previous schema.
    }
  }

  #commit(): void {
    if (typeof window === 'undefined') return
    try {
      const persisted: Record<string, PersistedDraft> = {}
      for (const [ownerKey, draft] of this.#drafts) {
        const serialized = serializeDraft(draft)
        if (serialized !== undefined) persisted[ownerKey] = serialized
      }
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(persisted))
    } catch {
      // The in-memory draft remains usable when storage is unavailable/full.
    }
  }

  #loadAliases(): void {
    if (this.#aliasesLoaded) return
    this.#aliasesLoaded = true
    if (typeof window === 'undefined') return
    try {
      const raw = window.sessionStorage.getItem(SESSION_ALIAS_STORAGE_KEY)
      if (raw === null) return
      const parsed: unknown = JSON.parse(raw)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return
      for (const [aliasKey, conversationKey] of Object.entries(parsed as Record<string, unknown>)) {
        if (isOwnerKey(aliasKey) && typeof conversationKey === 'string' && conversationKey.length > 0) {
          this.#sessionAliases.set(aliasKey, conversationKey)
        }
      }
    } catch {
      // sessionStorage may be disabled or contain an invalid previous schema.
    }
  }

  #commitAliases(): void {
    if (typeof window === 'undefined') return
    try {
      const serialized: Record<string, string> = {}
      for (const [aliasKey, conversationKey] of this.#sessionAliases) serialized[aliasKey] = conversationKey
      window.sessionStorage.setItem(SESSION_ALIAS_STORAGE_KEY, JSON.stringify(serialized))
    } catch {
      // The in-memory alias still keeps the current tab correct.
    }
  }
}

export const composerDraftStore = new ComposerDraftStore()

export function useComposerDraft(ownerKey: string | undefined): ComposerDraft {
  return useSyncExternalStore(
    composerDraftStore.subscribe,
    () => composerDraftStore.get(ownerKey),
    () => EMPTY_DRAFT,
  )
}

interface PersistedDraft {
  text: string
  attachments: Array<{
    id: string
    name: string
    mimeType?: string
    byteLength?: number
    status: 'ready' | 'uploading' | 'interrupted'
    attachment?: ChatAttachment
  }>
  modelProfileId?: string
}

function serializeDraft(draft: ComposerDraft): PersistedDraft | undefined {
  const attachments: PersistedDraft['attachments'] = []
  for (const item of draft.attachments) {
    if (item.status === 'ready' && item.attachment !== undefined && isPersistableAttachment(item.attachment)) {
      attachments.push({
        id: item.id,
        name: item.name,
        ...(item.mimeType === undefined ? {} : { mimeType: item.mimeType }),
        ...(item.byteLength === undefined ? {} : { byteLength: item.byteLength }),
        status: 'ready' as const,
        attachment: item.attachment,
      })
      continue
    }
    // Keep only a small marker for a transfer that cannot survive reload. File
    // blobs themselves never enter sessionStorage; the marker becomes the
    // explicit interrupted state on the next page load.
    if (item.status === 'uploading') {
      attachments.push({
        id: item.id,
        name: item.name,
        ...(item.mimeType === undefined ? {} : { mimeType: item.mimeType }),
        ...(item.byteLength === undefined ? {} : { byteLength: item.byteLength }),
        status: 'uploading' as const,
      })
    }
  }
  const text = draft.text
  if (text.length === 0 && attachments.length === 0 && draft.modelProfileId === undefined) return undefined
  return {
    text,
    attachments,
    ...(draft.modelProfileId === undefined ? {} : { modelProfileId: draft.modelProfileId }),
  }
}

function deserializeDraft(value: unknown): ComposerDraft | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const source = value as Record<string, unknown>
  const text = typeof source.text === 'string' ? source.text : ''
  const modelProfileId = typeof source.modelProfileId === 'string' && source.modelProfileId.trim() !== ''
    ? source.modelProfileId
    : undefined
  const rawAttachments = Array.isArray(source.attachments) ? source.attachments : []
  const attachments = rawAttachments.flatMap((item) => deserializeAttachment(item)).slice(0, MAX_DRAFT_ATTACHMENTS)
  if (text.length === 0 && attachments.length === 0 && modelProfileId === undefined) return undefined
  return {
    text,
    attachments,
    revision: 0,
    ...(modelProfileId === undefined ? {} : { modelProfileId }),
  }
}

function deserializeAttachment(value: unknown): ComposerAttachmentDraft[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return []
  const source = value as Record<string, unknown>
  if (typeof source.id !== 'string' || source.id.length === 0 || typeof source.name !== 'string' || source.name.length === 0) return []
  const status = source.status === 'ready' || source.status === 'uploading' || source.status === 'interrupted'
    ? source.status
    : undefined
  if (status === undefined) return []
  const mimeType = typeof source.mimeType === 'string' ? source.mimeType as LocalAssetMimeType : undefined
  const byteLength = typeof source.byteLength === 'number' && Number.isInteger(source.byteLength) && source.byteLength >= 0 ? source.byteLength : undefined
  if (status === 'ready') {
    const attachment = source.attachment
    if (!isPersistableAttachment(attachment)) return []
    return [{ id: source.id, name: source.name, ...(mimeType === undefined ? {} : { mimeType }), ...(byteLength === undefined ? {} : { byteLength }), status: 'ready', attachment }]
  }
  return [{
    id: source.id,
    name: source.name,
    ...(mimeType === undefined ? {} : { mimeType }),
    ...(byteLength === undefined ? {} : { byteLength }),
    status: 'interrupted',
    error: '页面刷新时上传未完成，请重新选择文件。',
  }]
}

function isPersistableAttachment(value: unknown): value is ChatAttachment {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const source = value as Record<string, unknown>
  return typeof source.assetId === 'string'
    && source.assetId.length > 0
    && typeof source.name === 'string'
    && typeof source.mimeType === 'string'
    && typeof source.byteLength === 'number'
    && Number.isInteger(source.byteLength)
    && source.byteLength >= 0
    && typeof source.url === 'string'
    && source.url.startsWith('/api/')
}

function isOwnerKey(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed)
      && parsed.length === 2
      && typeof parsed[0] === 'string'
      && parsed[0].length > 0
      && typeof parsed[1] === 'string'
      && parsed[1].length > 0
  } catch {
    return false
  }
}

function isOwnerKeyForWorld(ownerKey: string, worldId: string): boolean {
  try {
    const parsed: unknown = JSON.parse(ownerKey)
    return Array.isArray(parsed) && parsed[0] === worldId
  } catch {
    return false
  }
}

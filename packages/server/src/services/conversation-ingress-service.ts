import { createHash } from 'node:crypto'
import type {
  ConversationSubmissionInput,
  ConversationSubmissionReceipt,
  ConversationSubmissionResult,
} from '@dsh-cyber/contracts'

import { HttpError } from '../http/errors.js'

/**
 * Only normalized request identity is used to derive a submission digest.
 * The prompt is represented by `promptHash`; its text remains an ordinary
 * durable owner message, never a field in the claim identity.
 */
export interface ConversationIngressFingerprintInput {
  workspaceId: string
  worldId: string
  clientTurnId: string
  kind: 'direct' | 'group'
  promptHash: string
  employeeIds: readonly string[]
  sessionId?: string
  title?: string
  collaborationMode?: 'discussion' | 'task'
  interactionKind?: 'chat' | 'task' | 'meeting'
  queueMode?: 'normal' | 'next'
  permissionMode?: 'read-only' | 'workspace-write' | 'danger-full-access'
  reasoningEffort?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'auto'
  modelProfileId?: string
  modelProfileIds?: Readonly<Record<string, string>>
  runtimeAccessGrantId?: string
  coordinatorEmployeeId?: string
  attachments?: readonly ConversationIngressAttachment[]
}

export interface ConversationIngressAttachment {
  assetId: string
  name?: string
  mimeType?: string
  byteLength?: number
}

export function conversationPromptHash(prompt: string): string {
  return createHash('sha256').update(prompt, 'utf8').digest('hex')
}

/**
 * Creates the one request digest used by the persistence claim.  Set-like
 * fields and object maps are sorted so equivalent requests cannot conflict
 * merely because the browser serialized them in another order.
 */
export function conversationIngressFingerprint(input: ConversationIngressFingerprintInput): string {
  const sessionId = optionalText(input.sessionId)
  const title = optionalText(input.title)
  const modelProfileId = optionalText(input.modelProfileId)
  const runtimeAccessGrantId = optionalText(input.runtimeAccessGrantId)
  const coordinatorEmployeeId = optionalText(input.coordinatorEmployeeId)
  const normalized = {
    version: 1,
    workspaceId: text(input.workspaceId),
    worldId: text(input.worldId),
    clientTurnId: text(input.clientTurnId),
    kind: input.kind,
    promptHash: text(input.promptHash).toLowerCase(),
    employeeIds: sortedUnique(input.employeeIds),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(title === undefined ? {} : { title }),
    ...(input.collaborationMode === undefined ? {} : { collaborationMode: input.collaborationMode }),
    ...(input.interactionKind === undefined ? {} : { interactionKind: input.interactionKind }),
    ...(input.queueMode === undefined ? {} : { queueMode: input.queueMode }),
    ...(input.permissionMode === undefined ? {} : { permissionMode: input.permissionMode }),
    ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
    ...(modelProfileId === undefined ? {} : { modelProfileId }),
    ...(input.modelProfileIds === undefined ? {} : { modelProfileIds: sortedMap(input.modelProfileIds) }),
    ...(runtimeAccessGrantId === undefined ? {} : { runtimeAccessGrantId }),
    ...(coordinatorEmployeeId === undefined ? {} : { coordinatorEmployeeId }),
    ...(input.attachments === undefined ? {} : {
      attachments: [...input.attachments]
        .map((attachment) => {
          const name = optionalText(attachment.name)
          const mimeType = optionalText(attachment.mimeType)
          return {
            assetId: text(attachment.assetId),
            ...(name === undefined ? {} : { name }),
            ...(mimeType === undefined ? {} : { mimeType }),
            ...(attachment.byteLength === undefined ? {} : { byteLength: attachment.byteLength }),
          }
        })
        .sort((left, right) => stableJson(left).localeCompare(stableJson(right))),
    }),
  }
  return createHash('sha256').update(stableJson(normalized), 'utf8').digest('hex')
}

export function conversationIngressKey(input: Pick<ConversationIngressFingerprintInput, 'workspaceId' | 'worldId' | 'clientTurnId'>): string {
  return stableJson({
    workspaceId: text(input.workspaceId),
    worldId: text(input.worldId),
    clientTurnId: text(input.clientTurnId),
  })
}

/** The minimal persistence surface required by the ingress facade. */
export interface ConversationSubmissionStore {
  claimConversationSubmission(input: ConversationSubmissionInput): ConversationSubmissionResult | Promise<ConversationSubmissionResult>
  getConversationSubmissionClaim(
    workspaceId: string,
    worldId: string,
    idempotencyKey: string,
  ): ConversationSubmissionReceipt | undefined | Promise<ConversationSubmissionReceipt | undefined>
}

export interface ConversationIngressIdentity {
  workspaceId: string
  worldId: string
  clientTurnId: string
  fingerprintSha256: string
}

export interface ConversationIngressPrepared<T> {
  input: ConversationSubmissionInput
  context: T
}

export class ConversationIngressConflictError extends HttpError {
  readonly key: string
  readonly existingFingerprint: string

  constructor(key: string, existingFingerprint: string) {
    super(409, 'client_turn_conflict', '相同 clientTurnId 已对应另一条请求，不能复用')
    this.name = 'ConversationIngressConflictError'
    this.key = key
    this.existingFingerprint = existingFingerprint
  }
}

interface InFlightSubmission {
  fingerprintSha256: string
  promise: Promise<ConversationSubmissionReceipt>
  resolve(receipt: ConversationSubmissionReceipt): void
  reject(error: unknown): void
}

export interface ConversationIngressRunResult<T> {
  value: T
  receipt: ConversationSubmissionReceipt
  replayed: boolean
}

/**
 * Coordinates the two phase owner submission flow:
 *
 * 1. under a per-key mutex, read an existing receipt before planner,
 *    classifier, transform, permission, Skill or runtime work;
 * 2. only when absent, run pure preparation and atomically claim the durable
 *    session/WorkTurn/message/queue through SQLite;
 * 3. if another process wins the CAS, discard this preparation and replay the
 *    winning receipt; otherwise execute the claimed WorkTurn.
 *
 * The mutex is an optimization and a same-process race guard.  SQLite remains
 * the authority for cross-process uniqueness and recovery.
 */
export class ConversationIngressService {
  readonly #store: ConversationSubmissionStore
  readonly #inFlight = new Map<string, InFlightSubmission>()

  constructor(options: { store: ConversationSubmissionStore }) {
    this.#store = options.store
  }

  /** Read only. Routes call this before any expensive preparation. */
  async lookup(identity: ConversationIngressIdentity): Promise<ConversationSubmissionReceipt | undefined> {
    if (optionalText(identity.clientTurnId) === undefined) return undefined
    const receipt = await this.#store.getConversationSubmissionClaim(
      text(identity.workspaceId),
      text(identity.worldId),
      text(identity.clientTurnId),
    )
    if (receipt === undefined) return undefined
    assertReceiptIdentity(receipt, identity)
    return receipt
  }

  /**
   * Runs one accepted submission.  `prepare` must contain only validation,
   * read-only resolution and planning.  It must not create a session/turn or
   * reserve a Skill action; that belongs to `claimConversationSubmission` and
   * the subsequent `execute` callback.
   */
  async run<TContext, TResult>(options: {
    identity: ConversationIngressIdentity
    prepare: () => Promise<ConversationIngressPrepared<TContext>> | ConversationIngressPrepared<TContext>
    execute: (receipt: ConversationSubmissionReceipt, prepared: ConversationIngressPrepared<TContext>) => Promise<TResult> | TResult
    replay: (receipt: ConversationSubmissionReceipt) => Promise<TResult> | TResult
  }): Promise<ConversationIngressRunResult<TResult>> {
    const identity = normalizeIdentity(options.identity)
    const key = conversationIngressKey(identity)

    const existing = this.#inFlight.get(key)
    if (existing !== undefined) {
      if (existing.fingerprintSha256 !== identity.fingerprintSha256) {
        throw new ConversationIngressConflictError(key, existing.fingerprintSha256)
      }
      const receipt = await existing.promise
      return { value: await options.replay(receipt), receipt, replayed: true }
    }

    let resolve!: (receipt: ConversationSubmissionReceipt) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<ConversationSubmissionReceipt>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise
      reject = rejectPromise
    })
    // The first caller awaits its own prepare/execute path rather than this
    // coordination promise. Keep a rejected preparation from becoming an
    // unhandled rejection when no duplicate caller was waiting on the key.
    void promise.catch(() => undefined)
    const pending: InFlightSubmission = {
      fingerprintSha256: identity.fingerprintSha256,
      promise,
      resolve,
      reject,
    }
    this.#inFlight.set(key, pending)

    let claimedReceipt: ConversationSubmissionReceipt | undefined
    try {
      const alreadyClaimed = await this.lookup(identity)
      if (alreadyClaimed !== undefined) {
        pending.resolve(alreadyClaimed)
        this.#inFlight.delete(key)
        return { value: await options.replay(alreadyClaimed), receipt: alreadyClaimed, replayed: true }
      }

      const prepared = await options.prepare()
      assertPreparedIdentity(prepared.input, identity)
      const accepted = await this.#store.claimConversationSubmission(prepared.input)
      assertReceiptIdentity(accepted, identity)
      claimedReceipt = accepted
      if (!accepted.created) {
        pending.resolve(accepted)
        this.#inFlight.delete(key)
        return { value: await options.replay(accepted), receipt: accepted, replayed: true }
      }
      // Keep the key locked through execution.  A same-process retry then
      // waits for the first response and replays complete facts, rather than
      // racing a running direct continuation.
      const value = await options.execute(accepted, prepared)
      pending.resolve(accepted)
      this.#inFlight.delete(key)
      return { value, receipt: accepted, replayed: false }
    } catch (error) {
      if (claimedReceipt !== undefined) {
        // The facts are already durable.  Retrying must replay them even when
        // execution failed after starting a runtime or reserving an action.
        pending.resolve(claimedReceipt)
      } else {
        pending.reject(error)
      }
      this.#inFlight.delete(key)
      throw error
    }
  }
}

function normalizeIdentity(identity: ConversationIngressIdentity): ConversationIngressIdentity {
  const normalized = {
    workspaceId: text(identity.workspaceId),
    worldId: text(identity.worldId),
    clientTurnId: text(identity.clientTurnId),
    fingerprintSha256: text(identity.fingerprintSha256).toLowerCase(),
  }
  if (!normalized.workspaceId || !normalized.worldId || !normalized.clientTurnId) {
    throw new Error('Conversation ingress identity is incomplete')
  }
  if (!/^[0-9a-f]{64}$/.test(normalized.fingerprintSha256)) {
    throw new Error('Conversation ingress fingerprint must be a SHA-256 digest')
  }
  return normalized
}

function assertReceiptIdentity(receipt: ConversationSubmissionReceipt, identity: ConversationIngressIdentity): void {
  if (
    receipt.claim.workspaceId !== text(identity.workspaceId)
    || receipt.claim.worldId !== text(identity.worldId)
    || receipt.claim.idempotencyKey !== text(identity.clientTurnId)
  ) throw new Error('Conversation submission receipt scope does not match request')
  if (receipt.claim.fingerprintSha256 !== text(identity.fingerprintSha256).toLowerCase()) {
    throw new ConversationIngressConflictError(conversationIngressKey(identity), receipt.claim.fingerprintSha256)
  }
}

function assertPreparedIdentity(input: ConversationSubmissionInput, identity: ConversationIngressIdentity): void {
  if (
    input.workspaceId !== identity.workspaceId
    || input.worldId !== identity.worldId
    || input.idempotencyKey !== identity.clientTurnId
    || input.fingerprintSha256 !== identity.fingerprintSha256
  ) throw new Error('Conversation submission preparation identity does not match request')
}


function optionalText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  return normalized === '' ? undefined : normalized
}

function text(value: unknown): string {
  return optionalText(value) ?? ''
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => text(value)).filter(Boolean))].sort()
}

function sortedMap(values: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(values)
    .map(([key, value]) => [text(key), text(value)] as const)
    .filter(([key, value]) => key !== '' && value !== '')
    .sort(([left], [right]) => left.localeCompare(right)))
}

function stableJson(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`
  }
  return 'null'
}

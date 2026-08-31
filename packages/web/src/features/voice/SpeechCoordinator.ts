/**
 * Shared speech ownership for every surface that can play a character reply.
 *
 * A streamed reply may be observed by the focused character panel, the chat
 * composer fallback and a manual message control at the same time.  Playback
 * is a side effect, so choosing an owner in each component independently is
 * inherently racy.  This small registry keeps the decision at the turn
 * boundary and lets the higher-priority surface pre-empt a lower one.
 */

export type SpeechInputSurface = 'composer' | 'focus'
export type SpeechOwner = 'focus-stream' | 'composer-fallback' | 'manual'

export interface VoiceTurnContext {
  clientTurnId: string
  worldId: string
  conversationKey: string
  surface: SpeechInputSurface
}

export interface StreamingSpeechContext {
  source: 'voice'
  surface: SpeechInputSurface
  clientTurnId: string
  worldId: string
  conversationKey: string
}

export interface SpeechClaim {
  readonly key: string
  readonly token: string
  readonly owner: SpeechOwner
  release(): void
  isActive(): boolean
}

interface ActiveClaim extends SpeechClaim {
  readonly priority: number
  readonly onReplaced?: () => void
}

const OWNER_PRIORITY: Record<SpeechOwner, number> = {
  'focus-stream': 100,
  'composer-fallback': 50,
  manual: 20,
}

const activeClaims = new Map<string, ActiveClaim>()
const voiceTurns = new Map<string, VoiceTurnContext>()
let claimSequence = 0

/** Register the origin of a turn before the request can emit runtime events. */
export function registerVoiceTurn(context: VoiceTurnContext): void {
  voiceTurns.set(context.clientTurnId, context)
  // A turn that never reaches a terminal event must not grow this process-wide
  // map forever.  Keep the most recent registrations; normal completion calls
  // forgetVoiceTurn explicitly below.
  while (voiceTurns.size > 512) {
    const oldest = voiceTurns.keys().next().value
    if (typeof oldest !== 'string') break
    voiceTurns.delete(oldest)
  }
}

export function speechContextForTurn(clientTurnId: string): StreamingSpeechContext | undefined {
  const context = voiceTurns.get(clientTurnId)
  if (context === undefined) return undefined
  return {
    source: 'voice',
    surface: context.surface,
    clientTurnId: context.clientTurnId,
    worldId: context.worldId,
    conversationKey: context.conversationKey,
  }
}

export function forgetVoiceTurn(clientTurnId: string): void {
  voiceTurns.delete(clientTurnId)
}

/**
 * Claim one employee/turn pair.  A lower-priority claim is refused; a
 * higher-priority claim replaces the old one and gets a chance to stop its
 * playback.  Releasing is token-checked so a late completion from an old
 * component cannot release a newer owner's claim.
 */
export function claimSpeech(input: {
  employeeId: string
  turnId: string
  owner: SpeechOwner
  priority?: number
  onReplaced?: () => void
}): SpeechClaim | undefined {
  const key = speechKey(input.employeeId, input.turnId)
  const priority = input.priority ?? OWNER_PRIORITY[input.owner]
  const existing = activeClaims.get(key)
  if (existing !== undefined) {
    if (priority <= existing.priority) return undefined
    activeClaims.delete(key)
    existing.onReplaced?.()
  }

  const token = `speech-${++claimSequence}`
  let active = true
  const claim: ActiveClaim = {
    key,
    token,
    owner: input.owner,
    priority,
    ...(input.onReplaced === undefined ? {} : { onReplaced: input.onReplaced }),
    release: () => {
      if (!active) return
      active = false
      if (activeClaims.get(key)?.token === token) activeClaims.delete(key)
    },
    isActive: () => active && activeClaims.get(key)?.token === token,
  }
  activeClaims.set(key, claim)
  return claim
}

export function activeSpeechOwner(employeeId: string, turnId: string): SpeechOwner | undefined {
  return activeClaims.get(speechKey(employeeId, turnId))?.owner
}

export function releaseSpeechForEmployee(employeeId: string): void {
  for (const [key, claim] of activeClaims) {
    if (!key.startsWith(`${employeeId}\u0000`)) continue
    claim.release()
  }
}

/** Test isolation hook; production code should release its own claims. */
export function resetSpeechCoordinatorForTest(): void {
  activeClaims.clear()
  voiceTurns.clear()
  claimSequence = 0
}

function speechKey(employeeId: string, turnId: string): string {
  return `${employeeId}\u0000${turnId}`
}

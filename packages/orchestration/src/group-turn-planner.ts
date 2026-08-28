/**
 * Who speaks in a group turn, and in what order.
 *
 * Before this existed, a group turn was "every participant, in the order the
 * client happened to send them, one after another". That made participation a
 * property of the membership list rather than of the request, and it made the
 * wall clock the sum of every member's model latency.
 *
 * A plan separates the two questions. `waves` is the ordering contract: the
 * speakers inside one wave are independent and run concurrently, and a later
 * wave sees what the earlier ones said. One wave of everybody is the fast
 * discussion; a wave per speaker is the old sequential round; a small wave
 * followed by a single synthesiser is the shape a router usually wants.
 */

export type GroupTurnPlanSource = 'heuristic' | 'model' | 'explicit'

export interface GroupTurnPlanSpeaker {
  employeeId: string
  /**
   * What this character is being asked to cover, in the planner's words.
   *
   * Advisory: it is appended to the character's prompt, never used to select
   * skills or permissions. A brief cannot widen what a character may do.
   */
  brief?: string
}

export interface GroupTurnWave {
  speakers: GroupTurnPlanSpeaker[]
}

export interface GroupTurnPlan {
  waves: GroupTurnWave[]
  source: GroupTurnPlanSource
  /** Shown in the trace so a surprising roster is explainable after the fact. */
  rationale?: string
}

export interface GroupTurnCandidate {
  employeeId: string
  displayName: string
  role?: string
  /** Skill ids the character currently holds. */
  skillIds?: readonly string[]
  /** Active AgentRuns. A loaded character is the worse pick when tied. */
  activeLoad?: number
}

export interface GroupTurnPlanInput {
  workspaceId: string
  worldId: string
  sessionId: string
  prompt: string
  candidates: readonly GroupTurnCandidate[]
  collaborationMode?: 'discussion' | 'task'
}

export interface GroupTurnPlannerPort {
  plan(input: GroupTurnPlanInput): Promise<GroupTurnPlan>
}

/**
 * Total speaking slots an authored plan may ask for.
 *
 * A planner is allowed to let a character speak in more than one wave (opine,
 * then synthesise), but a turn still has to terminate and stay affordable, so
 * the total is capped rather than the per-character count. This bounds
 * *authored* plans, which may come from a model; it is not applied to the
 * room's own membership, where dropping a member would silence somebody the
 * user put in the conversation.
 */
const MAX_SPEAKING_SLOTS = 8
const MAX_WAVES = 3
const MAX_BRIEF_CHARS = 240

/**
 * Speakers started at once when the whole room has the floor.
 *
 * Concurrency still has to be bounded — a thirty-character room would open
 * thirty runtimes — but the bound belongs on how many run together, not on how
 * many are heard. A larger room becomes more waves, not a shorter guest list.
 */
const MAX_CONCURRENT_SPEAKERS = 6

/**
 * Makes any plan safe to execute.
 *
 * A plan may come from a model, so it is untrusted input: it can name
 * characters that are not in the room, repeat one character inside a single
 * wave, or be empty. Rather than rejecting — which would fail a turn the user
 * has already paid for — every violation is repaired, and a plan that repairs
 * to nothing falls back to one concurrent wave of everyone.
 */
export function normalizeGroupTurnPlan(
  plan: GroupTurnPlan,
  candidates: readonly GroupTurnCandidate[],
): GroupTurnPlan {
  const known = new Map(candidates.map((candidate) => [candidate.employeeId, candidate]))
  const waves: GroupTurnWave[] = []
  let slots = 0
  for (const wave of plan.waves.slice(0, MAX_WAVES)) {
    const speakers: GroupTurnPlanSpeaker[] = []
    const seenInWave = new Set<string>()
    for (const speaker of wave.speakers) {
      if (slots >= MAX_SPEAKING_SLOTS) break
      if (!known.has(speaker.employeeId)) continue
      // One AgentRun per character per wave. Two concurrent runs of the same
      // character would contend for its single runtime lane and serialise the
      // wave anyway, so the duplicate buys latency and no extra opinion.
      if (seenInWave.has(speaker.employeeId)) continue
      seenInWave.add(speaker.employeeId)
      const brief = speaker.brief?.replaceAll(/\s+/g, ' ').trim()
      speakers.push({
        employeeId: speaker.employeeId,
        ...(brief === undefined || brief === '' ? {} : { brief: brief.slice(0, MAX_BRIEF_CHARS) }),
      })
      slots += 1
    }
    if (speakers.length > 0) waves.push({ speakers })
  }
  if (waves.length === 0) return everyoneAtOnce(candidates, plan.source, plan.rationale)
  return {
    waves,
    source: plan.source,
    ...(plan.rationale === undefined ? {} : { rationale: plan.rationale }),
  }
}

function everyoneAtOnce(
  candidates: readonly GroupTurnCandidate[],
  source: GroupTurnPlanSource,
  rationale?: string,
): GroupTurnPlan {
  const waves: GroupTurnWave[] = []
  for (let index = 0; index < candidates.length; index += MAX_CONCURRENT_SPEAKERS) {
    waves.push({
      speakers: candidates.slice(index, index + MAX_CONCURRENT_SPEAKERS)
        .map((candidate) => ({ employeeId: candidate.employeeId })),
    })
  }
  return {
    waves: waves.length === 0 ? [{ speakers: [] }] : waves,
    source,
    ...(rationale === undefined ? {} : { rationale }),
  }
}

/**
 * The default planner. Deterministic, and costs no model call.
 *
 * It answers only the question it can answer from the text itself: an explicit
 * `@` addresses a subset, and everything else is for the whole room. Deciding
 * that a request needs a researcher before a reviewer is a judgement about
 * meaning, which is what {@link GroupTurnPlannerPort} implementations backed by
 * a model are for.
 */
export class HeuristicGroupTurnPlanner implements GroupTurnPlannerPort {
  async plan(input: GroupTurnPlanInput): Promise<GroupTurnPlan> {
    // Both rosters are built from `candidates` themselves, so they cannot name
    // an unknown character and do not need the authored-plan slot cap — which
    // would silently drop members of a large room.
    const addressed = mentionedCandidates(input.prompt, input.candidates)
    if (addressed.length > 0) {
      return everyoneAtOnce(addressed, 'heuristic', `点名了 ${addressed.map((candidate) => candidate.displayName).join('、')}`)
    }
    return everyoneAtOnce(input.candidates, 'heuristic', '未点名，全体并发发言')
  }
}

/**
 * Characters named with `@` in the prompt, in the order they were addressed.
 *
 * Matching is on the display name because that is what the composer types. A
 * name that is a prefix of another ("小刘" inside "小刘明") would otherwise
 * pull in a character the user did not address, so the longest display name
 * wins at any given position.
 */
export function mentionedCandidates(
  prompt: string,
  candidates: readonly GroupTurnCandidate[],
): GroupTurnCandidate[] {
  const byLongestName = [...candidates].sort((left, right) => right.displayName.length - left.displayName.length)
  const found: Array<{ candidate: GroupTurnCandidate; index: number }> = []
  const claimed: Array<[number, number]> = []
  for (const candidate of byLongestName) {
    const token = `@${candidate.displayName}`
    let from = 0
    for (;;) {
      const index = prompt.indexOf(token, from)
      if (index < 0) break
      const overlaps = claimed.some(([start, end]) => index < end && start < index + token.length)
      if (!overlaps) {
        claimed.push([index, index + token.length])
        found.push({ candidate, index })
        break
      }
      from = index + 1
    }
  }
  return found.sort((left, right) => left.index - right.index).map((item) => item.candidate)
}

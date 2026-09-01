import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import type {
  AgentRuntimePort,
  AgentTurnRequest,
  ConversationHistoryEntry,
  EmployeeBlueprint,
  WorkSession,
} from '@dsh-cyber/contracts'
import { estimateTextTokens, planContextBudget } from '@dsh-cyber/contracts'
import { SqliteStore } from '@dsh-cyber/persistence'

import { CharacterProfileRuntime } from '../src/services/character-profile-runtime.js'
import { ConversationContextComposer } from '../src/services/conversation-context-composer.js'
import {
  EmployeeConversationMemoryService,
  MEMORY_SOURCE_HEADING,
} from '../src/services/employee-conversation-memory-service.js'

/**
 * The Magic Context acceptance scenario, end to end and offline.
 *
 * Three conversations:
 *
 *   A — the owner tells the employee a project codename, an architecture
 *       decision, a writing preference and a key date.
 *   B — a large amount of unrelated chatter, enough that A falls out of the
 *       bounded raw window.
 *   C — the owner asks about one of A's facts.
 *
 * The claim under test is not "the model answered". It is that the answer
 * arrived through Memory Index -> memoryId -> raw source message -> injection,
 * *while* conversation A was not replayed wholesale. Both halves are asserted,
 * and the second half is asserted against what actually reached the runtime,
 * not against what the composer reports about itself.
 *
 * Nothing here calls a cloud model. `LabelledFactRuntime` below is a
 * deterministic reader: it answers a `<label>是多少？` question if and only if
 * the labelled identifier is literally present in the prompt or the replayed
 * history it was handed. Accuracy is therefore a real measurement of whether
 * the fact reached the runtime, and it is reproducible in CI.
 */

const stores: SqliteStore[] = []

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

/** The turn budget a 64k-window model would get. Used by every arm alike. */
const TURN_BUDGET = planContextBudget({ contextWindow: 65_536 })

const UNKNOWN_ANSWER = '我不记得了。'

/**
 * A model-free reader.
 *
 * It resolves `X是多少？` by looking for `X <IDENTIFIER>` anywhere in the text
 * it was actually given. It knows no facts of its own and cannot reach the
 * store, so a correct answer is proof that the fact was injected into this
 * turn's context — and a wrong answer is proof that it was not.
 */
class LabelledFactRuntime implements AgentRuntimePort {
  readonly requests: AgentTurnRequest[] = []

  async runTurn(request: AgentTurnRequest) {
    this.requests.push(request)
    const visible = reachedRuntime(request)
    const label = /(\p{Script=Han}{2,12})是多少/u.exec(request.prompt)?.[1]
    const answer = label === undefined
      ? UNKNOWN_ANSWER
      : new RegExp(`${label}\\s*([A-Z][A-Z0-9-]{3,})`).exec(visible)?.[1] ?? UNKNOWN_ANSWER
    return { agentSessionId: 'agent-session', finalResponse: answer, eventCount: 0 }
  }

  async close(): Promise<void> {}
}

/** Everything the runtime was actually handed this turn, as one string. */
function reachedRuntime(request: AgentTurnRequest): string {
  return [request.prompt, ...(request.history ?? []).map((entry) => entry.content)].join('\n')
}

function blueprint(): EmployeeBlueprint {
  return {
    schemaVersion: 1,
    id: 'magic.context.worker',
    version: 1,
    worldTemplateId: 'personal-world',
    displayName: '小林',
    role: '内容员工',
    summary: '负责 Magic Context 验收场景',
    persona: '你只引用自己真实参与过的经历。',
    requestedSkills: [],
    requestedCapabilities: [],
    createdAt: '2026-08-28T00:00:00.000Z',
  }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-magic-context-'))
  const store = await SqliteStore.open(join(root, 'cyber.sqlite'))
  stores.push(store)
  const workspace = store.createWorkspace({ name: '本地工作区' })
  const world = store.createWorld({ workspaceId: workspace.id, name: '上下文世界', templateId: 'personal-world' })
  store.saveBlueprint(blueprint())
  const employee = store.recruitEmployee({
    workspaceId: workspace.id,
    worldId: world.id,
    blueprintId: 'magic.context.worker',
    blueprintVersion: 1,
  })
  const memory = new EmployeeConversationMemoryService(store)
  const composer = new ConversationContextComposer(store, memory)
  return { store, workspace, world, employee, memory, composer }
}

type Fixture = Awaited<ReturnType<typeof setup>>

function directSession(fixture: Fixture, title: string): WorkSession {
  return fixture.store.createSession({
    workspaceId: fixture.workspace.id,
    worldId: fixture.world.id,
    kind: 'direct',
    title,
    participants: [
      { participantId: 'owner', kind: 'owner' },
      { participantId: fixture.employee.id, kind: 'employee' },
    ],
  })
}

let runSequence = 0

/** One completed exchange, remembered exactly the way the live runtime remembers it. */
async function exchange(
  fixture: Fixture,
  session: WorkSession,
  ask: string,
  answer: string,
): Promise<void> {
  runSequence += 1
  const runId = `run-${runSequence}`
  const turn = fixture.store.createWorkTurn({
    workspaceId: fixture.workspace.id,
    worldId: fixture.world.id,
    sessionId: session.id,
    interactionKind: 'chat',
  })
  fixture.store.appendMessage({
    sessionId: session.id,
    senderId: 'owner',
    senderKind: 'owner',
    kind: 'user',
    content: ask,
    metadata: { workTurnId: turn.id },
  })
  fixture.store.appendMessage({
    sessionId: session.id,
    senderId: fixture.employee.id,
    senderKind: 'employee',
    kind: 'assistant',
    content: answer,
    metadata: { workTurnId: turn.id, agentRunId: runId },
  })
  await fixture.memory.rememberCompletedRun({
    employeeId: fixture.employee.id,
    sessionId: session.id,
    workTurnId: turn.id,
    agentRunId: runId,
  })
}

function history(fixture: Fixture, sessionId: string): ConversationHistoryEntry[] {
  return fixture.store
    .listMessages(sessionId)
    .filter((message) => message.kind === 'user' || message.kind === 'assistant')
    .map((message) => ({
      role: message.kind === 'user' ? 'user' as const : 'assistant' as const,
      sequence: message.sequence,
      speakerId: message.senderId,
      speakerName: message.senderKind === 'owner' ? '用户' : fixture.employee.displayName,
      content: message.content,
      createdAt: message.createdAt,
    }))
}

/**
 * The codename is deliberately buried past the 700-character rendering of the
 * memory summary, so the retrieved-summary layer alone can never answer for it.
 * Only hydration — relocating the raw source message behind the memoryId — can.
 */
const CODENAME_FILLER = '我们逐条确认了评审结论并记录在案。'.repeat(48)

/** The four things conversation A establishes, and the question each one answers. */
const FACTS = [
  {
    ask: '把新项目的代号校验串记下来',
    answer: `${CODENAME_FILLER}代号校验串 CODENAME-SILVERSTURGEON-7731。`,
    question: '代号校验串是多少？',
    expected: 'CODENAME-SILVERSTURGEON-7731',
    /** Recoverable only through hydration; the rendered summary truncates first. */
    hydrationOnly: true,
  },
  {
    ask: '把架构决策编号记下来',
    answer: '架构决策：事件溯源加读写分离。架构决策编号 ADR-0421。',
    question: '架构决策编号是多少？',
    expected: 'ADR-0421',
    hydrationOnly: false,
  },
  {
    ask: '把写作偏好编号记下来',
    answer: '写作偏好：先给结论再给理由。写作偏好编号 PREF-CONCLUSION-FIRST。',
    question: '写作偏好编号是多少？',
    expected: 'PREF-CONCLUSION-FIRST',
    hydrationOnly: false,
  },
  {
    ask: '把上线窗口编号记下来',
    answer: '上线窗口定在十一月七日。上线窗口编号 GATE-20261107。',
    question: '上线窗口编号是多少？',
    expected: 'GATE-20261107',
    hydrationOnly: false,
  },
] as const

const CHATTER_TURNS = 30

/**
 * Two shapes of conversation B, because they do not benchmark the same way.
 *
 * `terse` is a stream of one-line turns; `typical` is the length a real working
 * chat turn actually runs to. The composer's trade — drop N old turns, pay for
 * a retrieved and hydrated memory block — only pays off when the dropped turns
 * were worth more than the block. `terse` is the regime where it does not.
 */
const CHATTER_PROFILES = {
  terse: '',
  typical: '今天通勤路上有点堵，地铁里人不少，午饭大概会晚一点。楼下那家面馆据说换了厨师，评价还行。周末想去看场电影，你有推荐吗，最好是轻松一点的。'.repeat(2),
} as const

type ChatterProfile = keyof typeof CHATTER_PROFILES

async function conversationA(fixture: Fixture, session: WorkSession): Promise<void> {
  for (const fact of FACTS) await exchange(fixture, session, fact.ask, fact.answer)
}

/** Conversation B: unrelated, and lexically disjoint from every question A answers. */
async function conversationB(
  fixture: Fixture,
  session: WorkSession,
  profile: ChatterProfile = 'typical',
): Promise<void> {
  const filler = CHATTER_PROFILES[profile]
  for (let index = 1; index <= CHATTER_TURNS; index += 1) {
    await exchange(
      fixture,
      session,
      `闲聊 ${index}：午饭想吃什么，天气怎么样？${filler}`,
      `闲聊 ${index}：随便都行，外面在下雨。${filler}`,
    )
  }
}

async function runTurn(
  fixture: Fixture,
  session: WorkSession,
  prompt: string,
): Promise<{ answer: string; request: AgentTurnRequest }> {
  const inner = new LabelledFactRuntime()
  const runtime = new CharacterProfileRuntime(inner, fixture.store)
  const result = await runtime.runTurn({
    agent: fixture.employee,
    revision: fixture.store.getEmployeeRevision(fixture.employee.id, fixture.employee.currentRevision)!,
    conversationId: session.id,
    history: history(fixture, session.id),
    observedThroughSequence: 0,
    prompt,
    workspacePath: '/tmp/world',
    contextBudget: TURN_BUDGET,
  })
  return { answer: result.finalResponse, request: inner.requests[0]! }
}

describe('Magic Context acceptance · A establishes, B buries, C recalls', () => {
  it('answers an early fact from A without replaying A, going through the memory index instead', async () => {
    const fixture = await setup()
    const session = directSession(fixture, '私聊')
    await conversationA(fixture, session)
    await conversationB(fixture, session)
    const entries = history(fixture, session.id)

    const codename = FACTS[0]
    const { answer, request } = await runTurn(fixture, session, codename.question)

    // Half one: the answer is right.
    expect(answer).toContain(codename.expected)

    // Half two: A was not replayed. Asserted on what reached the runtime.
    const replayed = request.history ?? []
    expect(replayed.length).toBeLessThan(entries.length)
    // Every one of conversation A's eight durable messages is gone from the replay.
    const aSequences = new Set(entries.slice(0, FACTS.length * 2).map((entry) => entry.sequence))
    expect(replayed.some((entry) => aSequences.has(entry.sequence))).toBe(false)
    // And the replay is still a contiguous suffix, not a spliced-together digest.
    expect(replayed).toEqual(entries.slice(entries.length - replayed.length))

    // Half three: the route. Index -> memoryId -> raw source -> injection.
    const milestone = fixture.store
      .getEmployeeDossier(fixture.employee.id)
      .milestones.find((entry) => entry.summary.includes(codename.ask))!
    expect(request.prompt).toContain('[记忆索引]')
    expect(request.prompt).toContain(milestone.id)
    expect(request.prompt).toContain(MEMORY_SOURCE_HEADING)
    const [beforeSources, hydrated = ''] = request.prompt.split(MEMORY_SOURCE_HEADING)
    // The rendered summary truncates before the codename: without hydrating the
    // raw source message behind that memoryId there is nothing to answer with.
    expect(beforeSources).not.toContain(codename.expected)
    expect(hydrated).toContain(codename.expected)
    // The codename never came from replayed history either.
    expect(replayed.some((entry) => entry.content.includes(codename.expected))).toBe(false)
  })

  it('recalls every fact A established, not only the one the window happened to keep', async () => {
    const fixture = await setup()
    const session = directSession(fixture, '私聊')
    await conversationA(fixture, session)
    await conversationB(fixture, session)

    for (const fact of FACTS) {
      const { answer, request } = await runTurn(fixture, session, fact.question)
      expect(answer, `${fact.question} -> ${answer}`).toContain(fact.expected)
      // Never from replayed history: every one of these is out of the raw window.
      expect((request.history ?? []).some((entry) => entry.content.includes(fact.expected))).toBe(false)
      if (fact.hydrationOnly) {
        expect(request.prompt.split(MEMORY_SOURCE_HEADING)[0]).not.toContain(fact.expected)
      }
    }
  })

  it('recalls across conversations: A, B and C are three separate sessions', async () => {
    const fixture = await setup()
    const a = directSession(fixture, '会话 A')
    const b = directSession(fixture, '会话 B')
    const c = directSession(fixture, '会话 C')
    await conversationA(fixture, a)
    await conversationB(fixture, b)

    const codename = FACTS[0]
    const { answer, request } = await runTurn(fixture, c, codename.question)

    expect(answer).toContain(codename.expected)
    // C has no history of its own, so nothing was replayed from anywhere.
    expect(request.history ?? []).toHaveLength(0)
    // One episode's raw source came back, not two conversations' worth of it.
    const replayTokens = [...history(fixture, a.id), ...history(fixture, b.id)]
      .reduce((total, entry) => total + estimateTextTokens(entry.content), 0)
    expect(estimateTextTokens(request.prompt)).toBeLessThan(replayTokens * 0.5)
    // Conversation B is unrelated and never surfaces at all.
    expect(reachedRuntime(request)).not.toContain('闲聊')
  })

  it('still refuses to reach a private memory from a group conversation', async () => {
    const fixture = await setup()
    const direct = directSession(fixture, '私聊')
    await conversationA(fixture, direct)
    await conversationB(fixture, direct)
    const group = fixture.store.createSession({
      workspaceId: fixture.workspace.id,
      worldId: fixture.world.id,
      kind: 'group',
      title: '群聊',
      participants: [
        { participantId: 'owner', kind: 'owner' },
        { participantId: fixture.employee.id, kind: 'employee' },
      ],
    })
    await exchange(fixture, group, '这周的排期是什么', '这周先做迁移评审。')

    const codename = FACTS[0]
    const { answer, request } = await runTurn(fixture, group, codename.question)

    expect(reachedRuntime(request)).not.toContain(codename.expected)
    expect(answer).toBe(UNKNOWN_ANSWER)
  })
})

/**
 * Before/after, measured on this base.
 *
 * "Before" is the path this branch replaced: the whole durable conversation
 * replayed raw in front of the same request, with no memory layers. "After" is
 * the composer path, measured on what the runtime was actually handed.
 *
 * Latency is *not* asserted. The runtime here is a stub, so wall-clock time of
 * a turn is meaningless; the only timing that means anything in CI is how long
 * composition itself takes, and even that is reported rather than gated,
 * because a shared CI box is not a benchmark machine. End-to-end latency
 * against a real model needs a manual run and is deliberately out of scope.
 *
 * `cachedPrefixTokens` and `snapshotPointerTokens` are declared and left null
 * on purpose: the stable-prefix cache (D2.5) and the context snapshot (D4) are
 * not on this base, and inventing numbers for them would be worse than an
 * honest hole. When they land, fill these two fields in — nothing else here
 * needs to change.
 */
interface ContextArmMeasurement {
  arm: 'full-replay' | 'composer'
  answer: string
  correct: boolean
  promptTokens: number
  recentHistoryTokens: number
  retrievedMemoryTokens: number
  totalInputTokens: number
  replayedEntries: number
  /** Filled in by D2.5's stable-prefix cache. Not measurable on this base. */
  cachedPrefixTokens: number | null
  /** Filled in by D4's context snapshot. Not measurable on this base. */
  snapshotPointerTokens: number | null
  compositionMs: number | null
}

interface ScenarioBenchmark {
  scenario: string
  chatterProfile: ChatterProfile
  durableEntries: number
  before: ContextArmMeasurement
  after: ContextArmMeasurement
  inputTokenRatio: number
  replayedEntryRatio: number
  coverage: unknown
}

async function benchmarkScenario(profile: ChatterProfile): Promise<ScenarioBenchmark> {
  const fixture = await setup()
  const session = directSession(fixture, '私聊')
  await conversationA(fixture, session)
  await conversationB(fixture, session, profile)
  const entries = history(fixture, session.id)
  const codename = FACTS[0]

  // Before: the whole conversation replayed raw, no memory layers at all.
  const replayRuntime = new LabelledFactRuntime()
  const replayResult = await replayRuntime.runTurn({
    agent: fixture.employee,
    revision: fixture.store.getEmployeeRevision(fixture.employee.id, fixture.employee.currentRevision)!,
    conversationId: session.id,
    history: [...entries],
    observedThroughSequence: 0,
    prompt: codename.question,
    workspacePath: '/tmp/world',
    contextBudget: TURN_BUDGET,
  })
  const replayHistoryTokens = entries.reduce((total, entry) => total + estimateTextTokens(entry.content), 0)
  const replayPromptTokens = estimateTextTokens(codename.question)
  const before: ContextArmMeasurement = {
    arm: 'full-replay',
    answer: replayResult.finalResponse,
    correct: replayResult.finalResponse.includes(codename.expected),
    promptTokens: replayPromptTokens,
    recentHistoryTokens: replayHistoryTokens,
    retrievedMemoryTokens: 0,
    totalInputTokens: replayPromptTokens + replayHistoryTokens,
    replayedEntries: entries.length,
    cachedPrefixTokens: null,
    snapshotPointerTokens: null,
    compositionMs: null,
  }

  // After: the composer path. The layer split comes from the envelope; the
  // token totals come from the request the runtime was actually handed.
  const startedAt = performance.now()
  const composed = await fixture.composer.compose({
    employee: fixture.employee,
    persona: '你只引用自己真实参与过的经历。',
    conversationId: session.id,
    prompt: codename.question,
    history: entries,
    observedThroughSequence: 0,
    memoryBudgetTokens: TURN_BUDGET.memoryTokens,
  })
  const compositionMs = performance.now() - startedAt
  const { answer, request } = await runTurn(fixture, session, codename.question)
  const composedHistoryTokens = (request.history ?? [])
    .reduce((total, entry) => total + estimateTextTokens(entry.content), 0)
  const composedPromptTokens = estimateTextTokens(request.prompt)
  const after: ContextArmMeasurement = {
    arm: 'composer',
    answer,
    correct: answer.includes(codename.expected),
    promptTokens: composedPromptTokens,
    recentHistoryTokens: composedHistoryTokens,
    retrievedMemoryTokens: (composed.envelope.memoryIndex?.tokenEstimate ?? 0)
      + (composed.envelope.retrievedMemories?.tokenEstimate ?? 0),
    totalInputTokens: composedPromptTokens + composedHistoryTokens,
    replayedEntries: (request.history ?? []).length,
    cachedPrefixTokens: null,
    snapshotPointerTokens: null,
    compositionMs,
  }

  return {
    scenario: 'magic-context-a-b-c',
    chatterProfile: profile,
    durableEntries: entries.length,
    before,
    after,
    inputTokenRatio: after.totalInputTokens / before.totalInputTokens,
    replayedEntryRatio: after.replayedEntries / before.replayedEntries,
    coverage: composed.coverage,
  }
}

describe('Magic Context benchmark · composer versus full replay', () => {
  it('matches full replay on accuracy for a fraction of the input tokens', async () => {
    const typical = await benchmarkScenario('typical')
    const terse = await benchmarkScenario('terse')
    // A benchmark nobody can read is not a benchmark. One machine-readable line.
    console.log(`magic-context-benchmark ${JSON.stringify({
      arms: [typical, terse],
      notMeasurableOnThisBase: [
        'cachedPrefixTokens — needs D2.5 stable-prefix cache',
        'snapshotPointerTokens — needs D4 context snapshot',
        'end-to-end model latency — needs a manual run against a real provider',
      ],
    })}`)

    // Accuracy must not regress in either regime: that is the whole point of the trade.
    for (const arm of [typical, terse]) {
      expect(arm.before.correct, `${arm.chatterProfile} before`).toBe(true)
      expect(arm.after.correct, `${arm.chatterProfile} after`).toBe(true)
      expect(arm.after.replayedEntries).toBeLessThan(arm.before.replayedEntries)
      expect((arm.coverage as { rawWindowApplied: boolean }).rawWindowApplied).toBe(true)
      expect((arm.coverage as { fullReplayFallback: boolean }).fullReplayFallback).toBe(false)
      expect((arm.coverage as { hydratedSourceMessageCount: number }).hydratedSourceMessageCount)
        .toBeGreaterThan(0)
    }

    // On a conversation of ordinary working length the trade pays for itself.
    expect(typical.inputTokenRatio).toBeLessThan(0.5)

    // And on a conversation of one-line turns it does not, which is the honest
    // shape of this design rather than a defect: retrieval plus hydration costs
    // a roughly fixed block, so it only wins once the history it replaces is
    // worth more than that block. Asserted so the crossover cannot quietly
    // disappear from the record.
    expect(terse.inputTokenRatio).toBeGreaterThan(typical.inputTokenRatio)
  })
})

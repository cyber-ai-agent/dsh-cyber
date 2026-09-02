import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import type {
  AgentRuntimePort,
  AgentTurnRequest,
  ConversationHistoryEntry,
  EmployeeBlueprint,
  EmployeeInstance,
  WorkSession,
} from '@dsh-cyber/contracts'
import { CONTEXT_LAYER_ORDER } from '@dsh-cyber/contracts'
import { SqliteStore } from '@dsh-cyber/persistence'

import { CharacterProfileRuntime } from '../src/services/character-profile-runtime.js'
import { WorldRootService } from '../src/services/world-root-service.js'
import { WorldRuntimeContextComposer } from '../src/services/world-runtime-context-composer.js'
import { WorldSettingsService } from '../src/services/world-settings-service.js'

/**
 * D2.5 follow-up: the world's stable rules sit in the cacheable prefix.
 *
 * Before this slice the rules were the last thing in the prompt - inside the
 * per-turn request, behind the volatile retrieved memories - and were never
 * part of the hashed prefix. These tests pin the reordering from the only
 * vantage point that matters: what the inner runtime is actually handed.
 */

const stores: SqliteStore[] = []

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

class CaptureRuntime implements AgentRuntimePort {
  readonly requests: AgentTurnRequest[] = []

  async runTurn(request: AgentTurnRequest) {
    this.requests.push(request)
    return { agentSessionId: 'agent-session', finalResponse: '好的。', eventCount: 0 }
  }

  async close(): Promise<void> {}
}

/** Long enough that the prefix is actually cacheable. */
const PERSONA = [
  '你是长期驻留在本世界的内容员工，只引用自己真实参与过的经历。',
  '回答使用简洁中文，先给结论再给依据；不确定时直接说明不确定，不编造来源。',
  '未获授权的世界数据一律不读取，也不推断其内容或替用户猜测。',
  '每一轮都保持同一身份，不冒充其他角色，也不恢复创建时的旧模板身份。',
].join('\n')

const LORE = '雨夜学院：每一条结论都要附上可核对的出处，没有出处的说法标为待核实。'
const SCENARIO = '期末周，学员们在图书馆通宵备考。'

/** Every rule line the world header renders for this world. */
const WORLD_RULES = [
  '[当前世界设定]',
  `世界观：${LORE}`,
  `当前场景：${SCENARIO}`,
  '用户在这个世界中的身份：洛（院长），请称呼用户为“院长”。',
  '当前世界与其他世界的数据、文件、记忆相互隔离。',
  '最终回复、可展示的判断摘要、计划和工具使用说明统一使用简体中文',
]

function blueprint(): EmployeeBlueprint {
  return {
    schemaVersion: 1,
    id: 'prefix.worker',
    version: 1,
    worldTemplateId: 'personal-world',
    displayName: '小林',
    role: '内容员工',
    summary: '负责测试世界规则进入缓存前缀',
    persona: PERSONA,
    requestedSkills: [],
    requestedCapabilities: [],
    createdAt: '2026-08-28T00:00:00.000Z',
  }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-world-context-prefix-'))
  const store = await SqliteStore.open(join(root, 'cyber.sqlite'))
  stores.push(store)
  const workspace = store.createWorkspace({ name: '本地工作区' })
  const world = store.createWorld({ workspaceId: workspace.id, name: '雨夜学院', templateId: 'personal-world' })
  store.saveBlueprint(blueprint())
  const employee = store.recruitEmployee({
    workspaceId: workspace.id,
    worldId: world.id,
    blueprintId: 'prefix.worker',
    blueprintVersion: 1,
  })
  const settings = new WorldSettingsService(new WorldRootService(join(root, 'worlds')))
  await settings.save(world.id, {
    lore: LORE,
    scenario: SCENARIO,
    userIdentity: { displayName: '洛', worldRole: '院长', addressAs: '院长' },
  })
  const inner = new CaptureRuntime()
  const runtime = new CharacterProfileRuntime(inner, store, undefined, undefined, undefined, undefined, undefined, settings)
  // The request is composed the way every entry point composes it.
  const requests = new WorldRuntimeContextComposer({ contributors: [] })
  return { store, workspace, world, employee, settings, inner, runtime, requests }
}

function session(store: SqliteStore, world: { id: string; workspaceId: string }, employee: EmployeeInstance, kind: WorkSession['kind']): WorkSession {
  return store.createSession({
    workspaceId: world.workspaceId,
    worldId: world.id,
    kind,
    title: kind === 'direct' ? '私聊' : '协作',
    participants: [
      { participantId: 'owner', kind: 'owner' },
      { participantId: employee.id, kind: 'employee' },
    ],
  })
}

function turnHistory(employee: EmployeeInstance, turns: number): ConversationHistoryEntry[] {
  const entries: ConversationHistoryEntry[] = []
  for (let index = 1; index <= turns; index += 1) {
    entries.push({
      role: 'user',
      sequence: index * 2 - 1,
      speakerId: 'owner',
      speakerName: '用户',
      content: `第 ${index} 轮请求`,
      createdAt: `2026-08-28T00:${String(index).padStart(2, '0')}:00.000Z`,
    })
    entries.push({
      role: 'assistant',
      sequence: index * 2,
      speakerId: employee.id,
      speakerName: employee.displayName,
      content: `第 ${index} 轮回答`,
      createdAt: `2026-08-28T00:${String(index).padStart(2, '0')}:30.000Z`,
    })
  }
  return entries
}

async function runDirectTurn(
  fixture: Awaited<ReturnType<typeof setup>>,
  conversationId: string,
  prompt: string,
  turns: number,
): Promise<AgentTurnRequest> {
  const { store, employee, inner, runtime, requests } = fixture
  await runtime.runTurn({
    agent: employee,
    revision: store.getEmployeeRevision(employee.id, employee.currentRevision)!,
    conversationId,
    history: turnHistory(employee, turns),
    observedThroughSequence: 0,
    prompt: await requests.composeRuntimePrompt(employee.worldId, employee, prompt),
    workspacePath: '/tmp/world',
  })
  return inner.requests.at(-1)!
}

describe('world stable rules in the cacheable prefix', () => {
  it('still hands the model every world rule, now in the prefix instead of behind the memories', async () => {
    const fixture = await setup()
    const direct = session(fixture.store, fixture.world, fixture.employee, 'direct')

    const request = await runDirectTurn(fixture, direct.id, '今晚的复习计划怎么排？', 2)

    // This is a reordering, not a removal: everything the runtime receives,
    // persona and prompt together, still carries every rule line.
    const modelInput = `${request.revision.persona}\n${request.prompt}`
    for (const rule of WORLD_RULES) expect(modelInput).toContain(rule)
    expect(modelInput).toContain('持久角色“小林”')

    // And they sit in the prefix the provider caches - after the identity,
    // before anything per-turn - rather than inside the request.
    for (const rule of WORLD_RULES) expect(request.revision.persona).toContain(rule)
    expect(request.revision.persona.indexOf(PERSONA)).toBeLessThan(request.revision.persona.indexOf('[当前世界设定]'))
    expect(request.prompt).not.toContain('[当前世界设定]')
    expect(request.prompt).not.toContain(LORE)
    expect(request.prompt).toContain('今晚的复习计划怎么排？')

    const view = fixture.runtime.contextInspection.latest(direct.id)!
    const kinds = view.layers.map((layer) => layer.kind)
    expect(kinds.slice(0, 2)).toEqual(['stable-identity', 'world-context'])
    expect(kinds.at(-1)).toBe('current-request')
    expect(kinds).toEqual(CONTEXT_LAYER_ORDER.filter((kind) => kinds.includes(kind)))
  })

  it('keeps the prefix hash across turns that only move dynamic layers, and moves it when the world rules change', async () => {
    const fixture = await setup()
    const direct = session(fixture.store, fixture.world, fixture.employee, 'direct')

    const first = await runDirectTurn(fixture, direct.id, '第一轮请求', 1)
    const second = await runDirectTurn(fixture, direct.id, '完全不同的第二轮请求', 4)

    expect(first.promptCache?.enabled).toBe(true)
    expect(second.promptCache?.stablePrefixHash).toBe(first.promptCache?.stablePrefixHash)
    expect(second.revision.persona).toBe(first.revision.persona)

    // An owner edit to the world rules is a new prefix, and the new rule text
    // is what the next turn is actually given.
    await fixture.settings.save(fixture.world.id, { lore: `${LORE}\n新增：讲解引用的公式保留来源。` })
    const third = await runDirectTurn(fixture, direct.id, '第三轮请求', 5)

    expect(third.promptCache?.stablePrefixHash).not.toBe(first.promptCache?.stablePrefixHash)
    expect(third.revision.persona).toContain('新增：讲解引用的公式保留来源。')
    expect(third.prompt).not.toContain('新增：讲解引用的公式保留来源。')
    const view = fixture.runtime.contextInspection.latest(direct.id)!
    expect(view.layers.find((layer) => layer.kind === 'world-context')?.revision).toBe('2')
  })

  it('gives a group lane the group identity note by reading the durable session, not the caller', async () => {
    const fixture = await setup()
    const group = session(fixture.store, fixture.world, fixture.employee, 'group')
    const { store, employee, inner, runtime, requests } = fixture

    await runtime.runTurn({
      agent: employee,
      revision: store.getEmployeeRevision(employee.id, employee.currentRevision)!,
      conversationId: group.id,
      history: turnHistory(employee, 1),
      observedThroughSequence: 0,
      prompt: await requests.composeGroupRuntimePrompt(employee.worldId, '大家一起排复习计划'),
      workspacePath: '/tmp/world',
    })

    const request = inner.requests.at(-1)!
    for (const rule of WORLD_RULES) expect(request.revision.persona).toContain(rule)
    expect(request.revision.persona).toContain('多人会话中的每个角色都必须保持自己的当前身份')
    expect(request.revision.persona).not.toContain('持久角色“小林”')
    expect(request.prompt).not.toContain('[当前世界设定]')
    expect(request.promptCache?.retentionHint).toBe('short')
  })

  it('leaves a runtime without a world context source exactly as it was', async () => {
    const fixture = await setup()
    const direct = session(fixture.store, fixture.world, fixture.employee, 'direct')
    const inner = new CaptureRuntime()
    const runtime = new CharacterProfileRuntime(inner, fixture.store)

    await runtime.runTurn({
      agent: fixture.employee,
      revision: fixture.store.getEmployeeRevision(fixture.employee.id, fixture.employee.currentRevision)!,
      conversationId: direct.id,
      history: [],
      observedThroughSequence: 0,
      prompt: '只看一眼',
      workspacePath: '/tmp/world',
    })

    const request = inner.requests[0]!
    expect(request.revision.persona).not.toContain('[当前世界设定]')
    expect(runtime.contextInspection.latest(direct.id)?.layers.map((layer) => layer.kind)).not.toContain('world-context')
  })
})

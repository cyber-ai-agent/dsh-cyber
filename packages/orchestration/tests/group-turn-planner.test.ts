import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { AgentRuntimePort, AgentTurnRequest, EmployeeBlueprint } from '@dsh-cyber/contracts'
import { SqliteStore } from '@dsh-cyber/persistence'

import {
  ConversationOrchestrator,
  HeuristicGroupTurnPlanner,
  normalizeGroupTurnPlan,
  type GroupTurnCandidate,
  type GroupTurnPlan,
  type GroupTurnPlannerPort,
} from '../src/index.js'

const stores: SqliteStore[] = []
const orchestrators: ConversationOrchestrator[] = []

afterEach(async () => {
  for (const orchestrator of orchestrators.splice(0)) await orchestrator.close()
  for (const store of stores.splice(0)) store.close()
})

/** Records overlap so a claim of concurrency can be checked, not assumed. */
class OverlapRuntime implements AgentRuntimePort {
  readonly calls: AgentTurnRequest[] = []
  maxConcurrent = 0
  #active = 0
  readonly #holdMs: number

  constructor(holdMs = 30) {
    this.#holdMs = holdMs
  }

  async runTurn(request: AgentTurnRequest) {
    this.calls.push(request)
    this.#active += 1
    this.maxConcurrent = Math.max(this.maxConcurrent, this.#active)
    await new Promise((resolve) => setTimeout(resolve, this.#holdMs))
    this.#active -= 1
    const content = `${request.agent.displayName}的发言`
    return { agentSessionId: `agent-${request.agent.id}`, finalResponse: content, eventCount: 0 }
  }

  async close(): Promise<void> {}
}

function blueprint(id: string, displayName: string, role: string): EmployeeBlueprint {
  return {
    schemaVersion: 1,
    id,
    version: 1,
    worldTemplateId: 'cyber-company',
    displayName,
    role,
    summary: `${role}角色`,
    persona: `你是${displayName}。`,
    requestedSkills: [],
    requestedCapabilities: [],
    createdAt: '2026-08-19T00:00:00.000Z',
  }
}

async function room(names: Array<[string, string, string]>) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-cyber-group-plan-'))
  const store = await SqliteStore.open(join(directory, 'cyber.sqlite'))
  stores.push(store)
  const workspace = store.createWorkspace({ name: '本地工作区' })
  const world = store.createWorld({ workspaceId: workspace.id, name: '赛博公司', templateId: 'cyber-company' })
  const employees = names.map(([id, displayName, role]) => {
    store.saveBlueprint(blueprint(id, displayName, role))
    return store.recruitEmployee({ workspaceId: workspace.id, worldId: world.id, blueprintId: id, blueprintVersion: 1 })
  })
  return { directory, store, workspace, world, employees }
}

function candidates(ids: string[]): GroupTurnCandidate[] {
  return ids.map((employeeId, index) => ({ employeeId, displayName: `角色${index + 1}` }))
}

describe('normalizeGroupTurnPlan', () => {
  it('drops speakers who are not in the room', async () => {
    const known = candidates(['a', 'b'])
    const plan = normalizeGroupTurnPlan(
      { waves: [{ speakers: [{ employeeId: 'a' }, { employeeId: 'stranger' }] }], source: 'model' },
      known,
    )
    // A planner is a model, so its output is input: it can name a character
    // that does not exist, or one from another world.
    expect(plan.waves).toEqual([{ speakers: [{ employeeId: 'a' }] }])
  })

  it('drops a character repeated inside one wave', async () => {
    const plan = normalizeGroupTurnPlan(
      { waves: [{ speakers: [{ employeeId: 'a' }, { employeeId: 'a' }] }], source: 'model' },
      candidates(['a', 'b']),
    )
    expect(plan.waves[0]!.speakers).toHaveLength(1)
  })

  it('lets a character speak again in a later wave', async () => {
    const plan = normalizeGroupTurnPlan(
      { waves: [{ speakers: [{ employeeId: 'a' }, { employeeId: 'b' }] }, { speakers: [{ employeeId: 'a' }] }], source: 'model' },
      candidates(['a', 'b']),
    )
    // Opening and then synthesising is a legitimate shape.
    expect(plan.waves.map((wave) => wave.speakers.map((speaker) => speaker.employeeId))).toEqual([['a', 'b'], ['a']])
  })

  it('falls back to the whole room rather than failing a paid-for turn', async () => {
    const plan = normalizeGroupTurnPlan({ waves: [], source: 'model' }, candidates(['a', 'b']))
    expect(plan.waves).toEqual([{ speakers: [{ employeeId: 'a' }, { employeeId: 'b' }] }])
  })

  it('caps total speaking slots and waves', async () => {
    const many = candidates(Array.from({ length: 12 }, (_item, index) => `e${index}`))
    const plan = normalizeGroupTurnPlan(
      { waves: Array.from({ length: 6 }, () => ({ speakers: many.map((item) => ({ employeeId: item.employeeId })) })), source: 'model' },
      many,
    )
    expect(plan.waves.length).toBeLessThanOrEqual(3)
    expect(plan.waves.reduce((total, wave) => total + wave.speakers.length, 0)).toBeLessThanOrEqual(8)
  })

  it('truncates a brief instead of letting it become a second prompt', async () => {
    const plan = normalizeGroupTurnPlan(
      { waves: [{ speakers: [{ employeeId: 'a', brief: 'x'.repeat(5_000) }] }], source: 'model' },
      candidates(['a']),
    )
    expect(plan.waves[0]!.speakers[0]!.brief!.length).toBeLessThanOrEqual(240)
  })
})

describe('HeuristicGroupTurnPlanner', () => {
  const planner = new HeuristicGroupTurnPlanner()
  const base = { workspaceId: 'w', worldId: 'world', sessionId: 's' }

  it('narrows the roster to the characters actually addressed', async () => {
    const plan = await planner.plan({
      ...base,
      prompt: '@小刘 你看下这个接口',
      candidates: [
        { employeeId: 'liu', displayName: '小刘' },
        { employeeId: 'wang', displayName: '老王' },
      ],
    })
    expect(plan.waves).toEqual([{ speakers: [{ employeeId: 'liu' }] }])
  })

  it('keeps the addressed order', async () => {
    const plan = await planner.plan({
      ...base,
      prompt: '@老王 先说，然后 @小刘 补充',
      candidates: [
        { employeeId: 'liu', displayName: '小刘' },
        { employeeId: 'wang', displayName: '老王' },
      ],
    })
    expect(plan.waves[0]!.speakers.map((speaker) => speaker.employeeId)).toEqual(['wang', 'liu'])
  })

  it('does not let a shorter name inside a longer one pull in a bystander', async () => {
    const plan = await planner.plan({
      ...base,
      prompt: '@小刘明 看一下',
      candidates: [
        { employeeId: 'liu', displayName: '小刘' },
        { employeeId: 'liuming', displayName: '小刘明' },
      ],
    })
    expect(plan.waves[0]!.speakers.map((speaker) => speaker.employeeId)).toEqual(['liuming'])
  })

  it('gives the whole room the floor when nobody is addressed', async () => {
    const plan = await planner.plan({
      ...base,
      prompt: '这次发布要不要延后？',
      candidates: [
        { employeeId: 'liu', displayName: '小刘' },
        { employeeId: 'wang', displayName: '老王' },
      ],
    })
    expect(plan.waves[0]!.speakers.map((speaker) => speaker.employeeId)).toEqual(['liu', 'wang'])
  })
})

describe('group turn execution', () => {
  it('runs one wave concurrently instead of one character after another', async () => {
    const { directory, store, workspace, world, employees } = await room([
      ['a', '老王', '技术经理'],
      ['b', '小刘', '软件工程师'],
      ['c', '小陈', '安全专家'],
    ])
    const runtime = new OverlapRuntime()
    const orchestrator = new ConversationOrchestrator({ store, runtime, workspacePath: directory })
    orchestrators.push(orchestrator)

    const result = await orchestrator.group({
      workspaceId: workspace.id,
      worldId: world.id,
      employeeIds: employees.map((employee) => employee.id),
      prompt: '评估一下这次上线风险',
    })

    expect(result.replies).toHaveLength(3)
    // The whole point of the change: a three-character room costs one model
    // latency, not three.
    expect(runtime.maxConcurrent).toBe(3)
  })

  it('only runs the characters the planner selected', async () => {
    const { directory, store, workspace, world, employees } = await room([
      ['a', '老王', '技术经理'],
      ['b', '小刘', '软件工程师'],
      ['c', '小陈', '安全专家'],
    ])
    const runtime = new OverlapRuntime(1)
    const orchestrator = new ConversationOrchestrator({ store, runtime, workspacePath: directory })
    orchestrators.push(orchestrator)

    const result = await orchestrator.group({
      workspaceId: workspace.id,
      worldId: world.id,
      employeeIds: employees.map((employee) => employee.id),
      prompt: '@小刘 你单独看下这个接口',
    })

    // Addressing one character used to still run all three, because the turn
    // could not name a roster narrower than the membership list.
    expect(result.replies.map((reply) => reply.employeeId)).toEqual([employees[1]!.id])
    expect(runtime.calls).toHaveLength(1)
  })

  it('gives a later wave the statements of the earlier one', async () => {
    const { directory, store, workspace, world, employees } = await room([
      ['a', '老王', '技术经理'],
      ['b', '小刘', '软件工程师'],
    ])
    const runtime = new OverlapRuntime(1)
    const twoWaves: GroupTurnPlannerPort = {
      async plan(): Promise<GroupTurnPlan> {
        return {
          source: 'model',
          waves: [
            { speakers: [{ employeeId: employees[0]!.id }] },
            { speakers: [{ employeeId: employees[1]!.id, brief: '针对老王的结论做安全复核' }] },
          ],
        }
      },
    }
    const orchestrator = new ConversationOrchestrator({ store, runtime, workspacePath: directory, groupTurnPlanner: twoWaves })
    orchestrators.push(orchestrator)

    await orchestrator.group({
      workspaceId: workspace.id,
      worldId: world.id,
      employeeIds: employees.map((employee) => employee.id),
      prompt: '评估上线风险',
    })

    expect(runtime.calls).toHaveLength(2)
    expect(runtime.calls[0]!.prompt).toContain('尚无其他角色发言。')
    // Sequencing is what a wave boundary buys, and it is the planner's to ask
    // for rather than the loop's to impose on every turn.
    expect(runtime.calls[1]!.prompt).toContain('老王的发言')
    expect(runtime.calls[1]!.prompt).toContain('针对老王的结论做安全复核')
    expect(runtime.maxConcurrent).toBe(1)
  })

  it('bounds one character quoting another', async () => {
    const { directory, store, workspace, world, employees } = await room([
      ['a', '老王', '技术经理'],
      ['b', '小刘', '软件工程师'],
    ])
    const long = '细节'.repeat(3_000)
    const runtime: AgentRuntimePort & { calls: AgentTurnRequest[] } = {
      calls: [],
      async runTurn(request: AgentTurnRequest) {
        this.calls.push(request)
        return { agentSessionId: `agent-${request.agent.id}`, finalResponse: long, eventCount: 0 }
      },
      async close() {},
    }
    const sequential: GroupTurnPlannerPort = {
      async plan(): Promise<GroupTurnPlan> {
        return {
          source: 'model',
          waves: employees.map((employee) => ({ speakers: [{ employeeId: employee.id }] })),
        }
      },
    }
    const orchestrator = new ConversationOrchestrator({ store, runtime, workspacePath: directory, groupTurnPlanner: sequential })
    orchestrators.push(orchestrator)

    await orchestrator.group({
      workspaceId: workspace.id,
      worldId: world.id,
      employeeIds: employees.map((employee) => employee.id),
      prompt: '评估上线风险',
    })

    // Peer statements used to be inlined whole while every sibling prompt
    // builder capped them, so a long-winded room grew its own prompt
    // quadratically within a single turn.
    expect(runtime.calls[1]!.prompt.length).toBeLessThan(4_000)
    expect(runtime.calls[1]!.prompt).toContain('…')
  })

  it('survives a planner that throws', async () => {
    const { directory, store, workspace, world, employees } = await room([
      ['a', '老王', '技术经理'],
      ['b', '小刘', '软件工程师'],
    ])
    const runtime = new OverlapRuntime(1)
    const broken: GroupTurnPlannerPort = {
      async plan(): Promise<GroupTurnPlan> { throw new Error('planner offline') },
    }
    const orchestrator = new ConversationOrchestrator({ store, runtime, workspacePath: directory, groupTurnPlanner: broken })
    orchestrators.push(orchestrator)

    const result = await orchestrator.group({
      workspaceId: workspace.id,
      worldId: world.id,
      employeeIds: employees.map((employee) => employee.id),
      prompt: '评估上线风险',
    })
    // A routing outage must cost the roster, not the turn.
    expect(result.replies).toHaveLength(2)
  })

  it('records the roster decision so a narrow meeting is explainable', async () => {
    const { directory, store, workspace, world, employees } = await room([
      ['a', '老王', '技术经理'],
      ['b', '小刘', '软件工程师'],
    ])
    const runtime = new OverlapRuntime(1)
    const orchestrator = new ConversationOrchestrator({ store, runtime, workspacePath: directory })
    orchestrators.push(orchestrator)

    await orchestrator.group({
      workspaceId: workspace.id,
      worldId: world.id,
      employeeIds: employees.map((employee) => employee.id),
      prompt: '@小刘 你看下',
    })

    const started = store.listWorldDomainEvents(world.id).find((event) => event.type === 'meeting.started')
    expect(started?.payload.plan).toMatchObject({
      source: 'heuristic',
      waves: [[employees[1]!.id]],
    })
  })
})

describe('per-character models in a group', () => {
  it('sends each character its own model rather than one for the whole turn', async () => {
    const { directory, store, workspace, world, employees } = await room([
      ['a', '老王', '技术经理'],
      ['b', '小刘', '软件工程师'],
    ])
    const runtime = new OverlapRuntime(1)
    const orchestrator = new ConversationOrchestrator({ store, runtime, workspacePath: directory })
    orchestrators.push(orchestrator)

    await orchestrator.group({
      workspaceId: workspace.id,
      worldId: world.id,
      employeeIds: employees.map((employee) => employee.id),
      prompt: '评估上线风险',
      modelProfileIds: {
        [employees[0]!.id]: 'profile-architect',
        [employees[1]!.id]: 'profile-engineer',
      },
    })

    const byEmployee = new Map(runtime.calls.map((call) => [call.agent.id, call.modelProfileId]))
    expect(byEmployee.get(employees[0]!.id)).toBe('profile-architect')
    expect(byEmployee.get(employees[1]!.id)).toBe('profile-engineer')
  })

  it('leaves a character without an entry on its own assignment', async () => {
    const { directory, store, workspace, world, employees } = await room([
      ['a', '老王', '技术经理'],
      ['b', '小刘', '软件工程师'],
    ])
    const runtime = new OverlapRuntime(1)
    const orchestrator = new ConversationOrchestrator({ store, runtime, workspacePath: directory })
    orchestrators.push(orchestrator)

    await orchestrator.group({
      workspaceId: workspace.id,
      worldId: world.id,
      employeeIds: employees.map((employee) => employee.id),
      prompt: '评估上线风险',
      modelProfileIds: { [employees[0]!.id]: 'profile-architect' },
    })

    const byEmployee = new Map(runtime.calls.map((call) => [call.agent.id, call.modelProfileId]))
    expect(byEmployee.get(employees[0]!.id)).toBe('profile-architect')
    // Undefined is what makes the host fall through to resolveModelProfile,
    // which is where the character's own assignment lives.
    expect(byEmployee.get(employees[1]!.id)).toBeUndefined()
  })
})

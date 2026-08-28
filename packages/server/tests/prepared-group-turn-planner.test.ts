import { describe, expect, it } from 'vitest'
import type {
  GroupTurnPlan,
  GroupTurnPlannerPort,
} from '@dsh-cyber/orchestration'

import { PreparedGroupTurnPlanner } from '../src/services/prepared-group-turn-planner.js'

const input = {
  workspaceId: 'workspace-1',
  worldId: 'world-1',
  sessionId: 'session-1',
  prompt: '谁来处理这个登录问题？',
  candidates: [
    { employeeId: 'architect', displayName: '架构师' },
    { employeeId: 'security', displayName: '安全专家' },
  ],
}

describe('PreparedGroupTurnPlanner', () => {
  it('uses one semantic planning call for ingress and execution', async () => {
    let calls = 0
    const inner: GroupTurnPlannerPort = {
      async plan(): Promise<GroupTurnPlan> {
        calls += 1
        return {
          source: 'model',
          waves: [{ speakers: [{ employeeId: 'security', brief: '检查认证链路' }] }],
          rationale: '安全专家最匹配',
        }
      },
    }
    const planner = new PreparedGroupTurnPlanner(inner)

    const prepared = await planner.prepare(input)
    const executed = await planner.plan(input)

    expect(calls).toBe(1)
    expect(prepared).toEqual(executed)
    expect(executed.waves[0]!.speakers.map((speaker) => speaker.employeeId)).toEqual(['security'])
  })

  it('can be seeded from a durable user-message plan after restart', async () => {
    const inner: GroupTurnPlannerPort = {
      async plan(): Promise<GroupTurnPlan> {
        throw new Error('semantic planner must not run during recovery')
      },
    }
    const planner = new PreparedGroupTurnPlanner(inner)
    const durable: GroupTurnPlan = {
      source: 'model',
      waves: [{ speakers: [{ employeeId: 'architect' }] }],
      rationale: '从消息元数据恢复',
    }

    planner.seed(input, durable)
    const recovered = await planner.plan(input)

    expect(recovered).toEqual(durable)
  })

  it('normalizes a seeded plan against the current room before executing it', async () => {
    const planner = new PreparedGroupTurnPlanner({
      async plan(): Promise<GroupTurnPlan> { throw new Error('unused') },
    })
    planner.seed(input, {
      source: 'model',
      waves: [{ speakers: [{ employeeId: 'security' }, { employeeId: 'outsider' }] }],
    })

    const recovered = await planner.plan(input)

    expect(recovered.waves).toEqual([{ speakers: [{ employeeId: 'security' }] }])
  })
})

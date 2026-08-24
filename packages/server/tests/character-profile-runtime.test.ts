import { describe, expect, it } from 'vitest'
import type {
  AgentRuntimePort,
  AgentTurnRequest,
  EmployeeInstance,
  EmployeeProfile,
  EmployeeRevision,
} from '@dsh-cyber/contracts'

import {
  CharacterProfileRuntime,
  composeCharacterPersona,
  composeSkillRecipes,
} from '../src/services/character-profile-runtime.js'
import { createBuiltinSkillRegistry } from '../src/skills/builtin-skill-registry.js'

describe('CharacterProfileRuntime', () => {
  it('composes current profile relationship and personality into the effective persona without changing the stored base persona', () => {
    const profile = characterProfile()
    const base = '你做事前先确认事实，不替其他角色发言。'

    const effective = composeCharacterPersona(base, profile)

    expect(effective).toContain(base)
    expect(effective).toContain('背景：曾在旧城区照料过一座私人图书馆。')
    expect(effective).toContain('性格：细致、克制、幽默')
    expect(effective).toContain('与用户的关系：管家')
    expect(effective).toContain('称呼用户为：少爷')
    expect(effective).toContain('自称：我')
    expect(base).toBe('你做事前先确认事实，不替其他角色发言。')
  })

  it('reloads the current character session and revision before every Agent turn', async () => {
    const staleAgent = character({ currentRevision: 1 })
    const currentAgent = character({
      currentRevision: 2,
      agentSessionId: 'persistent-agent-session',
    })
    const staleRevision = revision(1, '旧角色设定')
    const currentRevision = revision(2, '当前角色设定')
    const inner = new CaptureRuntime()
    const runtime = new CharacterProfileRuntime(inner, {
      getEmployee: () => currentAgent,
      getEmployeeRevision: (_employeeId, revisionNumber) => revisionNumber === 2
        ? currentRevision
        : staleRevision,
      getEmployeeProfile: () => characterProfile(),
    })

    await runtime.runTurn({
      agent: staleAgent,
      revision: staleRevision,
      prompt: '继续上一轮讨论',
      workspacePath: '/tmp/world',
    })

    expect(inner.requests).toHaveLength(1)
    expect(inner.requests[0]?.agent).toEqual(currentAgent)
    expect(inner.requests[0]?.revision.revision).toBe(2)
    expect(inner.requests[0]?.revision.persona).toContain('当前角色设定')
    expect(inner.requests[0]?.revision.persona).toContain('[当前角色资料]')
  })

  it('injects only granted declarative recipes and never loads the full catalog', async () => {
    const inner = new CaptureRuntime()
    const granted = revision(2, '当前角色设定')
    granted.skillGrants = ['coding', 'testing']
    const runtime = new CharacterProfileRuntime(inner, {
      getEmployee: () => character({ currentRevision: 2 }),
      getEmployeeRevision: () => granted,
      getEmployeeProfile: () => undefined,
    }, createBuiltinSkillRegistry())

    await runtime.runTurn({ agent: character(), revision: revision(1, '旧设定'), prompt: '实现并验证功能', workspacePath: '/tmp/world' })

    const persona = inner.requests[0]!.revision.persona
    expect(persona).toContain('[已授权的工作方法]')
    expect(persona).toContain('软件实现：')
    expect(persona).toContain('测试验证：')
    expect(persona).not.toContain('会议纪要：')
  })

  it('keeps recipe composition stable when no recipe is granted', () => {
    expect(composeSkillRecipes('基础设定', [])).toBe('基础设定')
  })
})

class CaptureRuntime implements AgentRuntimePort {
  readonly requests: AgentTurnRequest[] = []

  async runTurn(request: AgentTurnRequest) {
    this.requests.push(request)
    return {
      agentSessionId: request.agent.agentSessionId ?? 'new-agent-session',
      finalResponse: '已恢复持久会话。',
      eventCount: 0,
    }
  }

  async close(): Promise<void> {}
}

function character(overrides: Partial<EmployeeInstance> = {}): EmployeeInstance {
  return {
    id: 'character-1',
    workspaceId: 'workspace-1',
    worldId: 'world-1',
    blueprintId: 'core.butler',
    blueprintVersion: 1,
    displayName: '管家',
    role: '世界管家',
    status: 'available',
    currentRevision: 1,
    createdAt: '2026-08-21T00:00:00.000Z',
    updatedAt: '2026-08-21T00:00:00.000Z',
    ...overrides,
  }
}

function revision(revisionNumber: number, persona: string): EmployeeRevision {
  return {
    employeeId: 'character-1',
    revision: revisionNumber,
    persona,
    skillGrants: [],
    capabilityGrants: [],
    modelPolicy: {},
    reason: '测试角色版本',
    createdAt: '2026-08-21T00:00:00.000Z',
  }
}

function characterProfile(): EmployeeProfile {
  return {
    employeeId: 'character-1',
    revision: 3,
    background: '曾在旧城区照料过一座私人图书馆。',
    personalityTraits: ['细致', '克制', '幽默'],
    appearance: {
      avatarIndex: 2,
      worldSkinIndex: 2,
      relationshipToUser: '管家',
      addressUserAs: '少爷',
      selfReference: '我',
    },
    reason: '更新角色资料与关系设定',
    createdAt: '2026-08-21T00:00:00.000Z',
  }
}

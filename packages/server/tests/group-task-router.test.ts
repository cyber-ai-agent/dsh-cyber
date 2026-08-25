import { describe, expect, it } from 'vitest'

import type {
  EmployeeInstance,
  EmployeeRevision,
  SkillCatalogEntry,
} from '@dsh-cyber/contracts'

import { GroupTaskRouter } from '../src/services/group-task-router.js'

describe('GroupTaskRouter', () => {
  it('selects only capable participants and skips an unrelated role', () => {
    const employees = [
      candidate('web', '小刘', '网络研究员', ['web.search.firecrawl']),
      candidate('frontend', '老王', '前端工程师', ['coding']),
      candidate('story', '小陈', '故事作者', ['storytelling']),
    ]
    const result = new GroupTaskRouter().route({
      prompt: '请搜索官网资料，然后制作一个 HTML 对比页',
      employees,
      catalog: [
        skill('web.search.firecrawl', '联网搜索', ['搜索', '官网']),
        skill('coding', '软件实现', ['HTML', '对比页']),
        skill('storytelling', '叙事创作', ['故事']),
      ],
    })

    expect(result.steps.map((step) => step.assignedEmployeeIds[0])).toEqual(['web', 'frontend'])
    expect(result.steps.flatMap((step) => step.assignedEmployeeIds)).not.toContain('story')
    expect(result.requiredSkillIds).toEqual(['web.search.firecrawl', 'coding'])
    expect(result.steps[1]?.dependsOn).toEqual([result.steps[0]?.id])
    expect(result.steps[1]?.executionMode).toBe('sequential')
  })

  it('honors explicit mentions, World availability, and current load deterministically', () => {
    const employees = [
      candidate('busy', '小刘', '网络研究员', ['web.search.firecrawl'], 4),
      candidate('mentioned', '老王', '网络研究员', ['web.search.firecrawl'], 0),
      candidate('unavailable', '小陈', '网络研究员', ['web.search.firecrawl'], 0),
    ]
    const result = new GroupTaskRouter().route({
      prompt: '@老王 请搜索官网资料',
      employees,
      catalog: [skill('web.search.firecrawl', '联网搜索', ['搜索', '官网'])],
    })

    expect(result.steps[0]?.assignedEmployeeIds).toEqual(['mentioned'])
    expect(result.coordinatorEmployeeId).toBe('mentioned')
  })

  it('limits routed executors to three skills and keeps steps topologically neutral for the executor', () => {
    const employees = [
      candidate('a', '甲', '分析师', ['one']),
      candidate('b', '乙', '工程师', ['two']),
      candidate('c', '丙', '编辑', ['three']),
      candidate('d', '丁', '其他', ['four']),
    ]
    const catalog = [
      skill('one', '一号能力', ['一号']),
      skill('two', '二号能力', ['二号']),
      skill('three', '三号能力', ['三号']),
      skill('four', '四号能力', ['四号']),
    ]
    const result = new GroupTaskRouter().route({
      prompt: '一号、二号、三号、四号都提到，但最多安排少量角色',
      employees,
      catalog,
    })

    expect(result.steps).toHaveLength(3)
    expect(result.steps.every((step) => step.dependsOn.length === 0)).toBe(true)
    expect(result.steps.every((step) => step.executionMode === 'parallel')).toBe(true)
    expect(new Set(result.steps.flatMap((step) => step.assignedEmployeeIds)).size).toBe(3)
  })
})

function candidate(
  id: string,
  displayName: string,
  role: string,
  skillGrants: string[],
  activeLoad = 0,
): { employee: EmployeeInstance; revision: EmployeeRevision; activeLoad: number } {
  return {
    employee: {
      id,
      workspaceId: 'workspace-1',
      worldId: 'world-1',
      blueprintId: 'test',
      blueprintVersion: 1,
      displayName,
      role,
      status: 'available',
      currentRevision: 1,
      createdAt: '2026-08-26T00:00:00.000Z',
      updatedAt: '2026-08-26T00:00:00.000Z',
    },
    revision: {
      employeeId: id,
      revision: 1,
      persona: '测试角色',
      skillGrants,
      capabilityGrants: [],
      modelPolicy: {},
      reason: 'test',
      createdAt: '2026-08-26T00:00:00.000Z',
    },
    activeLoad,
  }
}

function skill(id: string, displayName: string, routingHints: string[]): SkillCatalogEntry {
  return {
    id,
    displayName,
    summary: `${displayName}能力`,
    adapterId: `test.${id}`,
    risks: [],
    supportsScheduling: false,
    persistentApproval: 'forbidden',
    kind: 'recipe',
    recommendedByDefault: false,
    source: 'builtin',
    scope: 'builtin',
    globalKnown: true,
    worldAvailable: true,
    availability: 'available',
    // routingHints is optional in the shared contract while the catalog
    // migration is being rolled out; exercise the provider-neutral extension.
    routingHints,
  }
}

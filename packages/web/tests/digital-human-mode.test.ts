import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import type { World, WorldRuntimeSnapshot } from '@dsh-cyber/contracts'
import { DigitalHumanMode } from '../src/features/world/DigitalHumanMode.js'
import type { CyberEmployee } from '../src/types.js'

const world: World = { id: 'world-digital', workspaceId: 'workspace-digital', name: '数字行动世界', templateId: 'personal-world', status: 'active', createdAt: '2026-08-30T00:00:00.000Z', updatedAt: '2026-08-30T00:00:00.000Z' }
const employees: CyberEmployee[] = [
  { id: 'employee-lead', displayName: '陈明远', role: '首席分析师', avatarIndex: 7, currentActivity: '正在分析' },
  { id: 'employee-peer', displayName: '林思琪', role: '基本面分析师', avatarIndex: 0, currentActivity: '协作中' },
]

function snapshot(activity: WorldRuntimeSnapshot['entities'][number]['activity'], activityLabel: string, status: WorldRuntimeSnapshot['entities'][number]['status'] = 'working'): WorldRuntimeSnapshot {
  return {
    contractVersion: 1,
    workspaceId: world.workspaceId,
    worldId: world.id,
    templateId: world.templateId,
    themeId: 'test-theme',
    sceneId: 'test-scene',
    sequence: 12,
    generatedAt: world.updatedAt,
    clock: { now: world.updatedAt, timezone: 'Asia/Shanghai', lightsOn: true },
    entities: employees.map((employee, index) => ({
      id: employee.id,
      kind: 'agent',
      sceneId: 'test-scene',
      displayName: employee.displayName,
      role: employee.role,
      position: { x: index * 10, y: 0 },
      footOffset: { x: 0, y: 0 },
      facing: 'south',
      activity: index === 0 ? activity : 'meeting',
      activityLabel: index === 0 ? activityLabel : '参与协作',
      status: index === 0 ? status : 'working',
      activityRef: index === 0 ? 'turn-1' : 'turn-2',
      route: [],
      visualState: {},
      updatedAt: world.updatedAt,
    })),
    objects: [],
    growthSlots: {},
  }
}

function render(activity: WorldRuntimeSnapshot['entities'][number]['activity'], activityLabel: string, status?: WorldRuntimeSnapshot['entities'][number]['status']) {
  return renderToStaticMarkup(createElement(DigitalHumanMode, {
    world,
    employees,
    snapshot: snapshot(activity, activityLabel, status),
    connected: true,
    staticMode: false,
    activeEmployeeId: employees[0]!.id,
    conversationEmployeeIds: employees.map((employee) => employee.id),
    onSelectEmployee: vi.fn(),
    onOpenDossier: vi.fn(),
    onOpenTrace: vi.fn(),
    onStaticModeChange: vi.fn(),
  }))
}

describe('DigitalHumanMode', () => {
  it('projects real conversation and execution facts without claiming an artifact', () => {
    const html = render('thinking', '正在理解用户意图')
    expect(html).toContain('data-state="thinking"')
    expect(html).not.toContain('当前会话耐久事实')
    expect(html).toContain('aria-label="数字人状态"')
    expect(html).toContain('收起数字人状态')
    expect(html).toContain('陈明远 · 首席分析师')
    expect(html).toContain('聚焦林思琪对话')
  })

  it('freezes into an explicit failed state from a durable blocked role', () => {
    const html = render('blocked', '模型服务失败', 'blocked')
    expect(html).toContain('data-state="failed"')
    expect(html).toContain('失败')
    expect(html).toContain('执行停止，需要人工处理')
  })

  it('maps approval copy to the approval state and supports static mode', () => {
    const html = renderToStaticMarkup(createElement(DigitalHumanMode, {
      world,
      employees,
      snapshot: snapshot('working', '等待审批'),
      connected: true,
      staticMode: true,
      conversationEmployeeIds: [employees[0]!.id],
      onSelectEmployee: vi.fn(),
      onOpenDossier: vi.fn(),
      onOpenTrace: vi.fn(),
      onStaticModeChange: vi.fn(),
    }))
    expect(html).toContain('data-state="approval"')
    expect(html).toContain('digital-human--static')
    expect(html).toContain('启用角色动效')
  })
})

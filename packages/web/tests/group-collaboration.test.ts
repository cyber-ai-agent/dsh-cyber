import { createElement } from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'

import type { CyberEmployee } from '../src/types.js'
import { GroupConversationDialog } from '../src/components/GroupConversationDialog.js'
import { collaborationModeOf, normalizeTaskCollaborationPlan } from '../src/components/group-collaboration.js'

const employees: CyberEmployee[] = [employee('employee-a', '甲角色'), employee('employee-b', '乙角色'), employee('employee-c', '丙角色')]

describe('GroupConversationDialog collaboration modes', () => {
  it('focuses search once, keeps title focus on rerender, and submits task mode', async () => {
    const onCreate = vi.fn(async () => undefined)
    const onClose = vi.fn()
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => { root.render(createElement(GroupConversationDialog, { employees, onCreate, onClose, creating: false })) })
    const search = host.querySelector<HTMLInputElement>('[aria-label="搜索群聊成员"]')
    const title = host.querySelector<HTMLInputElement>('.group-dialog__name input')
    expect(document.activeElement).toBe(search)
    title?.focus()
    await act(async () => { root.render(createElement(GroupConversationDialog, { employees, onCreate, onClose, creating: true })) })
    expect(document.activeElement).toBe(title)
    await act(async () => { root.render(createElement(GroupConversationDialog, { employees, onCreate, onClose, creating: false })) })

    const taskMode = host.querySelector<HTMLInputElement>('input[value="task"]')
    const memberChecks = Array.from(host.querySelectorAll<HTMLInputElement>('.group-dialog__list input[type="checkbox"]'))
    await act(async () => {
      taskMode?.click()
      memberChecks[0]?.click()
      memberChecks[1]?.click()
    })
    const createButton = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === '创建群聊')
    await act(async () => { createButton?.click() })
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ collaborationMode: 'task', employeeIds: ['employee-a', 'employee-b'] }))
    await act(async () => { root.unmount() })
    host.remove()
  })
})

describe('task collaboration projection', () => {
  it('keeps only lightweight role, skill and step status data for the chat card', () => {
    expect(collaborationModeOf({ collaborationMode: 'task' })).toBe('task')
    expect(collaborationModeOf({ collaborationMode: 'discussion' })).toBe('discussion')
    expect(normalizeTaskCollaborationPlan({ skillLabels: { 'web.search': '联网搜索', coding: '软件实现', html: '页面制作' }, plan: { status: 'running', steps: [{ id: 'step-a', assignedEmployeeIds: ['employee-a'], requiredSkills: ['web.search'], status: 'running', tool: 'must-not-render' }, { id: 'step-b', assignedEmployeeIds: ['employee-b'], requiredSkills: ['coding', 'html'], status: 'failed' }] } }, 'session-1')).toEqual({
      sessionId: 'session-1',
      status: 'running',
      steps: [
        { id: 'step-a', employeeId: 'employee-a', employeeIds: ['employee-a'], skillId: 'web.search', skillLabel: '联网搜索', skillIds: ['web.search'], status: 'running' },
        { id: 'step-b', employeeId: 'employee-b', employeeIds: ['employee-b'], skillId: 'coding', skillLabel: '软件实现、页面制作', skillIds: ['coding', 'html'], status: 'blocked' },
      ],
    })
  })
})

function employee(id: string, displayName: string): CyberEmployee {
  const now = '2026-08-26T00:00:00.000Z'
  return {
    id,
    workspaceId: 'workspace-group-test',
    worldId: 'world-group-test',
    blueprintId: 'blueprint-test',
    blueprintVersion: 1,
    displayName,
    role: '分析角色',
    status: 'available',
    currentRevision: 1,
    createdAt: now,
    updatedAt: now,
    avatarIndex: 0,
    summary: '测试角色',
    currentActivity: '可接任务',
  }
}

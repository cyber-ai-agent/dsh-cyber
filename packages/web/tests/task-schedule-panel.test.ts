import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { TaskSchedule } from '@dsh-cyber/contracts'

import { TaskSchedulePanel, validateScheduleDraft } from '../src/components/TaskSchedulePanel.js'

describe('TaskSchedulePanel', () => {
  it('uses clear schedule terminology and visible item actions', () => {
    const item: TaskSchedule = {
      id: 'schedule-1',
      workspaceId: 'workspace-1',
      worldId: 'world-1',
      employeeId: 'employee-1',
      title: '整理项目进展',
      prompt: '汇总今天的项目进展。',
      kind: 'interval',
      status: 'active',
      scheduledAt: '2026-08-24T09:00:00.000Z',
      nextRunAt: '2026-08-24T09:00:00.000Z',
      everySeconds: 3600,
      timeZone: 'Asia/Shanghai',
      permissionMode: 'read-only',
      createdAt: '2026-08-23T00:00:00.000Z',
      updatedAt: '2026-08-23T00:00:00.000Z',
    }
    const html = renderToStaticMarkup(createElement(TaskSchedulePanel, {
      employees: [{ id: 'employee-1', worldId: 'world-1', blueprintId: 'blueprint-1', blueprintVersion: 1, displayName: '管家', role: '世界管家', status: 'available', avatarIndex: 0, summary: '', currentActivity: '', createdAt: '2026-08-23T00:00:00.000Z', updatedAt: '2026-08-23T00:00:00.000Z' }],
      items: [item],
      busy: false,
      onCreate: async () => undefined,
      onStatus: async () => undefined,
      onRun: async () => undefined,
      onDelete: async () => undefined,
    }))
    expect(html).toContain('任务日程')
    expect(html).toContain('新建日程')
    expect(html).toContain('暂停')
    expect(html).toContain('立即运行')
    expect(html).toContain('删除')
    expect(html).not.toContain('计划任务')
  })

  it('returns understandable validation messages for incomplete and unsafe drafts', () => {
    const errors = validateScheduleDraft({ employeeId: '', title: ' ', prompt: '', kind: 'interval', scheduledAt: '', intervalMinutes: '1.5' })
    expect(errors).toEqual({
      employeeId: '请先选择一个执行角色。',
      title: '请填写便于识别的日程名称。',
      prompt: '请说明要执行的任务内容。',
      scheduledAt: '请选择有效的首次执行时间。',
      intervalMinutes: '重复间隔必须是至少 5 分钟的整数。',
    })
  })
})

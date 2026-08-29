import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { WorkSession } from '@dsh-cyber/contracts'
import type { ConversationHubItem } from '@dsh-cyber/contracts/creative-platform'

import { SessionRow } from '../src/components/NavigationPane.js'
import type { CyberEmployee } from '../src/types.js'

describe('NavigationPane conversation rows', () => {
  it('keeps a direct character role beside the name and the timestamp in its own column', () => {
    const updatedAt = '2026-08-29T01:47:00.000Z'
    const session = { id: 'session-nav', workspaceId: 'workspace-nav', worldId: 'world-nav', kind: 'direct', title: '与 苏遥 对话', status: 'open', createdAt: updatedAt, updatedAt } as WorkSession
    const employee = { id: 'employee-nav', workspaceId: 'workspace-nav', worldId: 'world-nav', blueprintId: 'blueprint-nav', blueprintVersion: 1, displayName: '苏遥', role: '天体物理学家', status: 'available', currentRevision: 1, createdAt: updatedAt, updatedAt, avatarIndex: 0, summary: '测试', currentActivity: '可接任务' } as CyberEmployee
    const item = { session, participantIds: [employee.id], pinned: false, hidden: false, lastPrompt: '大家晚上好' } as ConversationHubItem

    const html = renderToStaticMarkup(createElement(SessionRow, {
      item,
      employees: [employee],
      active: false,
      onClick: () => undefined,
    }))

    expect(html).toContain('session-row__name')
    expect(html).toContain('苏遥')
    expect(html).toContain('session-row__role')
    expect(html).toContain('· 天体物理学家')
    expect(html).toContain('大家晚上好')
    expect(html).toContain(`dateTime="${updatedAt}"`)
  })
})

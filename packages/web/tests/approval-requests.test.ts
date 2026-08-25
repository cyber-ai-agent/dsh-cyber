import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { ApprovalRequestView } from '@dsh-cyber/contracts'

import { ApprovalRequests } from '../src/components/ApprovalRequests.js'

function view(overrides: Partial<ApprovalRequestView> = {}): ApprovalRequestView {
  return {
    request: {
      id: 'approval-1',
      workspaceId: 'workspace-1',
      worldId: 'world-1',
      subjectType: 'skill-action',
      subjectId: 'action-1',
      risk: 'external-side-effect',
      summary: '关闭厨房灯 · light.kitchen',
      status: 'pending',
      scope: 'once',
      createdAt: '2026-08-24T10:00:00.000Z',
      expiresAt: '2026-08-24T10:10:00.000Z',
    },
    characterName: '阿开',
    subject: {
      id: 'action-1',
      skillId: 'smart-home.control',
      adapterId: 'builtin.home-assistant',
      action: 'switch.turn_off',
      target: 'light.kitchen',
      label: '关闭厨房灯',
      risk: 'external-side-effect',
      parameters: { entityId: 'light.kitchen' },
    },
    ...overrides,
  }
}

const noop = async () => {}

describe('ApprovalRequests', () => {
  it('renders nothing when the gate is not holding anything', () => {
    expect(renderToStaticMarkup(createElement(ApprovalRequests, { items: [], onDecide: noop }))).toBe('')
  })

  it('shows the concrete call, not just the summary line', () => {
    const markup = renderToStaticMarkup(createElement(ApprovalRequests, { items: [view()], onDecide: noop }))
    // Consenting to a label is not consenting to what it is attached to.
    expect(markup).toContain('builtin.home-assistant')
    expect(markup).toContain('smart-home.control')
    expect(markup).toContain('switch.turn_off')
    expect(markup).toContain('light.kitchen')
    expect(markup).toContain('entityId=light.kitchen')
    expect(markup).toContain('阿开')
    expect(markup).toContain('会影响真实世界')
  })

  it('offers all three decisions and says what happens if none is made', () => {
    const markup = renderToStaticMarkup(createElement(ApprovalRequests, { items: [view()], onDecide: noop }))
    expect(markup).toContain('本次允许')
    expect(markup).toContain('一直允许')
    expect(markup).toContain('拒绝')
    expect(markup).toContain('自动拒绝')
  })

  it('still renders a decision surface when the subject action cannot be resolved', () => {
    const markup = renderToStaticMarkup(createElement(ApprovalRequests, {
      items: [view({ subject: undefined as never })],
      onDecide: noop,
    }))
    expect(markup).toContain('关闭厨房灯 · light.kitchen')
    expect(markup).toContain('本次允许')
  })
})

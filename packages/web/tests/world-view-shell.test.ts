import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import type { World } from '@dsh-cyber/contracts'
import { WorldView } from '../src/components/WorldView.js'

describe('WorldView shell', () => {
  it('does not restore the removed duplicate world identity header', () => {
    const world: World = {
      id: 'world-shell', workspaceId: 'workspace-shell', name: '我的世界',
      templateId: 'personal-world', status: 'active',
      createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    }
    const html = renderToStaticMarkup(createElement(WorldView, {
      world, employees: [], onSelectEmployee: vi.fn(),
    }))
    expect(html).not.toContain('world-view__header')
    expect(html).not.toContain('实时运行')
    expect(html).not.toContain('名行动中')
  })
})

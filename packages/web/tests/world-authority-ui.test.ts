import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { WorldCharacterAuthority, WorldPermissionRequest } from '@dsh-cyber/contracts'

import { AuthorityBadge } from '../src/components/AuthorityBadge.js'
import { Avatar } from '../src/components/Avatar.js'
import { WorldPermissionRequests } from '../src/components/ChatWorkbench.js'
import { stripManagementPermissions, WorldPermissionEditor } from '../src/components/WorldPermissionEditor.js'
import type { CyberEmployee } from '../src/types.js'

const authority: WorldCharacterAuthority = {
  worldId: 'world-1',
  employeeId: 'employee-1',
  role: 'administrator',
  permissionGrants: ['world.files.read', 'world.permissions.manage', 'world.conversations.read-content'],
  createdAt: '2026-08-25T08:00:00.000Z',
  updatedAt: '2026-08-25T08:00:00.000Z',
}

const employee = {
  id: 'employee-1',
  displayName: '阿开',
  role: '项目负责人',
  status: 'available',
  currentRevision: 1,
  blueprintId: 'core.butler',
  blueprintVersion: 1,
  worldId: 'world-1',
  createdAt: '2026-08-25T08:00:00.000Z',
  updatedAt: '2026-08-25T08:00:00.000Z',
  avatarIndex: 0,
  summary: '负责当前世界',
  currentActivity: '可接新任务',
  authorityRole: 'administrator',
} as CyberEmployee

const request: WorldPermissionRequest = {
  id: 'permission-request-1',
  workspaceId: 'workspace-1',
  worldId: 'world-1',
  employeeId: 'employee-1',
  workTurnId: 'turn-1',
  skillActionId: 'action-1',
  permission: 'world.files.write',
  status: 'pending',
  createdAt: '2026-08-25T08:00:00.000Z',
  expiresAt: '2026-08-25T08:05:00.000Z',
}

describe('world authority UI', () => {
  it('uses one accessible warm-gold administrator badge across avatar surfaces', () => {
    const markup = renderToStaticMarkup(createElement(Avatar, { index: 0, label: '阿开', authorityRole: 'administrator' }))
    expect(markup).toContain('aria-label="阿开，世界管理员"')
    expect(markup).toContain('aria-label="世界管理员"')
    expect(renderToStaticMarkup(createElement(AuthorityBadge, { role: 'member' }))).toBe('')
  })

  it('renders world authority before advanced capability details', () => {
    const markup = renderToStaticMarkup(createElement(WorldPermissionEditor, { authority, onSave: async () => undefined }))
    expect(markup).toContain('世界权限')
    expect(markup).toContain('世界管理员')
    expect(markup).toContain('world.permissions.manage')
    expect(markup).toContain('管理世界连接')
    expect(markup).toContain('disabled=""')
    expect(markup).toContain('暂不可授予，需单独安全审批')
    expect(markup.indexOf('世界权限')).toBeLessThan(markup.indexOf('保存世界权限'))
  })

  it('strips management grants immediately when demoting a character', () => {
    expect(stripManagementPermissions([
      'world.files.read',
      'world.characters.manage',
      'world.permissions.manage',
      'world.conversations.read-metadata',
    ])).toEqual(['world.files.read', 'world.conversations.read-metadata'])
  })

  it('renders an inline request card with bounded decisions', () => {
    const markup = renderToStaticMarkup(createElement(WorldPermissionRequests, {
      items: [request],
      employees: [employee],
      onDecide: async () => undefined,
      onOpenSettings: () => undefined,
    }))
    expect(markup).toContain('阿开想要修改当前世界文件')
    expect(markup).toContain('仅本次允许')
    expect(markup).toContain('授予该权限并执行')
    expect(markup).toContain('打开权限设置')
    expect(markup).toContain('拒绝')

    const integrationMarkup = renderToStaticMarkup(createElement(WorldPermissionRequests, {
      items: [{ ...request, id: 'integration-request-1', permission: 'world.integrations.manage' }],
      employees: [employee],
      onDecide: async () => undefined,
      onOpenSettings: () => undefined,
    }))
    expect(integrationMarkup).toContain('连接管理权限暂不可在这里授予')
    expect(integrationMarkup).toContain('暂不可授予')
    expect(integrationMarkup).toContain('disabled=""')
    expect(integrationMarkup).not.toContain('授予该权限并执行')
  })
})

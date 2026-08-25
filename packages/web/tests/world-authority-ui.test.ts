import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { WorldCharacterAuthority, WorldPermissionRequest } from '@dsh-cyber/contracts'

import { AuthorityBadge } from '../src/components/AuthorityBadge.js'
import { Avatar } from '../src/components/Avatar.js'
import { EmployeeManagementDialog } from '../src/components/EmployeeManagementDialog.js'
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
  it('keeps administrator identity accessible without placing a crown on the avatar', () => {
    const avatarMarkup = renderToStaticMarkup(createElement(Avatar, { index: 0, label: '阿开', authorityRole: 'administrator' }))
    const badgeMarkup = renderToStaticMarkup(createElement(AuthorityBadge, { role: 'administrator' }))
    expect(avatarMarkup).toContain('aria-label="阿开，世界管理员"')
    expect(avatarMarkup).not.toContain('authority-badge')
    expect(badgeMarkup).toContain('aria-label="世界管理员"')
    expect(renderToStaticMarkup(createElement(AuthorityBadge, { role: 'member' }))).toBe('')
  })

  it('renders world authority before advanced capability details', () => {
    const markup = renderToStaticMarkup(createElement(WorldPermissionEditor, { authority, onSave: async () => undefined }))
    expect(markup).toContain('世界权限')
    expect(markup).toContain('世界管理员')
    expect(markup).toContain('管理角色权限')
    expect(markup).not.toContain('world.permissions.manage')
    expect(markup).toContain('管理世界连接')
    expect(markup).toContain('disabled=""')
    expect(markup).toContain('暂不可授予，需单独安全审批')
    expect(markup.indexOf('世界权限')).toBeLessThan(markup.indexOf('保存世界权限'))
  })

  it('presents role settings as focused Chinese sections without internal version copy', () => {
    const markup = renderToStaticMarkup(createElement(EmployeeManagementDialog, {
      employee,
      models: [],
      avatarIndex: 0,
      saving: false,
      authority,
      onClose: () => undefined,
      onRevise: async () => undefined,
      onUpdateProfile: async () => undefined,
      onArchive: async () => undefined,
    }))
    expect(markup).toContain('身份资料')
    expect(markup).toContain('行为方式')
    expect(markup).toContain('可用能力')
    expect(markup).toContain('世界权限')
    expect(markup).toContain('高级设置')
    expect(markup).toContain('保存角色资料')
    expect(markup).not.toContain('保存为 r')
    expect(markup).not.toContain('revision')
    expect(markup).not.toContain('Capability')
    expect(markup).not.toContain('Blueprint')
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

describe('world permission card content and routing', () => {
  const base = {
    id: 'request-1',
    workspaceId: 'workspace-1',
    worldId: 'world-1',
    employeeId: 'employee-1',
    skillActionId: 'action-1',
    permission: 'world.settings.write' as const,
    status: 'pending' as const,
    createdAt: '2026-08-25T10:00:00.000Z',
    expiresAt: '2026-08-25T10:10:00.000Z',
  }
  const employees = [{ id: 'employee-1', displayName: '小刘', authorityRole: 'member' } as never]
  const noop = async () => {}

  it('shows the concrete action, not only the permission key', () => {
    const markup = renderToStaticMarkup(createElement(WorldPermissionRequests, {
      items: [{
        ...base,
        sessionId: 'session-a',
        subject: {
          id: 'action-1',
          action: 'world.settings.update',
          target: 'world:world-1',
          label: '修改当前场景',
          parameters: { scenario: '产品评审' },
        },
      } as never],
      employees,
      activeSessionId: 'session-a',
      onDecide: noop,
    }))
    expect(markup).toContain('修改当前场景')
    expect(markup).toContain('world.settings.update')
    expect(markup).toContain('scenario=产品评审')
  })

  it('keeps another conversation card out of this composer but visible as a count', () => {
    const markup = renderToStaticMarkup(createElement(WorldPermissionRequests, {
      items: [{ ...base, sessionId: 'session-b' } as never],
      employees,
      activeSessionId: 'session-a',
      onDecide: noop,
    }))
    // Not decidable here…
    expect(markup).not.toContain('仅本次允许')
    // …but never silently absent.
    expect(markup).toContain('其他会话')
  })
})

describe('world live subscription', () => {
  it('registers every event name the union declares', async () => {
    // A name added to the union but forgotten in the client's listener map
    // became a crash on first subscribe — and no test caught it, because web
    // tests render to static markup and never run effects.
    const source = await import('../src/world-live-client.js')
    const text = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../src/world-live-client.ts', import.meta.url), 'utf8'))
    expect(typeof source.subscribeWorldLive).toBe('function')
    // The map is derived from the union rather than hand-listed.
    expect(text).toContain('WORLD_LIVE_EVENT_NAMES.map')
    expect(text).not.toContain("client.listeners.get(eventName)!.add")
  })
})

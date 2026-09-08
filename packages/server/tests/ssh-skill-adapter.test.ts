import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CharacterSkillAction } from '@dsh-cyber/contracts/skill-runtime'

import { SSH_COMMAND_SKILL, SshSkillAdapter } from '../src/skills/ssh-skill-adapter.js'

vi.mock('../src/integrations/ssh-client.js', () => ({ SshError: class extends Error { constructor(public kind: string, message: string) { super(message) } }, sshExecOnce: vi.fn() }))
import { sshExecOnce } from '../src/integrations/ssh-client.js'

const exec = vi.mocked(sshExecOnce)

function device(overrides: Partial<Record<'enabled' | 'host' | 'username' | 'privateKey', unknown>> = {}) {
  return {
    id: 'device-1', workspaceId: 'workspace-1', integrationId: 'builtin.ssh-device', displayName: '客厅主机',
    config: { displayName: '客厅主机', host: '10.0.0.10', port: 22, username: 'owner' },
    enabled: true, credentialConfigured: true, createdAt: '', updatedAt: '', ...overrides,
  }
}

function world() { return { id: 'world-1', workspaceId: 'workspace-1' } }

function makeAdapter(integrations: unknown) {
  return new SshSkillAdapter({ store: { getWorld: () => world() }, integrations: integrations as never })
}

function actionFrom(proposal: { skillId: string; adapterId: string; action: string; target: string; label: string; risk: 'external-side-effect' | 'read' | 'write-local'; authorization: string; parameters?: Record<string, unknown> }): CharacterSkillAction {
  return {
    id: 'action-1', worldId: 'world-1', characterId: 'character-1', skillId: proposal.skillId,
    adapterId: proposal.adapterId, action: proposal.action, target: proposal.target, label: proposal.label,
    risk: proposal.risk as CharacterSkillAction['risk'], authorization: proposal.authorization as CharacterSkillAction['authorization'],
    parameters: proposal.parameters ?? {}, status: 'waiting-for-approval', detail: '',
    createdAt: '2026-09-08T00:00:00.000Z', updatedAt: '2026-09-08T00:00:00.000Z',
  }
}

beforeEach(() => exec.mockReset())
afterEach(() => vi.restoreAllMocks())

describe('SshSkillAdapter', () => {
  it('proposes only when the skill is granted and the intent matches a device operation', () => {
    const adapter = makeAdapter({ listByType: () => [device()], getById: () => device(), credentialForConnection: () => 'key' })
    expect(adapter.propose({ worldId: 'world-1', characterId: 'character-1', prompt: '看看磁盘', grantedSkillIds: [], now: new Date() })).toEqual([])
    const proposal = adapter.propose({ worldId: 'world-1', characterId: 'character-1', prompt: '连客厅主机看看磁盘', grantedSkillIds: [SSH_COMMAND_SKILL], now: new Date() })[0]!
    expect(proposal).toMatchObject({ skillId: SSH_COMMAND_SKILL, action: 'ssh.disk.usage', risk: 'external-side-effect' })
  })

  it('preflight requires a configured and enabled device with a credential', async () => {
    const adapter = makeAdapter({ listByType: () => [], getById: () => undefined, credentialForConnection: () => undefined })
    const proposal = adapter.propose({ worldId: 'world-1', characterId: 'character-1', prompt: '看看磁盘', grantedSkillIds: [SSH_COMMAND_SKILL], now: new Date() })[0]!
    expect((await adapter.preflight(actionFrom(proposal)))!.ready).toBe(false)
  })

  it('executes a read op through the device and returns the sanitized output', async () => {
    const adapter = makeAdapter({ listByType: () => [device()], getById: () => device(), credentialForConnection: () => '-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n-----END OPENSSH PRIVATE KEY-----' })
    const proposal = adapter.propose({ worldId: 'world-1', characterId: 'character-1', prompt: '查看磁盘', grantedSkillIds: [SSH_COMMAND_SKILL], now: new Date() })[0]!
    exec.mockResolvedValueOnce({ code: 0, stdout: 'Linux\nlinux-apt', stderr: '' })
      .mockResolvedValueOnce({ code: 0, stdout: '/dev/sda1  50G  12G  36G  25% /', stderr: '' })
    const result = await adapter.execute(actionFrom(proposal), { now: new Date() })
    expect(result.status).toBe('executed')
    expect(result.detail).toContain('/dev/sda1')
    expect(result.detail).not.toContain('BEGIN OPENSSH')
  })

  it('reports refused auth as failed and connection loss as outcome-unknown', async () => {
    const adapter = makeAdapter({ listByType: () => [device()], getById: () => device(), credentialForConnection: () => 'key' })
    const proposal = adapter.propose({ worldId: 'world-1', characterId: 'character-1', prompt: '查看内存', grantedSkillIds: [SSH_COMMAND_SKILL], now: new Date() })[0]!
    exec.mockRejectedValueOnce(new (await import('../src/integrations/ssh-client.js')).SshError('auth-failed', 'permission denied'))
    expect((await adapter.execute(actionFrom(proposal), { now: new Date() })).status).toBe('failed')
    exec.mockRejectedValueOnce(new (await import('../src/integrations/ssh-client.js')).SshError('timeout', 'timed out'))
    expect((await adapter.execute(actionFrom(proposal), { now: new Date() })).status).toBe('outcome-unknown')
  })

  it('returns waiting-for-integration when no device resolves', async () => {
    const adapter = makeAdapter({ listByType: () => [] })
    const proposal = adapter.propose({ worldId: 'world-1', characterId: 'character-1', prompt: '查看内存', grantedSkillIds: [SSH_COMMAND_SKILL], now: new Date() })[0]!
    const result = await adapter.execute(actionFrom(proposal), { now: new Date() })
    expect(result.status).toBe('waiting-for-integration')
    expect(exec).not.toHaveBeenCalled()
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CharacterSkillAction } from '@dsh-cyber/contracts/skill-runtime'

import { SSH_COMMAND_SKILL, SshSkillAdapter } from '../src/skills/ssh-skill-adapter.js'

vi.mock('../src/integrations/ssh-client.js', () => ({
  SshError: class extends Error { constructor(public kind: string, message: string) { super(message) } },
  sshExecOnce: vi.fn(),
  SshSessionPool: class {
    exec = vi.fn(async () => ({ code: 0, stdout: 'Linux\nlinux-apt', stderr: '' }))
    invalidate = vi.fn(async () => undefined)
    close = vi.fn(async () => undefined)
  },
}))
import { sshExecOnce, SshSessionPool } from '../src/integrations/ssh-client.js'

const exec = vi.mocked(sshExecOnce)

function device(overrides: Partial<Record<'enabled' | 'host' | 'username', unknown>> = {}) {
  return {
    id: 'device-1', workspaceId: 'workspace-1', integrationId: 'builtin.ssh-device', displayName: '客厅主机',
    config: { displayName: '客厅主机', host: '10.0.0.10', port: 22, username: 'owner' },
    enabled: true, credentialConfigured: true, createdAt: '', updatedAt: '', ...overrides,
  }
}

function world() { return { id: 'world-1', workspaceId: 'workspace-1' } }

function makeAdapter(integrations: unknown, connectionGrantsFor?: (characterId: string) => readonly string[] | undefined, sessions?: unknown) {
  return new SshSkillAdapter({
    store: { getWorld: () => world() },
    integrations: integrations as never,
    ...(connectionGrantsFor === undefined ? {} : { connectionGrantsFor }),
    ...(sessions === undefined ? {} : { sessions: sessions as never }),
  })
}

/** Grant helper: the character owns device-1, matching the fixture device. */
function grantsDevice(characterId: string): readonly string[] | undefined {
  return characterId === 'character-1' ? ['device-1'] : []
}

function directAction(parameters: Record<string, unknown> = { deviceId: 'device-1', op: 'disk.usage', summary: '查看磁盘使用情况', params: {} }): CharacterSkillAction {
  return {
    id: 'action-1', worldId: 'world-1', characterId: 'character-1', skillId: SSH_COMMAND_SKILL,
    adapterId: 'builtin.ssh-device', action: 'ssh.disk.usage', target: 'ssh:device', label: '查看磁盘使用情况',
    risk: 'external-side-effect', authorization: 'explicit-user-request',
    parameters, status: 'waiting-for-approval', detail: '',
    createdAt: '2026-09-08T00:00:00.000Z', updatedAt: '2026-09-08T00:00:00.000Z',
  }
}

beforeEach(() => { exec.mockReset() })
afterEach(() => vi.restoreAllMocks())

describe('SshSkillAdapter', () => {
  it('proposes only when the skill is granted, a device is granted and the intent matches', () => {
    const adapter = makeAdapter({ listByType: () => [device()], getById: () => device(), secretsForConnection: () => ({ privateKey: 'key' }) }, grantsDevice)
    expect(adapter.propose({ worldId: 'world-1', characterId: 'character-1', prompt: '看看磁盘', grantedSkillIds: [], now: new Date() })).toEqual([])
    // No granted device -> nothing is proposed even with the skill.
    expect(adapter.propose({ worldId: 'world-1', characterId: 'character-2', prompt: '连客厅主机看看磁盘', grantedSkillIds: [SSH_COMMAND_SKILL], now: new Date() })).toEqual([])
    const proposal = adapter.propose({ worldId: 'world-1', characterId: 'character-1', prompt: '连客厅主机看看磁盘', grantedSkillIds: [SSH_COMMAND_SKILL], now: new Date() })[0]!
    expect(proposal).toMatchObject({ skillId: SSH_COMMAND_SKILL, action: 'ssh.disk.usage', risk: 'external-side-effect' })
    expect(proposal.parameters).toMatchObject({ deviceId: 'device-1' })
  })

  it('lets the role own several devices but requires the user to name one', () => {
    const second = { ...device({ displayName: '机房网关' }), id: 'device-2' }
    const adapter = makeAdapter({
      listByType: () => [device(), second], getById: () => device(),
      secretsForConnection: () => ({ privateKey: 'key' }),
    }, () => ['device-1', 'device-2'])
    // Naming one of them resolves.
    const named = adapter.propose({ worldId: 'world-1', characterId: 'character-1', prompt: '看下机房网关的磁盘', grantedSkillIds: [SSH_COMMAND_SKILL], now: new Date() })
    expect(named).toHaveLength(1)
    expect(named[0]!.parameters).toMatchObject({ deviceId: 'device-2' })
    // Bare operation with several devices must not guess.
    expect(adapter.propose({ worldId: 'world-1', characterId: 'character-1', prompt: '看看磁盘', grantedSkillIds: [SSH_COMMAND_SKILL], now: new Date() })).toEqual([])
  })

  it('exposes persona guidance about granted devices and none when nothing is granted', () => {
    const context = (characterId: string) => ({ worldId: 'world-1', characterId, workspaceId: 'workspace-1', grantedSkillIds: [SSH_COMMAND_SKILL] })
    const none = makeAdapter({ listByType: () => [], getById: () => undefined, secretsForConnection: () => undefined }, grantsDevice)
    const note = none.instructionsFor?.(context('character-1'))
    expect(note?.[0]).toContain('没有授权可操作的设备')
    const withDevice = makeAdapter({ listByType: () => [device()], getById: () => device(), secretsForConnection: () => ({ privateKey: 'key' }) }, grantsDevice)
    const note2 = withDevice.instructionsFor?.(context('character-1'))
    expect(note2?.[0]).toContain('客厅主机')
    expect(note2?.[0]).not.toContain('PRIVATE KEY')
    // Skill not granted -> no guidance.
    expect(withDevice.instructionsFor?.({ ...context('character-1'), grantedSkillIds: [] })).toBeUndefined()
  })

  it('preflight requires a configured and enabled device with a credential', async () => {
    const adapter = makeAdapter({ listByType: () => [device()], getById: () => undefined, secretsForConnection: () => undefined }, grantsDevice)
    expect((await adapter.preflight(directAction()))!.ready).toBe(false)
  })

  it('executes a read op through the device and returns the sanitized output', async () => {
    const privateKey = '-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n-----END OPENSSH PRIVATE KEY-----'
    const adapter = makeAdapter({ listByType: () => [device()], getById: () => device(), secretsForConnection: () => ({ privateKey }) }, grantsDevice)
    exec.mockResolvedValueOnce({ code: 0, stdout: 'Linux\nlinux-apt', stderr: '' })
      .mockResolvedValueOnce({ code: 0, stdout: '/dev/sda1  50G  12G  36G  25% /', stderr: '' })
    const result = await adapter.execute(directAction(), { now: new Date() })
    expect(result.status, result.detail).toBe('executed')
    expect(result.detail).toContain('/dev/sda1')
    expect(result.detail).not.toContain('BEGIN OPENSSH')
  })

  it('connects with a stored password when no private key is configured', async () => {
    const adapter = makeAdapter({ listByType: () => [device()], getById: () => device(), secretsForConnection: () => ({ password: 'hunter2' }) }, grantsDevice)
    exec.mockResolvedValueOnce({ code: 0, stdout: 'Linux\nlinux-apt', stderr: '' })
      .mockResolvedValueOnce({ code: 0, stdout: '/dev/sda1  50G  12G  36G  25% /', stderr: '' })
    const result = await adapter.execute(directAction(), { now: new Date() })
    expect(result.status).toBe('executed')
    expect(exec).toHaveBeenCalledTimes(2)
    expect(exec.mock.calls[0]![0]).toMatchObject({ password: 'hunter2' })
    expect(exec.mock.calls[0]![0]).not.toHaveProperty('privateKey')
  })

  it('records the real remote result against that device profile', async () => {
    const recorded: Array<{ signals: readonly { toolName?: string; failed: boolean; exitCode?: number; output?: string }[]; profileId?: string }> = []
    const adapter = new SshSkillAdapter({
      store: { getWorld: () => world() },
      integrations: { listByType: () => [device()], getById: () => device(), secretsForConnection: () => ({ privateKey: 'key' }) } as never,
      connectionGrantsFor: grantsDevice,
      environment: {
        applySignals: async (incoming, profileId) => {
          recorded.push({ signals: incoming, ...(profileId === undefined ? {} : { profileId }) })
        },
      },
    })
    exec.mockResolvedValueOnce({ code: 0, stdout: 'Linux\nlinux-apt', stderr: '' })
      .mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'sh: 1: systemctl: not found' })
    expect((await adapter.execute(directAction(), { now: new Date() })).status).toBe('executed')

    // Only the host-observed result travels, and it is scoped to the device.
    expect(recorded).toHaveLength(1)
    expect(recorded[0]!.profileId).toBe('ssh:device-1')
    expect(recorded[0]!.signals[0]).toMatchObject({
      toolName: 'ssh',
      failed: true,
      exitCode: 1,
      output: expect.stringContaining('systemctl: not found'),
    })
  })

  it('reports refused auth as failed and connection loss as outcome-unknown', async () => {
    const adapter = makeAdapter({ listByType: () => [device()], getById: () => device(), secretsForConnection: () => ({ privateKey: 'key' }) }, grantsDevice)
    exec.mockRejectedValueOnce(new (await import('../src/integrations/ssh-client.js')).SshError('auth-failed', 'permission denied'))
    expect((await adapter.execute(directAction(), { now: new Date() })).status).toBe('failed')
    exec.mockRejectedValueOnce(new (await import('../src/integrations/ssh-client.js')).SshError('timeout', 'timed out'))
    expect((await adapter.execute(directAction(), { now: new Date() })).status).toBe('outcome-unknown')
  })

  it('returns waiting-for-integration when the approved device is gone', async () => {
    const adapter = makeAdapter({ listByType: () => [], getById: () => undefined, secretsForConnection: () => undefined }, grantsDevice)
    const result = await adapter.execute(directAction(), { now: new Date() })
    expect(result.status).toBe('waiting-for-integration')
    expect(exec).not.toHaveBeenCalled()
  })

  it('denies execution when the connection is not in the character connection grants', async () => {
    const adapter = makeAdapter({ listByType: () => [device()], getById: () => device(), secretsForConnection: () => ({ privateKey: 'key' }) }, () => ['device-2'])
    expect((await adapter.preflight(directAction()))!.ready).toBe(false)
    const result = await adapter.execute(directAction(), { now: new Date() })
    expect(result.status).toBe('failed')
    expect(exec).not.toHaveBeenCalled()
  })

  it('blocks all connect use when no grants resolver is wired', async () => {
    const adapter = makeAdapter({ listByType: () => [device()], getById: () => device(), secretsForConnection: () => ({ privateKey: 'key' }) })
    expect((await adapter.preflight(directAction()))!.ready).toBe(false)
    const result = await adapter.execute(directAction(), { now: new Date() })
    expect(result.status).toBe('failed')
    expect(exec).not.toHaveBeenCalled()
  })

  it('routes commands through the shared session pool when one is configured', async () => {
    const pool = new SshSessionPool()
    const adapter = makeAdapter({ listByType: () => [device()], getById: () => device(), secretsForConnection: () => ({ privateKey: 'key' }) }, grantsDevice, pool)
    const run = vi.mocked(pool.exec)
    run.mockResolvedValueOnce({ code: 0, stdout: 'Linux\nlinux-apt', stderr: '' })
      .mockResolvedValueOnce({ code: 0, stdout: '/dev/sda1  50G  12G  36G  25% /', stderr: '' })
    const result = await adapter.execute(directAction(), { now: new Date() })
    expect(result.status).toBe('executed')
    expect(run).toHaveBeenCalledTimes(2)
    expect(exec).not.toHaveBeenCalled()
  })
})

describe('registry persona aggregation', () => {
  it('folds the SSH adapter note into persona guidance together with recipes', async () => {
    const { CharacterSkillAdapterRegistry } = await import('../src/skills/skill-adapter.js')
    const { composeSkillRecipes } = await import('../src/services/character-profile-runtime.js')
    const registry = new CharacterSkillAdapterRegistry()
    registry.registerRecipe({
      descriptor: {
        id: 'test.recipe', displayName: '会议纪要', summary: '整理会议事实。', adapterId: 'builtin.recipe',
        risks: [], supportsScheduling: false, persistentApproval: 'forbidden', kind: 'recipe', recommendedByDefault: true,
      },
      instruction: '会议结束后整理决策、负责人和截止日期。',
    })
    registry.register(new SshSkillAdapter({
      store: { getWorld: () => ({ id: 'world-1', workspaceId: 'workspace-1' }) },
      integrations: {
        listByType: () => [{
          id: 'device-1', workspaceId: 'workspace-1', integrationId: 'builtin.ssh-device', displayName: '客厅主机',
          config: { displayName: '客厅主机', host: '10.0.0.10' }, enabled: true, credentialConfigured: true, createdAt: '', updatedAt: '',
        }],
        secretsForConnection: () => ({ password: 'x' }),
      } as never,
      connectionGrantsFor: () => ['device-1'],
    }))

    const notes = registry.instructionsForCharacter({
      worldId: 'world-1',
      characterId: 'character-1',
      workspaceId: 'workspace-1',
      grantedSkillIds: ['device.ssh.command', 'test.recipe'],
    })
    expect(notes).toHaveLength(2)
    expect(notes.join('\n')).toContain('客厅主机')
    expect(notes.join('\n')).toContain('会议纪要')

    // The persona composer accepts the aggregated instructions unchanged.
    const persona = composeSkillRecipes('你是一位细心管家。', notes)
    expect(persona).toContain('客厅主机')
    expect(persona).toContain('会议纪要')
    expect(persona).toContain('已授权')
  })
})

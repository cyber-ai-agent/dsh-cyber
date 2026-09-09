import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import type { EnvironmentProfile } from '@dsh-cyber/contracts'

import { EnvironmentProfileStore } from '../src/environments/environment-store.js'
import { EnvironmentService } from '../src/environments/environment-service.js'
import {
  buildRemoteProbeCommand,
  parseRemoteProbeOutput,
  probeRemoteEnvironment,
  type EnvironmentDeviceSource,
  type EnvironmentDeviceTarget,
} from '../src/environments/environment-remote.js'

const roots: string[] = []
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cyber-env-remote-'))
  roots.push(root)
  return root
}
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

const CLOCK = () => '2026-08-21T00:00:00.000Z'

function localProfile(overrides: Partial<EnvironmentProfile> = {}): EnvironmentProfile {
  return {
    schemaVersion: 1,
    profileId: 'local',
    os: 'windows',
    arch: 'x64',
    shell: 'powershell',
    tools: { node: { present: true, source: 'builtin', lastCheckedAt: CLOCK(), version: 'v24.18.0' } },
    notes: [],
    probedAt: CLOCK(),
    fastSignature: 'a'.repeat(32),
    fullDirty: false,
    ...overrides,
  }
}

describe('remote probe command', () => {
  it('batches every tool into one compound command and interpolates only fixed constants', () => {
    const fast = buildRemoteProbeCommand('fast')
    expect(fast).toContain('uname -s')
    expect(fast).toContain('command -v node >/dev/null 2>&1')
    expect(fast).not.toContain('--version')
    // One command, not one per tool: `sshExecOnce` opens a connection per call.
    expect(fast.split(';').length).toBeGreaterThan(30)

    const full = buildRemoteProbeCommand('full')
    expect(full).toContain('printf "V:node=%s\\n" "$(node -v 2>&1 | head -n 1)"')
  })
})

describe('remote probe parsing', () => {
  it('reads the marker lines and normalizes versions', () => {
    const facts = parseRemoteProbeOutput([
      'OS:Linux',
      'ARCH:x86_64',
      'SHELL:/bin/bash',
      'T:node=1',
      'V:node=v20.11.1',
      'T:docker=0',
      'T:git=1',
      'V:git=git version 2.45.1',
      'garbage line',
      'T:broken=maybe',
    ].join('\n'))
    expect(facts.os).toBe('linux')
    expect(facts.arch).toBe('x86_64')
    expect(facts.shell).toBe('bash')
    expect(facts.tools.node).toEqual({ present: true, version: 'v20.11.1' })
    expect(facts.tools.git).toEqual({ present: true, version: '2.45.1' })
    expect(facts.tools.docker).toEqual({ present: false })
    expect(facts.tools.broken).toBeUndefined()
  })

  it('never guesses an operating system it cannot name', () => {
    // Windows over SSH answers without `uname`; the contract's os is a fact.
    const facts = parseRemoteProbeOutput('ARCH:AMD64\r\nSHELL:C:\\Windows\\System32\\cmd.exe\r\nT:node=1')
    expect(facts.os).toBeUndefined()
    expect(facts.shell).toBe('cmd.exe')
  })
})

describe('remote profile', () => {
  it('probes one device through the injected transport and marks fast results dirty', async () => {
    const commands: string[] = []
    const profile = await probeRemoteEnvironment({
      profileId: 'ssh:device-1',
      tier: 'fast',
      clock: CLOCK,
      exec: async (command) => {
        commands.push(command)
        return { code: 0, stdout: 'OS:Linux\nARCH:aarch64\nSHELL:/bin/zsh\nT:node=1\nT:docker=0\n', stderr: '' }
      },
    })
    expect(commands).toHaveLength(1)
    expect(profile?.profileId).toBe('ssh:device-1')
    expect(profile?.os).toBe('linux')
    expect(profile?.shell).toBe('zsh')
    expect(profile?.tools.node).toMatchObject({ present: true, source: 'builtin' })
    expect(profile?.tools.docker?.present).toBe(false)
    expect(profile?.fullDirty).toBe(true)
    expect(profile?.fastSignature).toMatch(/^[0-9a-f]{32}$/)
  })

  it('returns no profile at all when the host cannot be described', async () => {
    const profile = await probeRemoteEnvironment({
      profileId: 'ssh:windows',
      tier: 'fast',
      exec: async () => ({ code: 0, stdout: 'T:node=1\n', stderr: '' }),
    })
    expect(profile).toBeUndefined()
  })
})

describe('device profiles in the service', () => {
  function deviceTarget(profileId = 'ssh:device-1'): EnvironmentDeviceTarget {
    return {
      profileId,
      displayName: '生产机',
      host: '10.0.0.5',
      exec: async () => ({ code: 0, stdout: 'OS:Linux\nARCH:x86_64\nSHELL:/bin/bash\nT:node=1\n', stderr: '' }),
    }
  }

  it('stores a device profile keyed by its connection, preserving learned notes', async () => {
    const store = new EnvironmentProfileStore(tempRoot())
    const service = new EnvironmentService(store, { clock: CLOCK, probe: async () => localProfile() })
    await service.refreshLocal('full')

    const first = await service.refreshDevice(deviceTarget(), 'full')
    expect(first?.profileId).toBe('ssh:device-1')
    expect(service.profile('ssh:device-1')?.os).toBe('linux')

    // A note learned from that device survives the next refresh.
    const stored = service.profile('ssh:device-1')!
    await store.save({ ...stored, notes: [{ id: 'n1', text: 'systemctl 受限制：权限被拒绝（EPERM）', source: 'failure-signature', createdAt: CLOCK() }] })
    await service.refreshDevice(deviceTarget(), 'full')
    expect(service.profile('ssh:device-1')?.notes.map((note) => note.id)).toEqual(['n1'])
  })

  it('injects a device block only for a granted device that already has a profile', async () => {
    const store = new EnvironmentProfileStore(tempRoot())
    const granted: EnvironmentDeviceTarget[] = [deviceTarget()]
    const devices: EnvironmentDeviceSource = { targets: async () => granted }
    const service = new EnvironmentService(store, { clock: CLOCK, probe: async () => localProfile(), devices })
    await service.refreshLocal('full')

    // Granted but never probed: no SSH round trip inside a turn, no block.
    const before = await service.snapshot({ worldId: 'world-1', characterId: 'character-1' })
    expect(before?.layer.text).toContain('[本机环境档案]')
    expect(before?.layer.text).not.toContain('[设备档案')

    await service.refreshDevice(deviceTarget(), 'full')
    const after = await service.snapshot({ worldId: 'world-1', characterId: 'character-1' })
    expect(after?.layer.text).toContain('[设备档案 生产机 (10.0.0.5)]')
    expect(after?.layer.sourceRefs.map((ref) => ref.id)).toEqual(['local', 'ssh:device-1'])

    // Revoking the grant removes the block from the very next turn.
    granted.length = 0
    const revoked = await service.snapshot({ worldId: 'world-1', characterId: 'character-1' })
    expect(revoked?.layer.text).not.toContain('[设备档案')
  })

  it('learns a device fact through a device-scoped signal', async () => {
    const service = new EnvironmentService(new EnvironmentProfileStore(tempRoot()), {
      clock: CLOCK,
      probe: async () => localProfile(),
      probeDevice: async (target) => probeRemoteEnvironment({
        profileId: target.profileId,
        tier: 'full',
        clock: CLOCK,
        exec: async () => ({ code: 0, stdout: 'OS:Linux\nARCH:x86_64\nSHELL:/bin/bash\nT:docker=1\nV:docker=27.0.0\n', stderr: '' }),
      }),
    })
    await service.refreshLocal('full')
    await service.refreshDevice(deviceTarget(), 'full')

    const changed = await service.applySignals([{
      toolName: 'ssh',
      command: 'docker ps',
      failed: true,
      exitCode: 1,
      output: 'docker: command not found',
    }], 'ssh:device-1')

    expect(changed).toBe(true)
    expect(service.profile('ssh:device-1')?.tools.docker?.present).toBe(false)
    expect(service.profile('ssh:device-1')?.notes.map((note) => note.text)).toEqual(['docker 在本机不可用：命令未找到'])
    // The local profile is untouched by a device fact.
    expect(service.currentLocal()?.tools.docker).toBeUndefined()
  })
})

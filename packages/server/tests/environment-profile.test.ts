import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { estimateTextTokens, type EnvironmentProfile } from '@dsh-cyber/contracts'

import {
  BUILTIN_ENVIRONMENT_TOOLS,
  normalizeVersionLine,
  probeLocalEnvironment,
  resolveToolPresence,
  resolveTools,
} from '../src/environments/environment-probe.js'
import { composeEnvironmentLayer, ENVIRONMENT_LAYER_INSTRUCTION } from '../src/environments/environment-context-layer.js'
import { presenceSignature } from '../src/environments/environment-change-collector.js'
import { EnvironmentProfileStore } from '../src/environments/environment-store.js'
import { EnvironmentService } from '../src/environments/environment-service.js'

const roots: string[] = []
function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), `dsh-cyber-env-${prefix}-`))
  roots.push(root)
  return root
}
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function fixtureProfile(overrides: Partial<EnvironmentProfile> = {}): EnvironmentProfile {
  const tools: EnvironmentProfile['tools'] = {}
  for (const probe of BUILTIN_ENVIRONMENT_TOOLS) {
    tools[probe.name] = { present: false, source: 'builtin', lastCheckedAt: '2026-08-21T00:00:00.000Z' }
  }
  tools.node = { present: true, source: 'builtin', lastCheckedAt: '2026-08-21T00:00:00.000Z', version: 'v20.11.1' }
  tools.pnpm = { present: true, source: 'builtin', lastCheckedAt: '2026-08-21T00:00:00.000Z', version: '11.7.0' }
  tools.git = { present: true, source: 'builtin', lastCheckedAt: '2026-08-21T00:00:00.000Z', version: '2.45.0' }
  return {
    schemaVersion: 1,
    profileId: 'local',
    os: 'windows',
    arch: 'x64',
    shell: 'pwsh',
    tools,
    notes: [],
    probedAt: '2026-08-21T00:00:00.000Z',
    fastSignature: 'c'.repeat(32),
    fullDirty: false,
    ...overrides,
  }
}

describe('environment probe', () => {
  it('answers presence from the PATH scan without shelling out', () => {
    const root = tempRoot('presence')
    mkdirSync(join(root, 'bin'), { recursive: true })
    writeFileSync(join(root, 'bin', 'node.exe'), '')
    writeFileSync(join(root, 'bin', 'pnpm'), '')
    writeFileSync(join(root, 'bin', 'docker.cmd'), '')
    const found = resolveToolPresence(['node', 'pnpm', 'docker', 'gh'], [join(root, 'bin')], 'win32')
    expect([...found].sort()).toEqual(['docker', 'node', 'pnpm'])
  })

  it('spawns nothing at the fast tier, which is the one that may run inside a turn', async () => {
    const seen: string[] = []
    const root = tempRoot('fast-tier')
    const bin = join(root, 'bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'git.exe'), '')
    const profile = await probeLocalEnvironment({
      platform: 'win32',
      arch: 'x64',
      pathEntries: [bin],
      tier: 'fast',
      clock: () => '2026-08-21T00:00:00.000Z',
      runVersionProbe: async (tool: { name: string }) => {
        seen.push(tool.name)
        return 'should never run'
      },
    })
    expect(seen).toEqual([])
    expect(profile.tools.git?.present).toBe(true)
    expect(profile.tools.git?.version).toBeUndefined()
  })

  it('resolves the launch shape so Windows shims stay runnable', () => {
    const root = tempRoot('shims')
    const bin = join(root, 'bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'npm.cmd'), '')
    writeFileSync(join(bin, 'node.exe'), '')
    writeFileSync(join(bin, 'node'), '')
    const tools = resolveTools(['npm', 'node', 'pnpm'], [bin], 'win32')
    // Node cannot exec a .cmd directly; the version probe has to know that.
    expect(tools.get('npm')).toMatchObject({ kind: 'cmd' })
    // A real executable wins over the extensionless POSIX script beside it.
    expect(tools.get('node')).toMatchObject({ kind: 'exe' })
    expect(tools.has('pnpm')).toBe(false)
  })

  it('normalizes raw version lines into a short fact', () => {
    expect(normalizeVersionLine('git', 'git version 2.45.1.windows.1')).toBe('2.45.1')
    expect(normalizeVersionLine('node', 'v24.18.0')).toBe('v24.18.0')
    expect(normalizeVersionLine('pip', 'pip 26.2.1 from C:\\Python314\\Lib\\site-packages\\pip (python 3.14)')).toBe('26.2.1')
    expect(normalizeVersionLine('rg', 'ripgrep 14.1.0 (rev e50df40a19)')).toBe('14.1.0')
    // A tool that prints no dotted version keeps a bounded, readable line.
    expect(normalizeVersionLine('custom', 'custom build 2026')).toBe('build 2026')
  })

  it('is deterministic: same PATH, same clock, same profile', async () => {
    const root = tempRoot('determinism')
    const bin = join(root, 'bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'node.exe'), '')
    const deps = {
      platform: 'win32' as const,
      arch: 'x64',
      pathEntries: [bin],
      clock: () => '2026-08-21T00:00:00.000Z',
      runVersionProbe: async (tool: { name: string }) => tool.name === 'node' ? 'v20.11.1' : undefined,
    }
    const first = await probeLocalEnvironment(deps)
    const second = await probeLocalEnvironment(deps)
    expect(first).toEqual(second)
    expect(first.tools.node).toEqual({ present: true, source: 'builtin', lastCheckedAt: '2026-08-21T00:00:00.000Z', version: 'v20.11.1' })
    expect(first.tools.pnpm?.present).toBe(false)
    expect(first.shell).toBe('cmd')
    expect(first.fastSignature).toMatch(/^[0-9a-f]{32}$/)
  })

  it('runs version probes only for tools the PATH scan found', async () => {
    const seen: string[] = []
    const root = tempRoot('versions')
    const bin = join(root, 'bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'git.exe'), '')
    const profile = await probeLocalEnvironment({
      platform: 'win32',
      arch: 'x64',
      pathEntries: [bin],
      clock: () => '2026-08-21T00:00:00.000Z',
      runVersionProbe: async (tool: { name: string }) => {
        seen.push(tool.name)
        return tool.name === 'git' ? 'git version 2.45.0' : undefined
      },
    })
    expect(seen).toEqual(['git'])
    expect(profile.tools.git?.version).toBe('2.45.0')
  })
})

describe('environment store', () => {
  it('round-trips a profile and treats corrupt data as absent', async () => {
    const root = tempRoot('store')
    const store = new EnvironmentProfileStore(root)
    expect(store.load('local')).toBeUndefined()

    const profile = fixtureProfile()
    await store.save(profile)
    expect(store.load('local')).toEqual(profile)

    writeFileSync(join(root, 'environments', 'local.json'), '{not json')
    expect(store.load('local')).toBeUndefined()
  })
})

describe('environment context layer', () => {
  it('renders a deterministic text: same profile content, same text and revision', () => {
    const first = composeEnvironmentLayer(fixtureProfile())
    const repinned = composeEnvironmentLayer(fixtureProfile({
      probedAt: '2027-01-01T00:00:00.000Z',
      fastSignature: 'd'.repeat(32),
    }))
    expect(first.text).toBe(repinned.text)
    expect(first.revision).toBe(repinned.revision)
    expect(first.kind).toBe('environment')
    expect(first.sourceRefs).toEqual([{ kind: 'environment', id: 'local', revision: 'c'.repeat(32) }])
    // Refresh metadata never leaks into the rendered text.
    expect(first.text).not.toContain('2026-08-21')
    expect(first.text).not.toContain('2027-01-01')
  })

  it('lists installed tools with versions, the missing list, and the live-check instruction', () => {
    const layer = composeEnvironmentLayer(fixtureProfile({
      notes: [{ id: 'a1', text: 'docker 命令不可用：未安装', source: 'probe', createdAt: '2026-08-21T00:00:00.000Z' }],
    }))
    expect(layer.text).toContain('系统: Windows x64 · shell: pwsh')
    expect(layer.text).toContain('git 2.45.0')
    expect(layer.text).toContain('未安装:')
    expect(layer.text).toContain('- docker 命令不可用：未安装')
    expect(layer.text.endsWith(ENVIRONMENT_LAYER_INSTRUCTION)).toBe(true)
  })

  it('degrades deterministically under a tight budget and always keeps the instruction', () => {
    const layer = composeEnvironmentLayer(fixtureProfile({
      notes: Array.from({ length: 6 }, (_, index) => ({
        id: `n${index}`,
        text: `宿主归纳的环境限制第 ${index} 条，命令不可用或行为异常。`,
        source: 'failure-signature',
        createdAt: '2026-08-21T00:00:00.000Z',
      })),
    }), { budgetTokens: 60 })
    expect(estimateTextTokens(layer.text)).toBeLessThanOrEqual(60)
    expect(layer.text).toContain(ENVIRONMENT_LAYER_INSTRUCTION)
    expect(layer.text).toContain('系统: Windows x64 · shell: pwsh')
    expect(layer.text).not.toContain('git 2.45.0')
    expect(layer.text).not.toContain('未安装:')
    expect(layer.text).not.toContain('注意事项:')
  })

  it('fits inside the default 300 token budget for the full battery', () => {
    const layer = composeEnvironmentLayer(fixtureProfile())
    expect(layer.tokenEstimate).toBeLessThanOrEqual(300)
  })
})

describe('environment service', () => {
  it('probes at a conversation boundary only, and only when the profile is owed one', async () => {
    const root = tempRoot('lazy')
    const tiers: string[] = []
    const service = new EnvironmentService(new EnvironmentProfileStore(root), {
      clock: () => '2026-08-21T00:00:00.000Z',
      probe: async (tier) => {
        tiers.push(tier)
        return fixtureProfile()
      },
    })
    expect(service.currentLocal()).toBeUndefined()

    const first = await service.snapshot({ worldId: 'world-1', characterId: 'character-1', laneBoundary: true })
    // A live turn may only run the tier that spawns nothing.
    expect(tiers).toEqual(['fast'])
    expect(first?.layer.kind).toBe('environment')
    expect(first?.present).toContain('node')
    // A brand-new profile has never read a version, so the next boundary owes one.
    expect(service.currentLocal()?.fullDirty).toBe(true)

    await service.snapshot({ worldId: 'world-1', characterId: 'character-1', laneBoundary: true })
    expect(tiers).toEqual(['fast', 'full'])
    expect(service.currentLocal()?.fullDirty).toBe(false)

    // Settled and fresh: a boundary reads the stored profile instead of probing.
    await service.snapshot({ worldId: 'world-1', characterId: 'character-1', laneBoundary: true })
    expect(tiers).toEqual(['fast', 'full'])
  })

  it('never probes mid-lane, even when the stored profile is owed a refresh', async () => {
    const root = tempRoot('mid-lane')
    const store = new EnvironmentProfileStore(root)
    const tiers: string[] = []
    const service = new EnvironmentService(store, {
      clock: () => '2026-08-21T12:00:00.000Z',
      probe: async (tier) => {
        tiers.push(tier)
        return fixtureProfile()
      },
    })
    await store.save(fixtureProfile({ probedAt: '2026-08-20T00:00:00.000Z', fullDirty: true }))

    const mid = await service.snapshot({ worldId: 'world-1', characterId: 'character-1', laneBoundary: false })
    expect(tiers).toEqual([])
    expect(mid?.layer.text).toContain('[本机环境档案]')
  })

  it('re-probes presence after the fast TTL and versions after a day', async () => {
    const root = tempRoot('ttl')
    const store = new EnvironmentProfileStore(root)
    const tiers: string[] = []
    let now = '2026-08-21T12:00:00.000Z'
    const service = new EnvironmentService(store, {
      clock: () => now,
      probe: async (tier) => {
        tiers.push(tier)
        return fixtureProfile({ probedAt: now, fullDirty: false })
      },
    })
    await store.save(fixtureProfile({ probedAt: '2026-08-21T11:00:00.000Z', fullDirty: false }))

    // One hour of drift: presence is worth a free re-scan, versions are not.
    await service.snapshot({ worldId: 'world-1', characterId: 'character-1', laneBoundary: true })
    expect(tiers).toEqual(['fast'])

    // A day of drift: the version battery is owed.
    now = '2026-08-22T20:00:00.000Z'
    await service.snapshot({ worldId: 'world-1', characterId: 'character-1', laneBoundary: true })
    expect(tiers).toEqual(['fast', 'full'])
  })

  it('keeps a learned version across a fast refresh and clears the full-refresh debt on a full one', async () => {
    const root = tempRoot('tiers')
    const store = new EnvironmentProfileStore(root)
    // The fast tier cannot re-derive versions; it must not erase them either.
    const presenceOnly = () => {
      const tools: EnvironmentProfile['tools'] = {}
      for (const [name, tool] of Object.entries(fixtureProfile().tools)) {
        tools[name] = { present: tool.present, source: tool.source, lastCheckedAt: tool.lastCheckedAt }
      }
      return fixtureProfile({ tools })
    }
    const service = new EnvironmentService(store, {
      probe: async (tier) => tier === 'full' ? fixtureProfile() : presenceOnly(),
    })
    await service.refreshLocal('full')
    expect(service.currentLocal()?.fullDirty).toBe(false)

    // Presence is unchanged, so a fast refresh costs no version debt.
    await service.refreshLocal('fast')
    const afterFast = service.currentLocal()!
    expect(afterFast.fullDirty).toBe(false)
    expect(afterFast.tools.node?.version).toBe('v20.11.1')

    // A presence change does take the debt on.
    const changedTools = { ...presenceOnly().tools }
    changedTools.ffmpeg = { present: true, source: 'builtin', lastCheckedAt: '2026-08-21T00:00:00.000Z' }
    const changed = fixtureProfile({ tools: changedTools, fastSignature: presenceSignature(changedTools) })
    const serviceWithChange = new EnvironmentService(store, { probe: async () => changed })
    await serviceWithChange.refreshLocal('fast')
    expect(serviceWithChange.currentLocal()?.fullDirty).toBe(true)
    await serviceWithChange.refreshLocal('full')
    expect(serviceWithChange.currentLocal()?.fullDirty).toBe(false)
  })

  it('leaves the prompt untouched when the probe fails, and keeps what the host already knew', async () => {
    const root = tempRoot('probe-failure')
    const store = new EnvironmentProfileStore(root)
    let failing = true
    const service = new EnvironmentService(store, {
      clock: () => '2026-08-21T00:00:00.000Z',
      probe: async () => {
        if (failing) throw new Error('探测失败')
        return fixtureProfile()
      },
    })
    await expect(service.snapshot({ worldId: 'world-1', characterId: 'character-1', laneBoundary: true })).resolves.toBeUndefined()
    expect(service.currentLocal()).toBeUndefined()

    // Once a profile exists, a failing boundary probe must not erase it.
    failing = false
    await service.snapshot({ worldId: 'world-1', characterId: 'character-1', laneBoundary: true })
    const stored = service.currentLocal()!
    failing = true
    await store.save({ ...stored, probedAt: '2026-08-19T00:00:00.000Z' })
    const stillThere = await service.snapshot({ worldId: 'world-1', characterId: 'character-1', laneBoundary: true })
    expect(stillThere?.layer.text).toContain('[本机环境档案]')
    expect(service.currentLocal()?.probedAt).toBe('2026-08-19T00:00:00.000Z')
  })

  it('preserves learned notes across refreshes', async () => {
    const root = tempRoot('service')
    const store = new EnvironmentProfileStore(root)
    const service = new EnvironmentService(store, {
      probe: async () => fixtureProfile({ notes: [] }),
    })
    const probed = await service.refreshLocal()
    expect(probed.notes).toHaveLength(0)

    // Learned knowledge survives a refresh: it is host data, not probe fact.
    const existing = store.load('local')!
    existing.notes = [{ id: 'k1', text: 'rg 在此机器上被沙箱限制', source: 'failure-signature', createdAt: '2026-08-21T00:00:00.000Z' }]
    await store.save(existing)

    await service.refreshLocal()
    expect(service.currentLocal()?.notes.map((note) => note.id)).toEqual(['k1'])
  })

  it('exposes the cache-stable layer through the context port', async () => {
    const root = tempRoot('port')
    const service = new EnvironmentService(new EnvironmentProfileStore(root), {
      probe: async () => fixtureProfile(),
    })
    await service.refreshLocal()
    const snapshot = await service.snapshot({ worldId: 'world-1', characterId: 'character-1' })
    expect(snapshot?.layer.kind).toBe('environment')
    expect(snapshot?.layer.text).toContain('[本机环境档案]')
    expect(snapshot?.present).toEqual(['git', 'node', 'pnpm'])
  })

  it('keeps an owner-added tool through a full refresh', async () => {
    const root = tempRoot('custom-survives')
    const bin = join(root, 'bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'mytool.exe'), '')
    const service = new EnvironmentService(new EnvironmentProfileStore(root), {
      probeDeps: {
        platform: 'win32',
        arch: 'x64',
        pathEntries: [bin],
        clock: () => '2026-08-21T00:00:00.000Z',
        runVersionProbe: async (tool: { name: string }) => tool.name === 'mytool' ? 'mytool 1.2.3' : undefined,
      },
      probeCustomTool: async () => ({ present: true, version: '1.2.3' }),
      clock: () => '2026-08-21T00:00:00.000Z',
    })
    await service.refreshLocal('full')
    await service.addCustomTool('mytool')
    expect(service.currentLocal()?.tools.mytool).toMatchObject({ present: true, source: 'custom', version: '1.2.3' })

    // A refresh that forgot custom names would silently delete the entry.
    await service.refreshLocal('full')
    expect(service.currentLocal()?.tools.mytool).toMatchObject({ present: true, source: 'custom', version: '1.2.3' })

    await service.removeCustomTool('mytool')
    expect(service.currentLocal()?.tools.mytool).toBeUndefined()
    await expect(service.removeCustomTool('node')).rejects.toThrow('只能删除自定义工具')
  })

  it('persists what host traffic taught, and reports whether anything changed', async () => {
    const root = tempRoot('signals')
    const service = new EnvironmentService(new EnvironmentProfileStore(root), {
      probe: async () => fixtureProfile(),
      clock: () => '2026-08-21T00:00:00.000Z',
    })
    await service.refreshLocal()

    // Nothing learned yet: no write, no change.
    expect(await service.applySignals([])).toBe(false)
    expect(await service.applySignals([{ toolName: 'pwsh', command: 'node -v', failed: false }])).toBe(false)

    // The profile called ffmpeg absent, and it just ran.
    expect(await service.applySignals([{ toolName: 'pwsh', command: 'ffmpeg -version', failed: false }])).toBe(true)
    expect(service.currentLocal()?.tools.ffmpeg?.present).toBe(true)
    expect(service.currentLocal()?.fullDirty).toBe(true)

    // The same lesson twice is not a second change.
    expect(await service.applySignals([{ toolName: 'pwsh', command: 'ffmpeg -version', failed: false }])).toBe(false)
  })
})

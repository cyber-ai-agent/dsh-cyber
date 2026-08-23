import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { EmployeeBlueprint } from '@dsh-cyber/contracts'
import type { CharacterSkillAction, CharacterSkillDescriptor } from '@dsh-cyber/contracts/skill-runtime'
import { SqliteStore } from '@dsh-cyber/persistence'

import { CharacterSkillRuntime } from '../src/services/character-skill-runtime.js'
import { LocalSkillActionRepository } from '../src/skills/local-skill-action-repository.js'
import {
  CharacterSkillAdapterRegistry,
  type CharacterSkillAdapter,
  type CharacterSkillMatchContext,
} from '../src/skills/skill-adapter.js'

const roots: string[] = []
const stores: SqliteStore[] = []

afterEach(async () => {
  for (const store of stores.splice(0)) store.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('CharacterSkillAdapterRegistry', () => {
  it('keeps providers replaceable and rejects ambiguous skill ownership', () => {
    const registry = new CharacterSkillAdapterRegistry()
    registry.register(new TestAdapter())
    expect(registry.list().map((item) => item.id)).toEqual(['test.echo'])
    expect(() => registry.register(new TestAdapter('another-adapter'))).toThrow('Duplicate skill provider: test.echo')
  })
})

describe('CharacterSkillRuntime', () => {
  it('does not install provider adapters on its own', async () => {
    const { store, root } = await setup([])
    const registry = new CharacterSkillAdapterRegistry()
    const runtime = makeRuntime(store, root, registry)

    expect(runtime.listDescriptors()).toEqual([])
  })

  it('executes an authorized skill through a registered adapter and persists only structured facts', async () => {
    const { store, root, worldId, employeeId } = await setup(['test.echo'])
    const adapter = new TestAdapter()
    const registry = new CharacterSkillAdapterRegistry()
    registry.register(adapter)
    const runtime = makeRuntime(store, root, registry)

    const result = await runtime.prepare(worldId, employeeId, '请执行 echo', new Date('2026-08-23T08:00:00.000Z'))

    expect(result.handled).toBe(true)
    expect(result.actions).toHaveLength(1)
    expect(result.actions[0]).toMatchObject({
      skillId: 'test.echo',
      adapterId: 'test-adapter',
      action: 'echo.run',
      risk: 'write-local',
      authorization: 'explicit-user-request',
      status: 'executed',
      parameters: { text: 'echo' },
    })
    expect(adapter.executed).toBe(1)
    expect(await runtime.list(worldId)).toEqual(result.actions)
  })

  it('never executes a skill that the character did not receive as a grant', async () => {
    const { store, root, worldId, employeeId } = await setup([])
    const adapter = new TestAdapter()
    const registry = new CharacterSkillAdapterRegistry()
    registry.register(adapter)
    const runtime = makeRuntime(store, root, registry)

    const result = await runtime.prepare(worldId, employeeId, '请执行 echo')

    expect(result).toEqual({ handled: false, actions: [] })
    expect(adapter.executed).toBe(0)
  })

  it('rechecks grants before a scheduled side effect executes', async () => {
    const { store, root, worldId, employeeId } = await setup(['test.echo'])
    const adapter = new TestAdapter('test-adapter', '2026-08-23T09:00:00.000Z')
    const registry = new CharacterSkillAdapterRegistry()
    registry.register(adapter)
    const runtime = makeRuntime(store, root, registry)

    const prepared = await runtime.prepare(worldId, employeeId, '请执行 echo', new Date('2026-08-23T08:00:00.000Z'))
    expect(prepared.actions[0]?.status).toBe('scheduled')

    store.reviseEmployee({
      employeeId,
      skillGrants: [],
      reason: 'owner-revoked-skill',
      actorId: 'owner',
    })
    await runtime.tick(new Date('2026-08-23T09:01:00.000Z'))

    expect((await runtime.list(worldId))[0]).toMatchObject({
      status: 'failed',
      detail: '计划执行前角色已不可用或技能授权已撤销',
    })
    expect(adapter.executed).toBe(0)
  })

  it('reserves an immediate side effect before adapter execution and deduplicates concurrent requests', async () => {
    const { store, root, worldId, employeeId } = await setup(['test.echo'])
    const adapter = new TestAdapter()
    const registry = new CharacterSkillAdapterRegistry()
    registry.register(adapter)
    const runtime = makeRuntime(store, root, registry)
    const now = new Date('2026-08-23T08:00:00.000Z')

    const [left, right] = await Promise.all([
      runtime.prepare(worldId, employeeId, '请执行 echo', now),
      runtime.prepare(worldId, employeeId, '请执行 echo', now),
    ])

    expect(left.handled).toBe(true)
    expect(right.handled).toBe(true)
    expect(left.actions[0]?.id).toBe(right.actions[0]?.id)
    expect(adapter.executed).toBe(1)
    expect(await runtime.list(worldId)).toHaveLength(1)
  })

  it('persists adapter exceptions as outcome-unknown instead of a retryable failure', async () => {
    const { store, root, worldId, employeeId } = await setup(['test.echo'])
    const registry = new CharacterSkillAdapterRegistry()
    registry.register(new ThrowingAdapter())
    const runtime = makeRuntime(store, root, registry)

    const result = await runtime.prepare(worldId, employeeId, '请执行 echo', new Date('2026-08-23T08:00:00.000Z'))

    expect(result.actions[0]).toMatchObject({
      status: 'outcome-unknown',
      detail: '技能适配器执行过程异常，外部动作结果未知；不得自动重试',
    })
    expect((await runtime.list(worldId))[0]).toMatchObject({ status: 'outcome-unknown' })
  })
})

class TestAdapter implements CharacterSkillAdapter {
  readonly descriptors: readonly CharacterSkillDescriptor[]
  executed = 0

  constructor(readonly id = 'test-adapter', readonly scheduledFor?: string) {
    this.descriptors = descriptor(id)
  }

  propose(context: CharacterSkillMatchContext) {
    if (!context.prompt.includes('echo')) return []
    return proposal(this.id, this.scheduledFor)
  }

  async execute(action: CharacterSkillAction) {
    this.executed += 1
    expect(action.parameters).toEqual({ text: 'echo' })
    return { status: 'executed' as const, detail: '测试动作已执行' }
  }
}

class ThrowingAdapter implements CharacterSkillAdapter {
  readonly id = 'test-adapter'
  readonly descriptors = descriptor(this.id)

  propose(context: CharacterSkillMatchContext) {
    return context.prompt.includes('echo') ? proposal(this.id) : []
  }

  async execute(): Promise<never> {
    throw new Error('transport disappeared after dispatch')
  }
}

function descriptor(adapterId: string): readonly CharacterSkillDescriptor[] {
  return [{
    id: 'test.echo',
    displayName: '测试技能',
    summary: '测试注册表与授权边界。',
    adapterId,
    risks: ['write-local'],
    supportsScheduling: true,
  }]
}

function proposal(adapterId: string, scheduledFor?: string) {
  return [{
    skillId: 'test.echo',
    adapterId,
    action: 'echo.run',
    target: 'local-test',
    label: '执行测试动作',
    risk: 'write-local' as const,
    authorization: 'explicit-user-request' as const,
    parameters: { text: 'echo' },
    ...(scheduledFor === undefined ? {} : { scheduledFor }),
  }]
}

function makeRuntime(
  store: SqliteStore,
  root: string,
  registry: CharacterSkillAdapterRegistry,
): CharacterSkillRuntime {
  return new CharacterSkillRuntime(store, {
    registry,
    actions: new LocalSkillActionRepository(join(root, 'skills', 'actions.json')),
  })
}

async function setup(skillGrants: string[]) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-skill-runtime-'))
  roots.push(root)
  const store = await SqliteStore.open(join(root, 'data', 'dsh-cyber.sqlite'))
  stores.push(store)
  const workspace = store.createWorkspace({ name: '测试工作区' })
  const world = store.createWorld({ workspaceId: workspace.id, name: '测试世界', templateId: 'personal-world' })
  const blueprint: EmployeeBlueprint = {
    schemaVersion: 1,
    id: 'test.skill-worker',
    version: 1,
    worldTemplateId: 'personal-world',
    displayName: '测试员工',
    role: '测试员',
    summary: '用于 Skill Runtime 测试。',
    persona: '执行受控测试技能。',
    requestedSkills: ['test.echo'],
    requestedCapabilities: [],
    createdAt: '2026-08-23T00:00:00.000Z',
  }
  store.saveBlueprint(blueprint)
  const employee = store.recruitEmployee({
    workspaceId: workspace.id,
    worldId: world.id,
    blueprintId: blueprint.id,
    blueprintVersion: blueprint.version,
    skillGrants,
  })
  return { root, store, worldId: world.id, employeeId: employee.id }
}

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { CharacterSkillAction } from '@dsh-cyber/contracts/skill-runtime'

import { LocalSkillActionRepository } from '../src/skills/local-skill-action-repository.js'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('LocalSkillActionRepository', () => {
  it('atomically reserves one action for concurrent equivalent requests', async () => {
    const { repository } = await setup()
    const action = sampleAction()

    const [left, right] = await Promise.all([
      repository.reserve(action, 60_000),
      repository.reserve({ ...action, id: 'action-2' }, 60_000),
    ])

    expect([left.created, right.created].sort()).toEqual([false, true])
    expect(left.action.id).toBe(right.action.id)
    expect(await repository.listByWorld(action.worldId)).toHaveLength(1)
  })

  it('persists status updates and returns only due scheduled actions', async () => {
    const { repository } = await setup()
    const scheduled = {
      ...sampleAction(),
      id: 'scheduled-1',
      status: 'scheduled' as const,
      scheduledFor: '2026-08-23T10:00:00.000Z',
    }
    await repository.reserve(scheduled, 60_000)

    expect(await repository.listDue(new Date('2026-08-23T09:59:59.000Z'))).toEqual([])
    expect((await repository.listDue(new Date('2026-08-23T10:00:01.000Z')))[0]?.id).toBe(scheduled.id)

    const completed = { ...scheduled, status: 'executed' as const, detail: 'done', updatedAt: '2026-08-23T10:00:01.000Z' }
    await repository.save(completed)
    expect(await repository.listDue(new Date('2026-08-23T11:00:00.000Z'))).toEqual([])
    expect((await repository.listByWorld(scheduled.worldId))[0]).toMatchObject({ status: 'executed', detail: 'done' })
  })

  it('reads the legacy v1 local action format without losing scheduled work', async () => {
    const { path, repository } = await setup()
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify({
      version: 1,
      actions: [{
        id: 'legacy-action',
        worldId: 'world-1',
        characterId: 'character-1',
        skillId: 'smart-home.control',
        action: 'climate.turn_on',
        target: 'air-conditioner',
        scheduledFor: '2026-08-23T10:00:00.000Z',
        status: 'scheduled',
        detail: 'legacy scheduled action',
        createdAt: '2026-08-23T08:00:00.000Z',
        updatedAt: '2026-08-23T08:00:00.000Z',
      }],
    }, null, 2))

    const restored = await repository.listByWorld('world-1')
    expect(restored[0]).toMatchObject({
      id: 'legacy-action',
      adapterId: 'legacy.smart-home.control',
      risk: 'external-side-effect',
      authorization: 'explicit-user-request',
      parameters: {},
      status: 'scheduled',
    })
  })

  it('fails closed on an unknown store version instead of silently resetting user actions', async () => {
    const { path, repository } = await setup()
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, '{"version":99,"actions":[]}\n')

    await expect(repository.listByWorld('world-1')).rejects.toThrow('Unsupported Skill action store version: 99')
  })
})

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-skill-actions-'))
  roots.push(root)
  const path = join(root, 'skills', 'actions.json')
  return { root, path, repository: new LocalSkillActionRepository(path) }
}

function sampleAction(): CharacterSkillAction {
  return {
    id: 'action-1',
    worldId: 'world-1',
    characterId: 'character-1',
    skillId: 'test.echo',
    adapterId: 'test-adapter',
    action: 'echo.run',
    target: 'local-test',
    label: '执行测试动作',
    risk: 'write-local',
    authorization: 'explicit-user-request',
    parameters: { text: 'echo' },
    status: 'waiting-for-integration',
    detail: 'reserved',
    createdAt: '2026-08-23T08:00:00.000Z',
    updatedAt: '2026-08-23T08:00:00.000Z',
  }
}

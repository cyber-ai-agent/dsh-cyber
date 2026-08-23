import { describe, expect, it } from 'vitest'

import type { CharacterSkillAction } from '@dsh-cyber/contracts/skill-runtime'

import { HomeAssistantSkillAdapter } from '../src/skills/home-assistant-adapter.js'

describe('HomeAssistantSkillAdapter outcome semantics', () => {
  it('marks a transport interruption as outcome-unknown after the external request may have left the process', async () => {
    const adapter = new HomeAssistantSkillAdapter({
      env: {
        DSH_CYBER_HOME_ASSISTANT_URL: 'http://127.0.0.1:8123',
        DSH_CYBER_HOME_ASSISTANT_TOKEN: 'test-token',
        DSH_CYBER_HOME_AIR_CONDITIONER: 'climate.office',
      },
      fetch: (async () => {
        throw new TypeError('socket closed')
      }) as typeof globalThis.fetch,
    })

    const result = await adapter.execute(action(), { now: new Date('2026-08-23T08:00:00.000Z') })

    expect(result).toEqual({
      status: 'outcome-unknown',
      detail: 'Home Assistant 连接中断，外部动作结果未知；不得自动重试',
    })
  })

  it('keeps a provider HTTP rejection as a definitive failure', async () => {
    const adapter = new HomeAssistantSkillAdapter({
      env: {
        DSH_CYBER_HOME_ASSISTANT_URL: 'http://127.0.0.1:8123',
        DSH_CYBER_HOME_ASSISTANT_TOKEN: 'test-token',
        DSH_CYBER_HOME_AIR_CONDITIONER: 'climate.office',
      },
      fetch: (async () => new Response('{}', { status: 403 })) as typeof globalThis.fetch,
    })

    const result = await adapter.execute(action(), { now: new Date('2026-08-23T08:00:00.000Z') })

    expect(result).toEqual({
      status: 'failed',
      detail: 'Home Assistant 拒绝了动作（HTTP 403）',
    })
  })
})

function action(): CharacterSkillAction {
  return {
    id: 'action-1',
    worldId: 'world-1',
    characterId: 'character-1',
    skillId: 'smart-home.control',
    adapterId: 'builtin.home-assistant',
    action: 'climate.turn_on',
    target: 'air-conditioner',
    label: '开启空调',
    risk: 'external-side-effect',
    authorization: 'explicit-user-request',
    parameters: {},
    status: 'waiting-for-integration',
    detail: 'reserved',
    createdAt: '2026-08-23T08:00:00.000Z',
    updatedAt: '2026-08-23T08:00:00.000Z',
  }
}

import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import type { CyberPackageManifest } from '@dsh-cyber/contracts'
import { BUILTIN_WORLD_TEMPLATES, blueprintsForWorld, worldTemplate } from '@dsh-cyber/catalog'
import { jarvisCoreTheme } from '@dsh-cyber/world-runtime'
import { assignCharacterHomeSlots, compileWorldSemantics } from '@dsh-cyber/world-simulation'

import { parseEmployeeBlueprintManifest } from '../src/employee-blueprint-manifest.js'
import { embodimentToCharacterBehaviorProfile } from '../src/embodiment-profile.js'
import { createBuiltinSkillRegistry } from '../src/skills/builtin-skill-registry.js'

const TEMPLATE_ID = 'jarvis-core'
const pluginRoot = fileURLToPath(new URL('../../../marketplace/plugins/', import.meta.url))

describe('Jarvis Core world template', () => {
  it('publishes the personal hub scenario with its own delegation terminology', () => {
    const template = worldTemplate(TEMPLATE_ID)
    expect(template).toBeDefined()
    expect(BUILTIN_WORLD_TEMPLATES).toContain(template)
    expect(template?.terminology).toEqual({
      agent: '助理角色',
      recruit: '接入中枢',
      groupSession: '受理会',
      assignment: '个人任务',
    })
  })

  it('binds the personal hub studio as the theme default scene', () => {
    expect(jarvisCoreTheme.templateId).toBe(TEMPLATE_ID)
    expect(jarvisCoreTheme.renderer).toBe('pixi-2d')
    expect(jarvisCoreTheme.scenes.map((scene) => scene.id)).toEqual(['personal-hub-studio'])
    expect(jarvisCoreTheme.terminology).toMatchObject({
      world: '中枢',
      session: '委派',
      ownership: '归属',
      digest: '汇总回报',
    })
  })

  it('carries the delegation loop as the theme workflow and world rules', () => {
    expect(jarvisCoreTheme.terminology.workflow).toEqual(['接收请求', '判断归属', '委派', '汇总回报'])
    const rules = jarvisCoreTheme.terminology.rules as string[]
    expect(rules.length).toBeGreaterThanOrEqual(5)
    // 汇总回报 must never dress an untouched request up as a finished one.
    expect(rules.some((rule) => rule.includes('没有做') && rule.includes('已完成'))).toBe(true)
    // 日程 reuses the world's existing Task Schedule machinery.
    expect(rules.some((rule) => rule.includes('任务计划'))).toBe(true)
  })

  it('reuses the shipped world result surface instead of declaring a second one', () => {
    expect(jarvisCoreTheme.terminology.resultSurface).toBe('generic')
    expect(jarvisCoreTheme.terminology.resultSurfaceLabel).toBe('汇总回报')
    expect(jarvisCoreTheme.terminology.blackboard).toBe('简报板')
  })

  it('compiles world semantics that carry the whole delegation loop', () => {
    const semantics = compileWorldSemantics(jarvisCoreTheme)
    expect(semantics.themeId).toBe(jarvisCoreTheme.id)
    expect(semantics.sceneId).toBe('personal-hub-studio')
    expect(semantics.facilities.map((facility) => facility.id)).toEqual(expect.arrayContaining([
      'request-intake-table',
      'ownership-routing-board',
      'delegation-board',
      'research-carrel-desk',
      'schedule-console-desk',
      'filing-organiser-bench',
      'information-index-wall',
      'summary-report-stand',
    ]))
    const zoneIds = new Set(semantics.zones.map((zone) => zone.id))
    for (const zone of [
      'zone-administration',
      'zone-research',
      'zone-engineering',
      'zone-operations',
      'zone-meeting',
      'zone-rest',
      'zone-public',
    ]) expect(zoneIds).toContain(zone)
    expect(semantics.slots.some((slot) => slot.tags.includes('delegation'))).toBe(true)
    expect(semantics.slots.some((slot) => slot.tags.includes('schedule'))).toBe(true)
  })

  it('seats every default cast member in its own hub zone', () => {
    const semantics = compileWorldSemantics(jarvisCoreTheme)
    const cast = blueprintsForWorld(TEMPLATE_ID)
    const characters = cast.map((blueprint) => ({
      id: blueprint.id,
      blueprintId: blueprint.id,
      displayName: blueprint.displayName,
      role: blueprint.role,
    }))
    const profiles = new Map(cast.map((blueprint) => [
      blueprint.id,
      embodimentToCharacterBehaviorProfile(blueprint.id, blueprint.embodiment!),
    ]))
    const homes = assignCharacterHomeSlots(characters, semantics, new Map(), profiles)

    expect(homes.get('jarvis-core.hub-steward')?.zoneId).toBe('zone-administration')
    expect(homes.get('jarvis-core.researcher')?.zoneId).toBe('zone-research')
    expect(homes.get('jarvis-core.scheduler')?.zoneId).toBe('zone-operations')
    expect(homes.get('jarvis-core.organiser')?.zoneId).toBe('zone-engineering')
    expect(homes.get('jarvis-core.hub-steward')?.anchorId).toBe('delegation-desk')
    expect(homes.get('jarvis-core.scheduler')?.anchorId).toBe('schedule-console')
    expect(new Set([...homes.values()].map((slot) => slot.id)).size).toBe(homes.size)
  })
})

describe('Jarvis Core default cast', () => {
  it('ships one router plus the three roles a personal request is delegated to', () => {
    expect(blueprintsForWorld(TEMPLATE_ID).map((item) => [item.id, item.displayName])).toEqual([
      ['jarvis-core.hub-steward', '中枢管家'],
      ['jarvis-core.researcher', '调研员'],
      ['jarvis-core.scheduler', '日程管家'],
      ['jarvis-core.organiser', '信息整理员'],
    ])
  })

  it('compiles through the real employee blueprint parser', () => {
    for (const blueprint of blueprintsForWorld(TEMPLATE_ID)) {
      expect(blueprint.worldTemplateId).toBe(TEMPLATE_ID)
      expect(blueprint.role.trim()).not.toBe('')
      expect(blueprint.summary.trim()).not.toBe('')
      expect(blueprint.persona.trim()).not.toBe('')
      expect(blueprint.requestedSkills.length).toBeGreaterThan(0)
      const parsed = parseEmployeeBlueprintManifest(JSON.parse(JSON.stringify(blueprint)), {
        packageId: blueprint.id,
        packageCapabilities: [...blueprint.requestedCapabilities],
      })
      expect(parsed).toEqual(blueprint)
    }
  })

  it('requests only skill ids the host catalog actually offers', async () => {
    const hostSkillIds = new Set([
      ...createBuiltinSkillRegistry().list().map((descriptor) => descriptor.id),
      ...await marketplaceSkillIds(),
    ])
    for (const blueprint of blueprintsForWorld(TEMPLATE_ID)) {
      for (const skillId of blueprint.requestedSkills) {
        expect(hostSkillIds, `${blueprint.id} requests ${skillId}`).toContain(skillId)
      }
    }
  })

  it('keeps requested capabilities read-only requests rather than grants', () => {
    for (const blueprint of blueprintsForWorld(TEMPLATE_ID)) {
      for (const capability of blueprint.requestedCapabilities) {
        expect(capability).toMatch(/^(?:workspace|knowledge|artifact):read$/)
      }
    }
  })
})

async function marketplaceSkillIds(): Promise<string[]> {
  const entries = await readdir(pluginRoot, { withFileTypes: true })
  const ids: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const manifest = JSON.parse(
      await readFile(join(pluginRoot, entry.name, 'dsh-cyber.package.json'), 'utf8'),
    ) as CyberPackageManifest
    for (const entrypoint of manifest.entrypoints ?? []) {
      if (entrypoint.kind === 'skill') ids.push(entrypoint.id)
    }
  }
  return ids
}

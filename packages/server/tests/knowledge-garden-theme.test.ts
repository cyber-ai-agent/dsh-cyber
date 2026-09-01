import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import type { CyberPackageManifest } from '@dsh-cyber/contracts'
import { BUILTIN_WORLD_TEMPLATES, blueprintsForWorld, worldTemplate } from '@dsh-cyber/catalog'
import { knowledgeGardenTheme } from '@dsh-cyber/world-runtime'
import { assignCharacterHomeSlots, compileWorldSemantics } from '@dsh-cyber/world-simulation'

import { parseEmployeeBlueprintManifest } from '../src/employee-blueprint-manifest.js'
import { embodimentToCharacterBehaviorProfile } from '../src/embodiment-profile.js'
import { createBuiltinSkillRegistry } from '../src/skills/builtin-skill-registry.js'

const TEMPLATE_ID = 'knowledge-garden'
const pluginRoot = fileURLToPath(new URL('../../../marketplace/plugins/', import.meta.url))

describe('Knowledge Garden world template', () => {
  it('publishes the second-brain scenario with its own tending terminology', () => {
    const template = worldTemplate(TEMPLATE_ID)
    expect(template).toBeDefined()
    expect(BUILTIN_WORLD_TEMPLATES).toContain(template)
    expect(template?.terminology).toEqual({
      agent: '整理角色',
      recruit: '请入花园',
      groupSession: '复看会',
      assignment: '整理任务',
    })
  })

  it('binds the reading courtyard as the theme default scene', () => {
    expect(knowledgeGardenTheme.templateId).toBe(TEMPLATE_ID)
    expect(knowledgeGardenTheme.renderer).toBe('pixi-2d')
    expect(knowledgeGardenTheme.scenes.map((scene) => scene.id)).toEqual(['reading-courtyard'])
    expect(knowledgeGardenTheme.terminology).toMatchObject({
      world: '花园',
      session: '整理会',
      artifact: '整理成果',
      knowledgeMap: '知识图谱',
    })
  })

  it('reuses the shipped world result surface instead of declaring a second one', () => {
    expect(knowledgeGardenTheme.terminology).toMatchObject({
      resultSurface: 'generic',
      resultSurfaceLabel: '花园成果',
      blackboard: '摘录板',
      knowledgeGraph: '知识图谱',
      lessonCards: '笔记卡片',
      resultMedia: '影像资料',
    })
  })

  it('makes naming a source a world rule rather than a suggestion', () => {
    const terminology = knowledgeGardenTheme.terminology as { workflow?: unknown, rules?: unknown }
    expect(terminology.workflow).toEqual([
      '采集来源', '归档资料', '提炼条目', '核验引用', '连接知识图谱', '复看维护',
    ])
    const rules = terminology.rules as string[]
    expect(rules.length).toBeGreaterThanOrEqual(6)
    expect(rules.some((rule) => rule.includes('来源') && rule.includes('知识图谱'))).toBe(true)
    // Knowledge is world-scoped end to end today; the theme must say so.
    expect(rules.some((rule) => rule.includes('别的世界'))).toBe(true)
    // Never fabricate a result: an empty collection says it is empty.
    expect(rules.some((rule) => rule.includes('找不到'))).toBe(true)
  })

  it('compiles world semantics that carry the whole tending loop', () => {
    const semantics = compileWorldSemantics(knowledgeGardenTheme)
    expect(semantics.themeId).toBe(knowledgeGardenTheme.id)
    expect(semantics.sceneId).toBe('reading-courtyard')
    expect(semantics.facilities.map((facility) => facility.id)).toEqual(expect.arrayContaining([
      'source-intake-desk',
      'collection-bookshelf',
      'citation-check-bench',
      'note-card-shelf',
      'knowledge-graph-wall',
      'garden-result-showcase',
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
    expect(semantics.slots.some((slot) => slot.tags.includes('provenance'))).toBe(true)
    expect(semantics.slots.some((slot) => slot.tags.includes('curation'))).toBe(true)
  })

  it('seats every default cast member in its own tending zone', () => {
    const semantics = compileWorldSemantics(knowledgeGardenTheme)
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

    expect(homes.get('knowledge-garden.curator')?.zoneId).toBe('zone-administration')
    expect(homes.get('knowledge-garden.source-scout')?.zoneId).toBe('zone-operations')
    expect(homes.get('knowledge-garden.citation-checker')?.zoneId).toBe('zone-research')
    expect(homes.get('knowledge-garden.cartographer')?.zoneId).toBe('zone-engineering')
    expect(new Set([...homes.values()].map((slot) => slot.id)).size).toBe(homes.size)
  })
})

describe('Knowledge Garden default cast', () => {
  it('ships the four tending roles in loop order', () => {
    expect(blueprintsForWorld(TEMPLATE_ID).map((item) => [item.id, item.displayName])).toEqual([
      ['knowledge-garden.curator', '知识管家'],
      ['knowledge-garden.source-scout', '资料采集员'],
      ['knowledge-garden.citation-checker', '来源核验员'],
      ['knowledge-garden.cartographer', '知识制图员'],
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

  it('writes every persona to curate and cite rather than invent', () => {
    const personas = new Map(blueprintsForWorld(TEMPLATE_ID).map((item) => [item.id, item.persona]))
    expect(personas.get('knowledge-garden.curator')).toContain('从不发明内容')
    expect(personas.get('knowledge-garden.source-scout')).toContain('出处')
    expect(personas.get('knowledge-garden.citation-checker')).toContain('冲突')
    expect(personas.get('knowledge-garden.cartographer')).toContain('证据')
    for (const persona of personas.values()) expect(persona).toContain('来源')
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

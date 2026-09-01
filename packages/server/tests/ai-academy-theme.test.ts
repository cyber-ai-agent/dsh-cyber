import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import type { CyberPackageManifest } from '@dsh-cyber/contracts'
import { BUILTIN_WORLD_TEMPLATES, blueprintsForWorld, worldTemplate } from '@dsh-cyber/catalog'
import { aiAcademyTheme } from '@dsh-cyber/world-runtime'
import { assignCharacterHomeSlots, compileWorldSemantics } from '@dsh-cyber/world-simulation'

import { parseEmployeeBlueprintManifest } from '../src/employee-blueprint-manifest.js'
import { embodimentToCharacterBehaviorProfile } from '../src/embodiment-profile.js'
import { createBuiltinSkillRegistry } from '../src/skills/builtin-skill-registry.js'

const TEMPLATE_ID = 'ai-academy'
const pluginRoot = fileURLToPath(new URL('../../../marketplace/plugins/', import.meta.url))

describe('AI Academy world template', () => {
  it('publishes the teaching scenario with its own teaching terminology', () => {
    const template = worldTemplate(TEMPLATE_ID)
    expect(template).toBeDefined()
    expect(BUILTIN_WORLD_TEMPLATES).toContain(template)
    expect(template?.terminology).toEqual({
      agent: '教研角色',
      recruit: '聘入学院',
      groupSession: '教研会',
      assignment: '教学任务',
    })
  })

  it('binds the university classroom as the theme default scene', () => {
    expect(aiAcademyTheme.templateId).toBe(TEMPLATE_ID)
    expect(aiAcademyTheme.renderer).toBe('pixi-2d')
    expect(aiAcademyTheme.scenes.map((scene) => scene.id)).toEqual(['university-classroom'])
    expect(aiAcademyTheme.terminology).toMatchObject({
      world: '学院',
      session: '课堂',
      artifact: '课程结果',
      knowledgeMap: '知识图',
    })
  })

  it('compiles world semantics that carry the whole teaching loop', () => {
    const semantics = compileWorldSemantics(aiAcademyTheme)
    expect(semantics.themeId).toBe(aiAcademyTheme.id)
    expect(semantics.sceneId).toBe('university-classroom')
    expect(semantics.facilities.map((facility) => facility.id)).toEqual(expect.arrayContaining([
      'knowledge-breakdown-desk',
      'syllabus-board',
      'teaching-material-bench',
      'question-desk',
      'knowledge-graph-wall',
      'course-result-showcase',
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
    expect(semantics.slots.some((slot) => slot.tags.includes('lectern'))).toBe(true)
  })

  it('seats every default cast member in its own teaching zone', () => {
    const semantics = compileWorldSemantics(aiAcademyTheme)
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

    expect(homes.get('ai-academy.professor')?.zoneId).toBe('zone-administration')
    expect(homes.get('ai-academy.teaching-assistant')?.zoneId).toBe('zone-operations')
    expect(homes.get('ai-academy.course-designer')?.zoneId).toBe('zone-administration')
    expect(homes.get('ai-academy.knowledge-animator')?.zoneId).toBe('zone-engineering')
    expect(new Set([...homes.values()].map((slot) => slot.id)).size).toBe(homes.size)
  })
})

describe('AI Academy default cast', () => {
  it('ships the four teaching roles in loop order', () => {
    expect(blueprintsForWorld(TEMPLATE_ID).map((item) => [item.id, item.displayName])).toEqual([
      ['ai-academy.professor', '教授'],
      ['ai-academy.teaching-assistant', '助教'],
      ['ai-academy.course-designer', '课程设计师'],
      ['ai-academy.knowledge-animator', '知识动画设计师'],
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

import { describe, expect, it } from 'vitest'

import { blueprintsForWorld } from '@dsh-cyber/catalog'

import { createBuiltinSkillRegistry } from '../src/skills/builtin-skill-registry.js'
import { CharacterSkillAdapterRegistry } from '../src/skills/skill-adapter.js'
import { registerBuiltinSkillRecipes } from '../src/skills/builtin-skill-recipes.js'

// The four official themes (#129, #134) mapped their casts to the *nearest
// real* host skill and reported the gaps. These are the host-owned recipes
// that close the gaps two or more themes share, plus one per theme. They are
// deterministic instructions — no connector, no fetching — so they register
// exactly like the recipes that were already there.
const THEME_RECIPE_IDS = ['schedule-planning', 'citation-audit', 'freshness-review', 'curriculum-design'] as const

describe('theme skill recipes', () => {
  it('registers every theme gap recipe as a builtin recipe listed by the host registry', () => {
    const listed = new Map(createBuiltinSkillRegistry().list().map((descriptor) => [descriptor.id, descriptor]))
    for (const id of THEME_RECIPE_IDS) {
      const descriptor = listed.get(id)
      expect(descriptor, `${id} is listed`).toBeDefined()
      expect(descriptor).toMatchObject({
        adapterId: 'builtin.recipe',
        kind: 'recipe',
        risks: [],
        supportsScheduling: false,
        persistentApproval: 'forbidden',
        recommendedByDefault: true,
      })
      expect(descriptor?.displayName.trim().length).toBeGreaterThan(0)
      expect(descriptor?.summary.trim().length).toBeGreaterThan(0)
      expect(descriptor?.routingHints.length, `${id} has routing hints`).toBeGreaterThan(0)
    }
  })

  it('keeps each recipe instruction host-owned and offline: no fetching, no scheduler, no grant', () => {
    const registry = new CharacterSkillAdapterRegistry()
    registerBuiltinSkillRecipes(registry)
    const instruction = (id: string): string => {
      const [text] = registry.instructionsFor([id])
      expect(text, `${id} resolves to a recipe instruction`).toBeDefined()
      return text!
    }

    // schedule-planning lands in the existing Task Schedule and never promises time in chat.
    expect(instruction('schedule-planning')).toMatch(/任务计划/)
    expect(instruction('schedule-planning')).toMatch(/时区/)
    expect(instruction('schedule-planning')).toMatch(/不(自行|代为|擅自)创建|由用户.*创建/)
    // citation-audit only accepts the three retraceable citation shapes and flags the rest 待核实.
    expect(instruction('citation-audit')).toMatch(/资料.*片段/)
    expect(instruction('citation-audit')).toMatch(/会话.*消息/)
    expect(instruction('citation-audit')).toMatch(/成果.*版本/)
    expect(instruction('citation-audit')).toMatch(/待核实/)
    // freshness-review is a pure time check: absolute timestamps, 待复核 past cadence, relative words refused.
    expect(instruction('freshness-review')).toMatch(/待复核/)
    expect(instruction('freshness-review')).toMatch(/绝对时间/)
    expect(instruction('freshness-review')).toMatch(/今天/)
    expect(instruction('freshness-review')).toMatch(/刚刚/)
    expect(instruction('freshness-review')).toMatch(/截至时间/)
    // curriculum-design plans structure, pacing and verifiable objectives — after the knowledge is broken down.
    expect(instruction('curriculum-design')).toMatch(/课时/)
    expect(instruction('curriculum-design')).toMatch(/可检验|可验证/)
    expect(instruction('curriculum-design')).toMatch(/学员基础/)
  })

  it('lets the themes request the new ids where they used to borrow a neighbour', () => {
    const requested = (blueprintId: string): readonly string[] => {
      const [worldTemplateId] = blueprintId.split('.')
      const blueprint = blueprintsForWorld(worldTemplateId!).find((item) => item.id === blueprintId)
      expect(blueprint, `${blueprintId} exists`).toBeDefined()
      return blueprint!.requestedSkills
    }
    expect(requested('ai-academy.course-designer')).toContain('curriculum-design')
    expect(requested('jarvis-core.scheduler')).toContain('schedule-planning')
    expect(requested('knowledge-garden.citation-checker')).toContain('citation-audit')
    expect(requested('news-center.tech-analyst')).toContain('freshness-review')
    expect(requested('news-center.finance-watcher')).toContain('citation-audit')
    expect(requested('news-center.industry-researcher')).toContain('schedule-planning')
    expect(requested('news-center.industry-researcher')).toContain('freshness-review')
  })

  it('never lets a theme request an id the host registry cannot resolve', () => {
    const hostIds = new Set(createBuiltinSkillRegistry().list().map((descriptor) => descriptor.id))
    const marketplaceOnly = new Set(['web.search.firecrawl', 'browser.read', 'browser.extract'])
    for (const worldTemplateId of ['ai-academy', 'jarvis-core', 'knowledge-garden', 'news-center']) {
      for (const blueprint of blueprintsForWorld(worldTemplateId)) {
        for (const skillId of blueprint.requestedSkills) {
          if (marketplaceOnly.has(skillId)) continue
          expect(hostIds, `${blueprint.id} requests ${skillId}`).toContain(skillId)
        }
      }
    }
  })
})

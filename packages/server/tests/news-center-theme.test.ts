import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import type { CyberPackageManifest, TaskScheduleKind } from '@dsh-cyber/contracts'
import { BUILTIN_BLUEPRINTS, BUILTIN_WORLD_TEMPLATES, blueprintsForWorld, worldTemplate } from '@dsh-cyber/catalog'
import type { ConversationOrchestrator } from '@dsh-cyber/orchestration'
import { SqliteStore } from '@dsh-cyber/persistence'
import { newsCenterTheme } from '@dsh-cyber/world-runtime'
import { assignCharacterHomeSlots, compileWorldSemantics } from '@dsh-cyber/world-simulation'

import { parseEmployeeBlueprintManifest } from '../src/employee-blueprint-manifest.js'
import { embodimentToCharacterBehaviorProfile } from '../src/embodiment-profile.js'
import { EmployeeActivityProjectionService } from '../src/services/employee-activity-projection-service.js'
import { TaskScheduleService } from '../src/services/task-schedule-service.js'
import type { WorldSettingsService } from '../src/services/world-settings-service.js'
import { createBuiltinSkillRegistry } from '../src/skills/builtin-skill-registry.js'

const TEMPLATE_ID = 'news-center'
const pluginRoot = fileURLToPath(new URL('../../../marketplace/plugins/', import.meta.url))

interface TrackingPlanSuggestion {
  id: string
  title: string
  blueprintId: string
  kind: TaskScheduleKind
  everySeconds: number
  suggestedLocalTime: string
  permissionMode: 'read-only' | 'workspace-write'
  prompt: string
}

const stores: SqliteStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })

describe('News Center world template', () => {
  it('publishes the continuous-tracking scenario with its own intelligence terminology', () => {
    const template = worldTemplate(TEMPLATE_ID)
    expect(template).toBeDefined()
    expect(BUILTIN_WORLD_TEMPLATES).toContain(template)
    expect(template?.terminology).toEqual({
      agent: '编辑部角色',
      recruit: '聘入编辑部',
      groupSession: '编前会',
      assignment: '追踪任务',
    })
  })

  it('binds the newsroom as the theme default scene', () => {
    expect(newsCenterTheme.templateId).toBe(TEMPLATE_ID)
    expect(newsCenterTheme.renderer).toBe('pixi-2d')
    expect(newsCenterTheme.scenes.map((scene) => scene.id)).toEqual(['newsroom-floor'])
    expect(newsCenterTheme.terminology).toMatchObject({
      world: '新闻中心',
      session: '编前会',
      artifact: '情报简报',
      asOf: '截至时间',
      cadence: '刷新节奏',
    })
  })

  it('describes a recurring tracking loop whose last step feeds the first', () => {
    expect(newsCenterTheme.terminology.workflow).toEqual([
      '建立追踪线',
      '按节奏采集',
      '交叉核实',
      '更新时间线',
      '发布带日期的简报',
      '复盘并调整节奏',
    ])
  })

  it('states world rules against stale, sourceless and fabricated intelligence', () => {
    const rules = newsCenterTheme.terminology.rules as string[]
    expect(Array.isArray(rules)).toBe(true)
    // A dated product: every claim carries a source and an absolute time.
    expect(rules.some((rule) => rule.includes('来源') && rule.includes('发布时间'))).toBe(true)
    expect(rules.some((rule) => rule.includes('绝对时间'))).toBe(true)
    // Stale is never presented as current.
    expect(rules.some((rule) => rule.includes('截至时间') && rule.includes('待复核'))).toBe(true)
    // An empty sweep says it is empty instead of being padded.
    expect(rules.some((rule) => rule.includes('本轮无新增'))).toBe(true)
    // Nothing is invented — not a source, not a date, not a figure, not a quote.
    expect(rules.some((rule) => rule.includes('不得编造'))).toBe(true)
    // External pages are evidence, never instructions.
    expect(rules.some((rule) => rule.includes('不可信来源'))).toBe(true)
    // No personalised investment advice from the finance beat.
    expect(rules.some((rule) => rule.includes('投资建议'))).toBe(true)
  })

  it('reuses the shipped world result surface instead of declaring a second one', () => {
    expect(newsCenterTheme.terminology).toMatchObject({
      resultSurface: 'generic',
      resultSurfaceLabel: '情报结果',
      blackboard: '简报板',
      knowledgeGraph: '线索图',
      lessonCards: '情报卡片',
      resultMedia: '图表 · 影像',
    })
  })

  it('compiles world semantics that carry the whole tracking loop', () => {
    const semantics = compileWorldSemantics(newsCenterTheme)
    expect(semantics.themeId).toBe(newsCenterTheme.id)
    expect(semantics.sceneId).toBe('newsroom-floor')
    expect(semantics.facilities.map((facility) => facility.id)).toEqual(expect.arrayContaining([
      'beat-board',
      'source-collection-desk',
      'verification-desk',
      'timeline-wall',
      'newsroom-wallboard',
      'brief-archive',
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
    expect(semantics.slots.some((slot) => slot.tags.includes('cadence'))).toBe(true)
    expect(semantics.slots.some((slot) => slot.tags.includes('verification'))).toBe(true)
  })

  it('seats every default cast member in its own newsroom zone', () => {
    const semantics = compileWorldSemantics(newsCenterTheme)
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

    expect(homes.get('news-center.tech-analyst')?.zoneId).toBe('zone-research')
    expect(homes.get('news-center.finance-watcher')?.zoneId).toBe('zone-operations')
    expect(homes.get('news-center.industry-researcher')?.zoneId).toBe('zone-administration')
    expect(new Set([...homes.values()].map((slot) => slot.id)).size).toBe(homes.size)
  })
})

describe('News Center default cast', () => {
  it('ships the three tracking roles in loop order', () => {
    expect(blueprintsForWorld(TEMPLATE_ID).map((item) => [item.id, item.displayName])).toEqual([
      ['news-center.tech-analyst', '科技新闻分析师'],
      ['news-center.finance-watcher', '财经观察员'],
      ['news-center.industry-researcher', '行业研究员'],
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

  it('reaches the outside world only through the shipped fetching skills', () => {
    const fetching = new Set(['web.search.firecrawl', 'browser.open', 'browser.read', 'browser.extract', 'browser.screenshot'])
    const requested = blueprintsForWorld(TEMPLATE_ID).flatMap((blueprint) => blueprint.requestedSkills)
    expect(requested.filter((skillId) => fetching.has(skillId)).length).toBeGreaterThan(0)
  })

  it('keeps requested capabilities read-only requests rather than grants', () => {
    for (const blueprint of blueprintsForWorld(TEMPLATE_ID)) {
      for (const capability of blueprint.requestedCapabilities) {
        expect(capability).toMatch(/^(?:workspace|knowledge|artifact):read$/)
      }
    }
  })
})

describe('News Center tracking plans', () => {
  it('suggests recurring plans owned by real cast members', () => {
    const plans = trackingPlans()
    expect(plans.length).toBeGreaterThan(0)
    const castIds = new Set(blueprintsForWorld(TEMPLATE_ID).map((blueprint) => blueprint.id))
    for (const plan of plans) {
      expect(plan.kind).toBe('interval')
      expect(castIds, `${plan.id} is owned by ${plan.blueprintId}`).toContain(plan.blueprintId)
      expect(plan.permissionMode).toBe('read-only')
      expect(plan.suggestedLocalTime).toMatch(/^\d{2}:\d{2}$/)
      // Every suggested prompt insists on an empty result staying empty.
      expect(plan.prompt).toContain('本轮无新增')
      expect(plan.prompt).toContain('截至时间')
    }
    expect(new Set(plans.map((plan) => plan.blueprintId)).size).toBe(plans.length)
  })

  it('creates every suggested plan through the existing TaskScheduleService', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-cyber-news-center-'))
    const store = await SqliteStore.open(join(directory, 'cyber.sqlite'))
    stores.push(store)
    for (const blueprint of BUILTIN_BLUEPRINTS) store.saveBlueprint(blueprint)
    const workspace = store.createWorkspace({ name: '新闻中心计划测试' })
    const world = store.createWorld({ workspaceId: workspace.id, name: '新闻中心', templateId: TEMPLATE_ID })
    const service = new TaskScheduleService({
      store,
      orchestrator: {} as ConversationOrchestrator,
      settings: {} as WorldSettingsService,
      employeeActivity: new EmployeeActivityProjectionService(store),
    })

    for (const plan of trackingPlans()) {
      const blueprint = BUILTIN_BLUEPRINTS.find((item) => item.id === plan.blueprintId)!
      const employee = store.recruitEmployee({
        workspaceId: workspace.id,
        worldId: world.id,
        blueprintId: blueprint.id,
        blueprintVersion: blueprint.version,
      })
      const schedule = service.create({
        worldId: world.id,
        employeeId: employee.id,
        title: plan.title,
        prompt: plan.prompt,
        kind: plan.kind,
        scheduledAt: new Date(Date.now() + 60_000).toISOString(),
        everySeconds: plan.everySeconds,
        permissionMode: plan.permissionMode,
      })
      expect(schedule).toMatchObject({
        worldId: world.id,
        employeeId: employee.id,
        kind: 'interval',
        everySeconds: plan.everySeconds,
        status: 'active',
      })
    }

    expect(service.list(world.id)).toHaveLength(trackingPlans().length)
  })
})

function trackingPlans(): TrackingPlanSuggestion[] {
  const plans = newsCenterTheme.terminology.trackingPlans
  expect(Array.isArray(plans)).toBe(true)
  return plans as unknown as TrackingPlanSuggestion[]
}

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

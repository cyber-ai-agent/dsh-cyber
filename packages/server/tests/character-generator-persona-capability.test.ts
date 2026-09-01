import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { AgentRuntimePort } from '@dsh-cyber/contracts'
import { LocalPackageCatalog, LocalPackageRuntime, PackageManager } from '@dsh-cyber/package-runtime'
import { SqliteStore } from '@dsh-cyber/persistence'

import { createCyberServer, type CyberServer } from '../src/index.js'
import { compileEmployeeBlueprintPackage } from '../src/services/employee-blueprint-package-compiler.js'
import { normalizeCharacterBlueprintDraft } from '../src/services/character-import-analyzer.js'
import { CreativeWorkshopService } from '../src/services/creative-workshop-service.js'

const fixturePath = join(process.cwd(), 'tests', 'fixtures', 'character-generator', 'engineering-ai-engineer.md')
const servers: CyberServer[] = []
const stores: SqliteStore[] = []
const roots: string[] = []

type AnyRecord = Record<string, any>

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  for (const store of stores.splice(0)) store.close()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('B-FIX-3 the runtime persona never carries a raw import-source echo', () => {
  it('keeps a hostile background out of the published blueprint persona', async () => {
    const source = await readFile(fixturePath, 'utf8')
    expect(Buffer.byteLength(source, 'utf8')).toBeGreaterThan(5_000)
    expect(source).toContain('from dataclasses import dataclass')
    expect(source).toContain('llm_client')

    // A hostile/sloppy model: persona is short and safe, but background is a
    // large verbatim slab of the untrusted source. It is single-line because
    // draft text fields reject control characters, so this is the shape an
    // attacker actually gets through.
    const slab = hostileBackground(source)
    const paragraph = longestSourceLine(source)
    expect(slab).toContain('from dataclasses')
    expect(slab).toContain('llm_client')
    expect(slab).toContain(paragraph)
    const server = await startServer({
      analyzer: createAnalyzer([], {
        schemaVersion: 1,
        targetWorldTemplateId: 'personal-world',
        displayName: 'AI 工程师',
        role: '机器学习工程师',
        summary: '从数据到上线构建可靠的 AI 系统。',
        persona: '务实、数据驱动，明确区分事实与假设。',
        personalityTraits: ['务实', '数据驱动'],
        background: slab,
        requestedSkillIds: [],
        requestedCapabilities: [],
        sourceSummary: 'fixture source',
        sourceRefs: [],
      }),
    })
    const workspace = server.store.listWorkspaces()[0]!
    const world = server.store.listWorlds(workspace.id)[0]!

    const analyzed = await postJson(server.origin, `/api/workspaces/${workspace.id}/character-generator/analyze`, {
      source: { kind: 'file', text: source, fileName: 'engineering-ai-engineer.md' },
      targetWorldTemplateId: 'personal-world',
    })
    expect(analyzed.status, JSON.stringify(analyzed.body)).toBe(200)
    // The analyze seam must already drop the echoed background rather than
    // hand it back for review as if a human had written it.
    expect((analyzed.body.draft as AnyRecord).background).not.toContain('from dataclasses')
    expect((analyzed.body.draft as AnyRecord).background).not.toContain('llm_client')

    // Even if the client replays the hostile draft verbatim, publish must not
    // let the source reach the runtime persona.
    const published = await postJson(server.origin, `/api/workspaces/${workspace.id}/character-generator/publish`, {
      draft: {
        ...(analyzed.body.draft as AnyRecord),
        persona: '务实、数据驱动，明确区分事实与假设。',
        background: slab,
      },
      source: { kind: 'file', text: source, fileName: 'engineering-ai-engineer.md' },
      targetWorldTemplateId: 'personal-world',
    })

    if (published.status === 201) {
      const blueprint = published.body.blueprint as AnyRecord
      expectNoSourceEcho(blueprint.persona as string, source, paragraph)

      // The same must hold for what the install -> recruit path actually runs.
      const generatedRoot = join(server.root, 'workshop', 'character-generator', 'marketplace')
      const generated = (await new LocalPackageCatalog(generatedRoot).list({ market: 'talent' }))
        .find((item) => item.manifest.id === blueprint.id)!
      expect(generated).toBeDefined()
      const preview = server.packageManager.preview(workspace.id, generated.manifest)
      const installed = await postJson(server.origin, `/api/workspaces/${workspace.id}/packages/install`, {
        manifest: generated.manifest,
        sourceDirectory: generated.sourceDirectory,
        approvalToken: preview.approvalToken,
        worldId: world.id,
      })
      expect(installed.status, JSON.stringify(installed.body)).toBe(201)
      const live = server.store.getBlueprint(blueprint.id as string, blueprint.version as number)!
      expectNoSourceEcho(live.persona, source, paragraph)

      const recruited = await postJson(server.origin, `/api/worlds/${world.id}/recruit`, {
        blueprintId: live.id,
        blueprintVersion: live.version,
        skillGrants: [],
      })
      expect(recruited.status, JSON.stringify(recruited.body)).toBe(201)
      const employee = recruited.body.employee as AnyRecord
      const revision = server.store.getEmployeeRevision(employee.id as string, employee.currentRevision as number)!
      expectNoSourceEcho(revision.persona, source, paragraph)
    } else {
      // Rejecting the echo outright is also an acceptable outcome; what is not
      // acceptable is publishing it into the persona.
      expect([422], JSON.stringify(published.body)).toContain(published.status)
    }
  })

  it('never composes background or personalityTraits back into the blueprint persona', async () => {
    const source = await readFile(fixturePath, 'utf8')
    const root = await mkdtemp(join(tmpdir(), 'dsh-blueprint-compile-'))
    roots.push(root)
    const persona = '只依据当前世界中可验证的证据工作。'
    // Compile with the hostile draft fields still supplied by a caller that has
    // not been updated: the blueprint persona must stay persona-only.
    const compiled = await compileEmployeeBlueprintPackage({
      sourceDirectory: join(root, 'pkg'),
      packageId: 'generated.character.personaonly',
      worldTemplateId: 'personal-world',
      displayName: '角色',
      role: '测试角色',
      summary: '摘要。',
      persona,
      createdAt: '2026-09-01T00:00:00.000Z',
      ...({ background: hostileBackground(source), personalityTraits: ['务实', longestSourceLine(source).slice(0, 80)] } as Record<string, unknown>),
    })
    expect(compiled.blueprint.persona).toBe(persona)
    expect(compiled.blueprint.persona).not.toContain('性格特征')
    expect(compiled.blueprint.persona).not.toContain('背景')
    expectNoSourceEcho(compiled.blueprint.persona, source, longestSourceLine(source))
  })

  it('rejects a draft whose background echoes a long verbatim run of the source', async () => {
    const source = await readFile(fixturePath, 'utf8')
    const context = {
      targetWorldTemplateId: 'personal-world',
      allowedSkillIds: new Set<string>(),
      sourceRef: 'source:engineering-ai-engineer.md',
      originalText: source,
      rejectUnknown: true,
    }
    const base = {
      schemaVersion: 1,
      targetWorldTemplateId: 'personal-world',
      displayName: 'AI 工程师',
      role: '机器学习工程师',
      summary: '摘要。',
      persona: '务实、数据驱动。',
      personalityTraits: [],
      background: '',
      requestedSkillIds: [],
      requestedCapabilities: [],
      sourceSummary: '来源摘要',
      sourceRefs: [],
    }
    expect(() => normalizeCharacterBlueprintDraft(base, context)).not.toThrow()
    expect(() => normalizeCharacterBlueprintDraft(
      { ...base, background: hostileBackground(source) },
      context,
    )).toThrow(/source_echo|原始资料|背景/u)
    expect(() => normalizeCharacterBlueprintDraft(
      { ...base, personalityTraits: [longestSourceLine(source).slice(0, 80)] },
      context,
    )).toThrow(/source_echo|原始资料|性格/u)
    // Analyze filters instead of failing, so the reviewer never sees the echo.
    const filtered = normalizeCharacterBlueprintDraft(
      { ...base, background: hostileBackground(source), personalityTraits: [longestSourceLine(source).slice(0, 80), '务实'] },
      { ...context, rejectUnknown: false },
    )
    expect(filtered.background).toBe('')
    expect(filtered.personalityTraits).toEqual(['务实'])
  })

  it('detects a verbatim slab taken from the middle of the source, not only its prefix', async () => {
    const source = await readFile(fixturePath, 'utf8')
    const lines = source.split(/\r?\n/u).filter((line) => line.trim().length > 0)
    const middle = lines.slice(Math.floor(lines.length / 2), Math.floor(lines.length / 2) + 8).join(' ').slice(0, 400)
    expect(() => normalizeCharacterBlueprintDraft(
      {
        schemaVersion: 1,
        targetWorldTemplateId: 'personal-world',
        displayName: 'AI 工程师',
        role: '机器学习工程师',
        summary: '摘要。',
        persona: middle.slice(0, 400),
        personalityTraits: [],
        background: '',
        requestedSkillIds: [],
        requestedCapabilities: [],
        sourceSummary: '来源摘要',
        sourceRefs: [],
      },
      {
        targetWorldTemplateId: 'personal-world',
        allowedSkillIds: new Set<string>(),
        sourceRef: 'source:engineering-ai-engineer.md',
        originalText: source,
        rejectUnknown: true,
      },
    )).toThrow(/source_echo|原始资料/u)
  })
})

describe('B-FIX-4 package capabilities are not employee requested capabilities', () => {
  it('keeps a generated talent manifest at employee:blueprint while the blueprint keeps its request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-blueprint-capability-'))
    roots.push(root)
    const compiled = await compileEmployeeBlueprintPackage({
      sourceDirectory: join(root, 'pkg'),
      packageId: 'generated.character.capabilities',
      worldTemplateId: 'personal-world',
      displayName: '角色',
      role: '测试角色',
      summary: '摘要。',
      persona: '只依据当前世界中可验证的证据工作。',
      requestedCapabilities: ['workspace:read', 'knowledge:read'],
      createdAt: '2026-09-01T00:00:00.000Z',
    })
    expect(compiled.manifest.capabilities).toEqual(['employee:blueprint'])
    expect(compiled.blueprint.requestedCapabilities).toEqual(['workspace:read', 'knowledge:read'])
  })

  it('installs a generated package without turning the request into a package permission', async () => {
    const source = '# AI 工程师\n\n负责模型上线与回归验证。'
    const server = await startServer({
      analyzer: createAnalyzer([], {
        schemaVersion: 1,
        targetWorldTemplateId: 'personal-world',
        displayName: 'AI 工程师',
        role: '机器学习工程师',
        summary: '从数据到上线构建可靠的 AI 系统。',
        persona: '务实、数据驱动，明确区分事实与假设。',
        personalityTraits: [],
        background: '',
        requestedSkillIds: [],
        requestedCapabilities: ['workspace:read', 'knowledge:read'],
        sourceSummary: 'fixture source',
        sourceRefs: [],
      }),
    })
    const workspace = server.store.listWorkspaces()[0]!
    const world = server.store.listWorlds(workspace.id)[0]!
    const analyzed = await postJson(server.origin, `/api/workspaces/${workspace.id}/character-generator/analyze`, {
      source: { kind: 'paste', text: source },
      targetWorldTemplateId: 'personal-world',
    })
    expect(analyzed.status, JSON.stringify(analyzed.body)).toBe(200)
    const published = await postJson(server.origin, `/api/workspaces/${workspace.id}/character-generator/publish`, {
      draft: analyzed.body.draft,
      source: { kind: 'paste', text: source },
      targetWorldTemplateId: 'personal-world',
    })
    expect(published.status, JSON.stringify(published.body)).toBe(201)
    const manifest = (published.body.item as AnyRecord).manifest as AnyRecord
    expect(manifest.capabilities).toEqual(['employee:blueprint'])

    const generatedRoot = join(server.root, 'workshop', 'character-generator', 'marketplace')
    const generated = (await new LocalPackageCatalog(generatedRoot).list({ market: 'talent' }))
      .find((item) => item.manifest.id === manifest.id)!
    const preview = server.packageManager.preview(workspace.id, generated.manifest)
    expect(preview.capabilities).toEqual(['employee:blueprint'])
    const installed = await postJson(server.origin, `/api/workspaces/${workspace.id}/packages/install`, {
      manifest: generated.manifest,
      sourceDirectory: generated.sourceDirectory,
      approvalToken: preview.approvalToken,
      worldId: world.id,
    })
    expect(installed.status, JSON.stringify(installed.body)).toBe(201)
    expect(server.store.getActivePackage(workspace.id, manifest.id as string)?.capabilities).toEqual(['employee:blueprint'])

    // The blueprint still carries the request, and recruiting still grants nothing by default.
    const live = server.store.getBlueprint(manifest.id as string, 1)!
    expect(live.requestedCapabilities).toEqual(['workspace:read', 'knowledge:read'])
    const recruited = await postJson(server.origin, `/api/worlds/${world.id}/recruit`, {
      blueprintId: live.id,
      blueprintVersion: live.version,
      skillGrants: [],
    })
    expect(recruited.status, JSON.stringify(recruited.body)).toBe(201)
    const employee = recruited.body.employee as AnyRecord
    expect(server.store.getEmployeeRevision(employee.id as string, employee.currentRevision as number)?.capabilityGrants).toEqual([])
  })

  it('regression: Creative Workshop role packages keep exactly employee:blueprint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-workshop-capability-'))
    roots.push(root)
    const store = await SqliteStore.open(join(root, 'data', 'dsh-cyber.sqlite'))
    stores.push(store)
    const workspace = store.createWorkspace({ name: '本地工作区' })
    const workshop = new CreativeWorkshopService(store, new PackageManager({
      store,
      runtime: new LocalPackageRuntime(join(root, 'packages')),
    }))
    const project = await workshop.create(workspace.id, {
      displayName: '短剧工作室',
      baseTemplateId: 'personal-world',
      lore: '一支负责短剧增长与制作的数字团队。',
      scenario: '持续分析内容表现并协作交付。',
      roles: [{
        id: 'growth-operator',
        displayName: '阿策',
        role: '短剧投流专家',
        summary: '负责投放分析与增长策略。',
        persona: '基于事实数据工作，重要外部操作需要明确授权。',
        requestedSkillIds: [],
        embodiment: {
          roleTags: ['operations', 'analytics'],
          preferredZoneTags: ['operations'],
          preferredFacilityCapabilities: ['monitoring', 'analysis'],
          allowedZoneTags: ['operations', 'meeting', 'rest', 'public'],
          homeSlotTags: ['operations', 'work'],
          ambientBehaviors: ['inspect-dashboard'],
          socialPolicy: { canInitiateConversation: false, cooldownSeconds: 1_800, maxDailyConversations: 0 },
        },
      }],
    })
    const packageId = project.generatedPackageIds[0]!
    expect(store.getActivePackage(workspace.id, packageId)?.capabilities).toEqual(['employee:blueprint'])
    expect(store.getActivePackage(workspace.id, packageId)?.manifest.capabilities).toEqual(['employee:blueprint'])
  })
})

function expectNoSourceEcho(persona: string, source: string, paragraph: string): void {
  expect(persona).not.toContain('from dataclasses')
  expect(persona).not.toContain('llm_client')
  expect(persona).not.toContain('```')
  expect(persona).not.toContain(paragraph.slice(0, 60))
  expect(persona.length).toBeLessThanOrEqual(2_000)
  // Guard the guard: the marker really is a long verbatim run of the source.
  expect(source).toContain(paragraph.slice(0, 60))
}

/** The longest single source line, i.e. a verbatim run that survives the draft's control-character filter. */
function longestSourceLine(source: string): string {
  return source
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .sort((left, right) => right.length - left.length)[0]!
}

/**
 * A single-line slab of the untrusted source: the longest prose line plus the
 * verbatim Python block. No newlines, so it passes every existing draft field
 * check and is exactly what a hostile model would put in `background`.
 */
function hostileBackground(source: string): string {
  const lines = source.split(/\r?\n/u)
  const start = lines.findIndex((line) => line.startsWith('from dataclasses'))
  const end = lines.findIndex((line) => line.includes('llm_client'))
  const code = lines.slice(start, end + 1).map((line) => line.trim()).filter(Boolean).join(' ')
  return `${longestSourceLine(source)} ${code}`.slice(0, 3_900)
}

function createAnalyzer(seen: unknown[], result: AnyRecord): unknown {
  const analyze = async (...args: unknown[]) => {
    seen.push(args)
    return { draft: structuredClone(result) }
  }
  return Object.assign(analyze, { analyze, generate: analyze })
}

async function startServer(options: { analyzer: unknown }) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-character-persona-capability-'))
  roots.push(root)
  const server = await createCyberServer({
    stateRoot: root,
    workspacePath: root,
    port: 0,
    bootstrapDefaultWorld: true,
    runtime: quietRuntime,
    characterImportAnalyzer: options.analyzer,
  } as Parameters<typeof createCyberServer>[0])
  servers.push(server)
  const address = await server.start()
  return Object.assign(server, { origin: address.origin, root })
}

const quietRuntime: AgentRuntimePort = {
  async runTurn(request) {
    return { agentSessionId: `persona-capability-${request.agent.id}`, finalResponse: '测试回复', eventCount: 0 }
  },
  async close() {},
}

async function postJson(origin: string, path: string, body: unknown): Promise<{ status: number; body: AnyRecord }> {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json().catch(() => ({})) as AnyRecord }
}

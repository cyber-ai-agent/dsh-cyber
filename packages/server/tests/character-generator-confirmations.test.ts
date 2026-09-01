import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import type { AgentRuntimePort, CyberPackageManifest } from '@dsh-cyber/contracts'
import { EMPLOYEE_REQUESTABLE_CAPABILITIES, parseEmployeeBlueprintManifest } from '../src/employee-blueprint-manifest.js'
import { characterGeneratorMarketplaceRoot } from '../src/services/character-generator-marketplace.js'
import { CHARACTER_GENERATOR_CAPABILITIES, CharacterImportAnalyzer } from '../src/services/character-import-analyzer.js'
import { compileEmployeeBlueprintPackage } from '../src/services/employee-blueprint-package-compiler.js'
import { createCyberServer, type CyberServer } from '../src/index.js'

/**
 * B-FIX-5 / B-FIX-6 / B-FIX-9 confirmations for Character Generator V1.
 *
 * These tests exist to hold three already-intended properties in place:
 * the host-owned capability catalog, the inert `source/` provenance copy, and
 * a community fixture that is exercised entirely through the deterministic
 * analyzer stub without any network access.
 */

const fixturePath = join(process.cwd(), 'tests', 'fixtures', 'character-generator', 'engineering-ai-engineer.md')
/** Appears only inside the vendored Markdown body, never in a draft field. */
const SOURCE_ONLY_MARKER = 'from dataclasses import dataclass'

const servers: CyberServer[] = []
const roots: string[] = []

type AnyRecord = Record<string, any>

// B-FIX-9: every request this suite makes has to stay on the loopback test
// server. A real cloud model call would show up here as an external origin.
const externalRequests: string[] = []
const realFetch = globalThis.fetch

beforeAll(() => {
  globalThis.fetch = (async (input: any, init?: any) => {
    const target = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url)
    if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(target.hostname)) {
      externalRequests.push(target.origin)
      throw new Error(`Character Generator tests must not reach the network: ${target.origin}`)
    }
    return realFetch(input, init)
  }) as typeof fetch
})

afterAll(() => {
  globalThis.fetch = realFetch
  expect(externalRequests).toEqual([])
})

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('B-FIX-5 host-owned capability catalog', () => {
  it('serves exactly the hardcoded host safe set and nothing derived from a model', async () => {
    expect([...CHARACTER_GENERATOR_CAPABILITIES]).toEqual(['workspace:read', 'knowledge:read', 'artifact:read'])

    const server = await startServer()
    const workspace = server.store.listWorkspaces()[0]!
    const catalog = await getJson(server.origin, `/api/workspaces/${workspace.id}/character-generator/catalog?worldTemplateId=personal-world`)
    expect(catalog.status).toBe(200)
    const ids = (catalog.body.catalog.capabilities as AnyRecord[]).map((item) => item.id)
    expect(ids).toEqual([...CHARACTER_GENERATOR_CAPABILITIES])
    expect((catalog.body.capabilities as AnyRecord[]).map((item) => item.id)).toEqual([...CHARACTER_GENERATOR_CAPABILITIES])
  })

  it('rejects a model-invented capability id at publish instead of passing it through', async () => {
    const source = await readFile(fixturePath, 'utf8')
    const server = await startServer({ analyzer: stubAnalyzer(validDraft()) })
    const workspace = server.store.listWorkspaces()[0]!

    const published = await postJson(server.origin, `/api/workspaces/${workspace.id}/character-generator/publish`, {
      draft: { ...validDraft(), requestedCapabilities: ['workspace:read', 'admin:root'] },
      source: { kind: 'file', text: source, fileName: 'engineering-ai-engineer.md' },
      targetWorldTemplateId: 'personal-world',
    })
    expect(published.status, JSON.stringify(published.body)).toBe(422)
    expect(published.body.error.code).toBe('character_draft_capability_unknown')
    expect(await talentPackageDirectories(server.root, workspace.id)).toEqual([])
  })

  it('keeps the compiler gate identical to the host catalog', async () => {
    // The compiler owns no capability list of its own: it gates on the host
    // allowlist in employee-blueprint-manifest.ts. Asserting the two host-owned
    // constants agree is what keeps the gate and the generator catalog from
    // drifting apart, and it replaces the duplicated copy the compiler used to
    // carry — a second literal list here would reintroduce exactly that drift.
    expect([...EMPLOYEE_REQUESTABLE_CAPABILITIES]).toEqual([...CHARACTER_GENERATOR_CAPABILITIES])

    const root = await mkdtemp(join(tmpdir(), 'dsh-character-generator-compiler-'))
    roots.push(root)

    await expect(compileEmployeeBlueprintPackage({
      ...compilerInput(join(root, 'invented')),
      requestedCapabilities: ['workspace:read', 'admin:root'],
    })).rejects.toThrow(/Unsupported character capability/u)
    await expect(stat(join(root, 'invented'))).rejects.toThrow()

    const compiled = await compileEmployeeBlueprintPackage({
      ...compilerInput(join(root, 'allowed')),
      requestedCapabilities: [...CHARACTER_GENERATOR_CAPABILITIES],
    })
    // Installing a talent package needs exactly one capability. What the
    // employee REQUESTS is a separate layer, approved per employee at
    // recruitment, and must never be folded into the package's own permissions.
    expect(compiled.manifest.capabilities).toEqual(['employee:blueprint'])
    expect(compiled.blueprint.requestedCapabilities).toEqual([...CHARACTER_GENERATOR_CAPABILITIES])
  })
})

describe('B-FIX-5 dynamic host Skill catalog', () => {
  it('mirrors the live host Skill catalog and drops a model-invented skill id', async () => {
    const source = await readFile(fixturePath, 'utf8')
    const server = await startServer({
      analyzer: stubAnalyzer({ ...validDraft(), requestedSkillIds: ['made-up-skill'] }),
    })
    const workspace = server.store.listWorkspaces()[0]!

    const hostCatalog = await getJson(server.origin, `/api/workspaces/${workspace.id}/skill-catalog`)
    expect(hostCatalog.status).toBe(200)
    const hostSkillIds = (hostCatalog.body.items as AnyRecord[]).map((item) => item.id)
    expect(hostSkillIds.length).toBeGreaterThan(0)

    const generatorCatalog = await getJson(server.origin, `/api/workspaces/${workspace.id}/character-generator/catalog`)
    expect((generatorCatalog.body.catalog.skills as AnyRecord[]).map((item) => item.id)).toEqual(hostSkillIds)
    expect(hostSkillIds).not.toContain('made-up-skill')

    const analyzed = await postJson(server.origin, `/api/workspaces/${workspace.id}/character-generator/analyze`, {
      source: { kind: 'file', text: source, fileName: 'engineering-ai-engineer.md' },
      targetWorldTemplateId: 'personal-world',
    })
    expect(analyzed.status).toBe(200)
    expect(analyzed.body.draft.requestedSkillIds).toEqual([])

    const published = await postJson(server.origin, `/api/workspaces/${workspace.id}/character-generator/publish`, {
      draft: { ...validDraft(), requestedSkillIds: ['made-up-skill'] },
      source: { kind: 'file', text: source, fileName: 'engineering-ai-engineer.md' },
      targetWorldTemplateId: 'personal-world',
    })
    expect(published.status, JSON.stringify(published.body)).toBe(422)
    expect(published.body.error.code).toBe('character_draft_skill_unknown')

    const accepted = await postJson(server.origin, `/api/workspaces/${workspace.id}/character-generator/publish`, {
      draft: { ...validDraft(), requestedSkillIds: [hostSkillIds[0]!] },
      source: { kind: 'file', text: source, fileName: 'engineering-ai-engineer.md' },
      targetWorldTemplateId: 'personal-world',
    })
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(201)
    expect(accepted.body.blueprint.requestedSkills).toEqual([hostSkillIds[0]!])
  })
})

describe('B-FIX-6 source retention is provenance only', () => {
  it('retains the original Markdown under source/ while keeping it out of the runtime persona', async () => {
    const source = await readFile(fixturePath, 'utf8')
    const runtime = new RecordingRuntime()
    const server = await startServer({ analyzer: stubAnalyzer(validDraft()), runtime })
    const workspace = server.store.listWorkspaces()[0]!
    const world = server.store.listWorlds(workspace.id)[0]!

    const published = await postJson(server.origin, `/api/workspaces/${workspace.id}/character-generator/publish`, {
      draft: validDraft(),
      source: { kind: 'file', text: source, fileName: 'engineering-ai-engineer.md' },
      targetWorldTemplateId: 'personal-world',
    })
    expect(published.status, JSON.stringify(published.body)).toBe(201)
    const manifest = published.body.item.manifest as CyberPackageManifest
    const packageDirectory = join(talentRoot(server.root, workspace.id), manifest.id)

    // Provenance is retained verbatim.
    expect(await readFile(join(packageDirectory, 'source', 'original.md'), 'utf8')).toBe(source)
    expect(manifest.files.map((file) => file.path)).toContain('source/original.md')

    // ...but it is not an entrypoint, so nothing loads it as a declaration.
    expect(manifest.entrypoints).toEqual([
      { id: 'character-blueprint', kind: 'employee-blueprint', path: 'blueprint.json' },
    ])
    const blueprintText = await readFile(join(packageDirectory, 'blueprint.json'), 'utf8')
    expect(blueprintText).not.toContain(SOURCE_ONLY_MARKER)
    expect(published.body.blueprint.persona).not.toContain(SOURCE_ONLY_MARKER)

    const preview = server.packageManager.preview(workspace.id, manifest)
    const installed = await postJson(server.origin, `/api/workspaces/${workspace.id}/packages/install`, {
      manifest,
      sourceDirectory: packageDirectory,
      approvalToken: preview.approvalToken,
      worldId: world.id,
    })
    expect(installed.status, JSON.stringify(installed.body)).toBe(201)

    // The installed copy still carries provenance, and installing it produced
    // no blueprint field, capability or prompt derived from those bytes.
    const installedPath = (installed.body.installed as AnyRecord).installedPath as string
    expect(await readFile(join(installedPath, 'source', 'original.md'), 'utf8')).toBe(source)
    const blueprints = await getJson(server.origin, `/api/catalog/blueprints?worldId=${encodeURIComponent(world.id)}`)
    const blueprint = (blueprints.body.items as AnyRecord[]).find((item) => item.id === manifest.id)!
    expect(blueprint).toBeDefined()
    expect(JSON.stringify(blueprint)).not.toContain(SOURCE_ONLY_MARKER)

    const recruited = await postJson(server.origin, `/api/worlds/${world.id}/recruit`, {
      blueprintId: blueprint.id,
      blueprintVersion: blueprint.version,
      displayName: 'AI 工程主管',
      skillGrants: [],
    })
    expect(recruited.status, JSON.stringify(recruited.body)).toBe(201)
    const employee = recruited.body.employee as AnyRecord
    expect(JSON.stringify(server.store.getEmployeeDossier(employee.id))).not.toContain(SOURCE_ONLY_MARKER)

    const chat = await postJson(server.origin, `/api/worlds/${world.id}/chat`, {
      employeeIds: [employee.id],
      clientTurnId: 'character-generator-source-retention-1',
      prompt: '请给出上线前检查建议。',
    })
    expect(chat.status, JSON.stringify(chat.body)).toBe(200)
    expect(runtime.requests).toHaveLength(1)
    // The turn request is everything the runtime ever sees, persona and system
    // framing included. The retained source bytes are not in it.
    expect(JSON.stringify(runtime.requests)).not.toContain(SOURCE_ONLY_MARKER)
  })

  it('refuses any source-derived field on the blueprint declaration itself', () => {
    const base = {
      schemaVersion: 1,
      id: 'generated.character.test',
      version: 1,
      worldTemplateId: 'personal-world',
      displayName: 'AI 工程师',
      role: '机器学习工程师',
      summary: '摘要。',
      persona: '务实、数据驱动。',
      requestedSkills: [],
      requestedCapabilities: [],
      createdAt: '2026-09-01T00:00:00.000Z',
    }
    const context = { packageId: 'generated.character.test', packageCapabilities: ['employee:blueprint'] }
    expect(parseEmployeeBlueprintManifest(base, context).persona).toBe('务实、数据驱动。')
    for (const field of ['source', 'sourcePath', 'systemPrompt', 'sourceRefs']) {
      expect(() => parseEmployeeBlueprintManifest({ ...base, [field]: 'source/original.md' }, context))
        .toThrow(/Unknown employee blueprint field/u)
    }
  })

  /**
   * The retention decision itself, pinned so it is not re-litigated.
   *
   * `parseSource` keeps the RAW request text for `source/original.*` rather than
   * the NFC-normalized, trimmed form the rest of the pipeline runs on. That is
   * deliberate: this file is the reviewer's answer to "what did the human
   * actually hand us", and provenance that has been silently rewritten cannot
   * be diffed against the operator's own copy. The normalization exists to make
   * the DERIVED draft stable, not to sanitize the archive.
   *
   * It is safe because the archive is inert (the case above) and because the
   * raw form is independently bounded (the case below). If either of those two
   * stops holding, retain `source.text` instead — not before.
   */
  it('retains the raw request bytes verbatim rather than the normalized form', async () => {
    const server = await startServer({ analyzer: stubAnalyzer(validDraft()) })
    const workspace = server.store.listWorkspaces()[0]!

    // Differs from the validated form in exactly the two ways
    // normalizeCharacterSource rewrites text: NFD composition and a trailing
    // newline that trim() eats.
    const raw = '---\nname: 组合字符检查\n---\n\né decomposed acute.\n'
    expect(raw.normalize('NFC').trim()).not.toBe(raw)

    const published = await postJson(server.origin, `/api/workspaces/${workspace.id}/character-generator/publish`, {
      draft: validDraft(),
      source: { kind: 'file', text: raw, fileName: 'decomposed.md' },
      targetWorldTemplateId: 'personal-world',
    })
    expect(published.status, JSON.stringify(published.body)).toBe(201)
    const manifest = published.body.item.manifest as CyberPackageManifest
    const retained = await readFile(join(talentRoot(server.root, workspace.id), manifest.id, 'source', 'original.md'), 'utf8')
    expect(retained).toBe(raw)
    expect(retained).not.toBe(raw.normalize('NFC').trim())
  })

  it('bounds the raw retained bytes at 128 KiB even when the normalized form fits', async () => {
    const server = await startServer({ analyzer: stubAnalyzer(validDraft()) })
    const workspace = server.store.listWorkspaces()[0]!

    // UTF-8 NFD runs up to 3x the size of NFC, so the source boundary's 128 KiB
    // check on the NORMALIZED text is not a bound on what gets retained. The
    // compiler re-checks the raw bytes; without that, this body would land on
    // disk at 192 KiB.
    const raw = 'é'.repeat(64 * 1024)
    expect(Buffer.byteLength(raw.normalize('NFC'), 'utf8')).toBeLessThanOrEqual(128 * 1024)
    expect(Buffer.byteLength(raw, 'utf8')).toBe(192 * 1024)

    const published = await postJson(server.origin, `/api/workspaces/${workspace.id}/character-generator/publish`, {
      draft: validDraft(),
      source: { kind: 'file', text: raw, fileName: 'oversized.md' },
      targetWorldTemplateId: 'personal-world',
    })
    expect(published.status, JSON.stringify(published.body)).toBe(422)
    expect(await talentPackageDirectories(server.root, workspace.id)).toEqual([])
  })

  it('keeps every escape-capable control character out of the archive in any position', async () => {
    const server = await startServer({ analyzer: stubAnalyzer(validDraft()) })
    const workspace = server.store.listWorkspaces()[0]!

    // trim() strips only VT and FF from the edges, so those two are the entire
    // gap between the raw archive and the validated text. NUL and ESC are not
    // whitespace, so they survive trim() and are refused wherever they appear —
    // no terminal escape sequence can reach source/original.*.
    for (const control of [String.fromCharCode(0), String.fromCharCode(0x1b)]) {
      for (const raw of [`${control}角色`, `角色${control}`, `角${control}色`]) {
        const published = await postJson(server.origin, `/api/workspaces/${workspace.id}/character-generator/publish`, {
          draft: validDraft(),
          source: { kind: 'file', text: raw, fileName: 'control.md' },
          targetWorldTemplateId: 'personal-world',
        })
        expect(published.status, JSON.stringify(published.body)).toBe(422)
        expect(published.body.error.code).toBe('character_source_control_character')
      }
    }
    expect(await talentPackageDirectories(server.root, workspace.id)).toEqual([])
  })
})

describe('B-FIX-9 community fixture and offline analyzer contract', () => {
  it('uses the vendored community Markdown as the acceptance sample', async () => {
    const source = await readFile(fixturePath, 'utf8')
    expect(source.startsWith('---\nname: AI 工程师\n')).toBe(true)
    expect(source).toContain(SOURCE_ONLY_MARKER)
    const attribution = await readFile(join(process.cwd(), 'tests', 'fixtures', 'character-generator', 'README.md'), 'utf8')
    expect(attribution).toContain('jnMetaCode/agency-agents-zh')
  })

  it('fails closed without a configured model instead of dialing a provider', async () => {
    const source = await readFile(fixturePath, 'utf8')
    // No analyzer stub: this is the production wiring, so a missing model
    // profile must stop the request before any transport is opened.
    const server = await startServer()
    const workspace = server.store.listWorkspaces()[0]!
    const response = await postJson(server.origin, `/api/workspaces/${workspace.id}/character-generator/analyze`, {
      source: { kind: 'file', text: source, fileName: 'engineering-ai-engineer.md' },
      targetWorldTemplateId: 'personal-world',
    })
    expect([400, 422, 503]).toContain(response.status)
    expect(response.body.error.code).toBe('character_model_missing')
    expect(externalRequests).toEqual([])
  })

  it('holds the analyzer contract: real Markdown in, fake provider response, host normalization out', async () => {
    const source = await readFile(fixturePath, 'utf8')
    const dispatched: string[] = []
    const fakeFetch = (async (_url: URL | string, init?: RequestInit) => {
      dispatched.push(String(init?.body ?? ''))
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        displayName: 'AI 工程师',
        role: '机器学习工程师与 AI 系统架构师',
        summary: '可复现的 AI 工程化交付。',
        persona: '务实、数据驱动，以可复现的工程证据推进工作。',
        // Host-owned fields the model must never be able to set.
        targetWorldTemplateId: 'attacker-world',
        sourceRefs: ['source:attacker-owned'],
        schemaVersion: 99,
        requestedCapabilities: ['artifact:read', 'admin:root'],
        requestedSkillIds: ['coding', 'made-up-skill'],
      }) } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    const analyzer = new CharacterImportAnalyzer(
      {
        getWorkspace: () => ({ id: 'workspace-confirmations' }),
        listModelProfiles: () => [{
          id: 'profile-confirmations', workspaceId: 'workspace-confirmations', displayName: 'fake',
          providerKind: 'openai-compatible-remote', baseUrl: 'https://models.example.test/v1', modelId: 'fake',
          api: 'openai-completions', isDefault: true, settings: {},
          createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
        }],
      } as any,
      { resolve: () => 'fake-key' } as any,
      { listWorkspace: async () => [{ id: 'coding', displayName: '软件实现', summary: '代码实现' }] as any },
      { fetch: fakeFetch, resolveHostname: { resolve: async () => ['93.184.216.34'] } },
    )

    const { draft } = await analyzer.analyze({
      workspaceId: 'workspace-confirmations',
      targetWorldTemplateId: 'personal-world',
      source: { kind: 'file', fileName: 'engineering-ai-engineer.md', text: source },
    })

    expect(dispatched).toHaveLength(1)
    expect(dispatched[0]).toContain(SOURCE_ONLY_MARKER)
    expect(draft.schemaVersion).toBe(1)
    expect(draft.targetWorldTemplateId).toBe('personal-world')
    expect(draft.sourceRefs).toEqual(['source:engineering-ai-engineer.md'])
    expect(draft.requestedCapabilities).toEqual(['artifact:read'])
    expect(draft.requestedSkillIds).toEqual(['coding'])
    expect(externalRequests).toEqual([])
  })
})

class RecordingRuntime implements AgentRuntimePort {
  readonly requests: AnyRecord[] = []

  async runTurn(request: AnyRecord) {
    this.requests.push(request)
    return {
      agentSessionId: `character-generator-confirmations-${request.agent.id}`,
      finalResponse: '测试回复。',
      eventCount: 0,
    }
  }

  async close() {}
}

const quietRuntime: AgentRuntimePort = {
  async runTurn(request) {
    return { agentSessionId: `quiet-${request.agent.id}`, finalResponse: '测试回复。', eventCount: 0 }
  },
  async close() {},
}

function validDraft(): AnyRecord {
  return {
    schemaVersion: 1,
    targetWorldTemplateId: 'personal-world',
    displayName: 'AI 工程师',
    role: '机器学习工程师与 AI 系统架构师',
    summary: '精通机器学习模型开发与部署的 AI 工程专家。',
    persona: '务实、数据驱动、追求可复现性。',
    personalityTraits: ['务实'],
    // Deliberately benign: the separate `background` composition fix is another
    // agent's work, so this suite only asserts about the retained source bytes.
    background: '在多个模型上线项目中积累的工程经验。',
    requestedSkillIds: [],
    requestedCapabilities: [],
    sourceSummary: '来自用户提供的角色资料。',
    sourceRefs: [],
  }
}

function compilerInput(sourceDirectory: string) {
  return {
    sourceDirectory,
    packageId: 'generated.character.compilertest',
    packageVersion: '1.0.0',
    entrypointId: 'character-blueprint',
    worldTemplateId: 'personal-world',
    displayName: 'AI 工程师',
    role: '机器学习工程师',
    summary: '摘要。',
    persona: '务实、数据驱动。',
    createdAt: '2026-09-01T00:00:00.000Z',
    source: {
      originalText: '# 角色',
      originalFormat: 'md' as const,
      analysis: { schemaVersion: 1 },
      preview: { bytes: pngBytes(), mimeType: 'image/png' as const },
    },
  }
}

/**
 * A real PNG container: signature plus a complete IHDR. The server is the
 * authority on avatar bytes, so a truncated placeholder is refused as a
 * signature failure long before the capability gate is reached — a fixture that
 * never was a valid image is not a way to test the gate.
 */
function pngBytes(width = 64, height = 64): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(25)
  ihdr.writeUInt32BE(13, 0)
  ihdr.write('IHDR', 4, 'latin1')
  ihdr.writeUInt32BE(width, 8)
  ihdr.writeUInt32BE(height, 12)
  ihdr[16] = 8
  ihdr[17] = 6
  return Buffer.concat([signature, ihdr, Buffer.alloc(64)])
}

function stubAnalyzer(result: AnyRecord): unknown {
  const analyze = async () => ({ draft: structuredClone(result) })
  return { analyze }
}

async function startServer(options: { analyzer?: unknown; runtime?: AgentRuntimePort } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-character-generator-confirm-'))
  roots.push(root)
  const serverOptions = {
    stateRoot: root,
    workspacePath: root,
    port: 0,
    bootstrapDefaultWorld: true,
    runtime: options.runtime ?? quietRuntime,
    ...(options.analyzer === undefined ? {} : { characterImportAnalyzer: options.analyzer }),
  } as Parameters<typeof createCyberServer>[0]
  const server = await createCyberServer(serverOptions)
  servers.push(server)
  const address = await server.start()
  return Object.assign(server, { origin: address.origin, root })
}

/**
 * Generated talents are workspace-scoped on disk. The layout is derived from the
 * same helper the product writes through, so this suite cannot drift back onto
 * the pre-isolation global path and silently assert about an empty directory.
 */
function talentRoot(stateRoot: string, workspaceId: string): string {
  return join(characterGeneratorMarketplaceRoot(stateRoot, workspaceId), 'talent')
}

async function talentPackageDirectories(stateRoot: string, workspaceId: string): Promise<string[]> {
  try {
    return await readdir(talentRoot(stateRoot, workspaceId))
  } catch {
    return []
  }
}

async function postJson(origin: string, path: string, body: unknown): Promise<{ status: number; body: AnyRecord }> {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json().catch(() => ({})) as AnyRecord }
}

async function getJson(origin: string, path: string): Promise<{ status: number; body: AnyRecord }> {
  const response = await fetch(`${origin}${path}`)
  return { status: response.status, body: await response.json().catch(() => ({})) as AnyRecord }
}

import { readFile, readdir, rm, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { AgentRuntimePort } from '@dsh-cyber/contracts'
import { LocalPackageCatalog } from '@dsh-cyber/package-runtime'
import { createCyberServer, type CyberServer } from '../src/index.js'

const fixturePath = join(process.cwd(), 'tests', 'fixtures', 'character-generator', 'engineering-ai-engineer.md')
const servers: CyberServer[] = []
const roots: string[] = []

type AnyRecord = Record<string, any>

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Character Generator publish and runtime integration', () => {
  it('publishes a reviewed draft, discovers and installs it, then recruits independent chat identities', async () => {
    const source = await readFile(fixturePath, 'utf8')
    const analyzerCalls: unknown[] = []
    const runtime = new RecordingRuntime()
    const server = await startServer({
      analyzer: createAnalyzer(analyzerCalls, {
        schemaVersion: 1,
        targetWorldTemplateId: 'personal-world',
        displayName: 'AI 工程师',
        role: '机器学习工程师与 AI 系统架构师',
        summary: '从数据到上线构建可靠的 AI 系统。',
        persona: '务实、数据驱动、追求可复现性。',
        requestedSkillIds: [],
        requestedCapabilities: [],
      }),
      runtime,
    })
    const workspace = server.store.listWorkspaces()[0]!
    const world = server.store.listWorlds(workspace.id)[0]!
    const beforeInstalled = server.store.listInstalledPackages(workspace.id).map((item) => `${item.packageId}@${item.version}`)

    const analyzed = await postJson(server.origin, `/api/workspaces/${workspace.id}/character-generator/analyze`, {
      source: { kind: 'file', text: source, fileName: 'engineering-ai-engineer.md' },
      targetWorldTemplateId: 'personal-world',
    })
    expect(analyzed.status, JSON.stringify(analyzed.body)).toBe(200)
    expect(analyzerCalls.length).toBeGreaterThan(0)
    const draft = getDraft(analyzed.body)
    const editedDraft = {
      ...draft,
      displayName: 'AI 工程主管',
      name: 'AI 工程主管',
      persona: '只依据当前世界中可验证的工程证据工作，明确区分事实、建议和待验证假设。',
      requestedSkillIds: [],
    }

    const published = await postJson(server.origin, `/api/workspaces/${workspace.id}/character-generator/publish`, {
      draft: editedDraft,
      source: { kind: 'file', text: source, fileName: 'engineering-ai-engineer.md' },
      targetWorldTemplateId: 'personal-world',
    })
    expect(published.status, JSON.stringify(published.body)).toBe(201)
    const packageInfo = findPackageIdentity(published.body)
    expect(packageInfo.packageId).toBeTruthy()
    expect(server.store.listInstalledPackages(workspace.id).map((item) => `${item.packageId}@${item.version}`)).toEqual(beforeInstalled)

    const generatedRoot = join(server.root, 'workshop', 'character-generator', 'marketplace')
    const generatedCatalog = new LocalPackageCatalog(generatedRoot)
    const discovered = await generatedCatalog.list({ market: 'talent' })
    const generated = discovered.find((item) => item.manifest.id === packageInfo.packageId)
    expect(generated).toBeDefined()
    expect(generated?.verified).toBe(false)
    expect(generated?.manifest.kind).toBe('employee-blueprint')
    expect(generated?.manifest.entrypoints).toHaveLength(1)

    const preview = server.packageManager.preview(workspace.id, generated!.manifest)
    const installed = await postJson(server.origin, `/api/workspaces/${workspace.id}/packages/install`, {
      manifest: generated!.manifest,
      sourceDirectory: generated!.sourceDirectory,
      approvalToken: preview.approvalToken,
      worldId: world.id,
    })
    expect(installed.status, JSON.stringify(installed.body)).toBe(201)
    expect(server.store.getActivePackage(workspace.id, generated!.manifest.id)).toBeDefined()

    const blueprintCatalog = await getJson(server.origin, `/api/catalog/blueprints?worldId=${encodeURIComponent(world.id)}`)
    expect(blueprintCatalog.status).toBe(200)
    const blueprints = blueprintCatalog.body.items as AnyRecord[]
    const blueprint = blueprints.find((item) => item.id === generated!.manifest.id)
    expect(blueprint).toBeDefined()
    expect(blueprint.worldTemplateId ?? blueprint.targetWorldTemplateId).toBe('personal-world')
    expect(blueprint.persona.length).toBeLessThan(source.length)
    expect(blueprint.persona.length).toBeLessThanOrEqual(2_000)
    expect(blueprint.persona).not.toContain('from dataclasses')

    const firstRecruit = await postJson(server.origin, `/api/worlds/${world.id}/recruit`, {
      blueprintId: blueprint.id,
      blueprintVersion: blueprint.version,
      displayName: 'AI 工程主管甲',
      skillGrants: [],
    })
    const secondRecruit = await postJson(server.origin, `/api/worlds/${world.id}/recruit`, {
      blueprintId: blueprint.id,
      blueprintVersion: blueprint.version,
      displayName: 'AI 工程主管乙',
      skillGrants: [],
    })
    expect(firstRecruit.status, JSON.stringify(firstRecruit.body)).toBe(201)
    expect(secondRecruit.status, JSON.stringify(secondRecruit.body)).toBe(201)

    const firstEmployee = firstRecruit.body.employee as AnyRecord
    const secondEmployee = secondRecruit.body.employee as AnyRecord
    expect(firstEmployee.id).not.toBe(secondEmployee.id)
    expect(server.store.getEmployeeProfile(firstEmployee.id)).toBeDefined()
    expect(server.store.getEmployeeProfile(secondEmployee.id)).toBeDefined()
    expect(server.store.getEmployeeDossier(firstEmployee.id)?.revisions.length).toBeGreaterThan(0)
    expect(server.store.getEmployeeDossier(secondEmployee.id)?.revisions.length).toBeGreaterThan(0)
    expect(server.store.listSessions(world.id).filter((session) => session.kind === 'direct')).toHaveLength(3)

    const chat = await postJson(server.origin, `/api/worlds/${world.id}/chat`, {
      employeeIds: [firstEmployee.id],
      clientTurnId: 'character-generator-chat-1',
      prompt: '请基于当前世界的工程事实给出上线前检查建议。',
    })
    expect(chat.status, JSON.stringify(chat.body)).toBe(200)
    expect(runtime.requests).toHaveLength(1)
    expect(runtime.requests[0]!.agent.id).toBe(firstEmployee.id)
    expect(runtime.requests[0]!.prompt).toContain('上线前检查')
    expect(chat.body.replies?.[0]?.content ?? '').toContain('AI 工程师测试回复')

    const firstDossier = server.store.getEmployeeDossier(firstEmployee.id)!
    const secondDossier = server.store.getEmployeeDossier(secondEmployee.id)!
    expect(firstDossier.employee.id).not.toBe(secondDossier.employee.id)
    expect(firstDossier.revisions.at(-1)?.persona).not.toContain(source)

    const sourceFiles = await collectTextFiles(join(server.root, 'workshop', 'character-generator'))
    expect(sourceFiles.some((file) => file.content === source && Buffer.byteLength(file.content, 'utf8') > 5_000)).toBe(true)
    expect(sourceFiles.some((file) => file.content.includes('from dataclasses import dataclass'))).toBe(true)
  })
})

class RecordingRuntime implements AgentRuntimePort {
  readonly requests: AnyRecord[] = []

  async runTurn(request: AnyRecord) {
    this.requests.push(request)
    return {
      agentSessionId: `character-generator-runtime-${request.agent.id}`,
      finalResponse: 'AI 工程师测试回复：已完成上线前检查建议。',
      eventCount: 0,
    }
  }

  async close() {}
}

function createAnalyzer(seen: unknown[], result: AnyRecord): unknown {
  const analyze = async (...args: unknown[]) => {
    seen.push(args)
    return { draft: structuredClone(result) }
  }
  return Object.assign(analyze, { analyze, generate: analyze })
}

async function startServer(options: { analyzer: unknown; runtime: AgentRuntimePort }) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-character-generator-integration-'))
  roots.push(root)
  const serverOptions = {
    stateRoot: root,
    workspacePath: root,
    port: 0,
    bootstrapDefaultWorld: true,
    runtime: options.runtime,
    characterImportAnalyzer: options.analyzer,
  } as Parameters<typeof createCyberServer>[0]
  const server = await createCyberServer(serverOptions)
  servers.push(server)
  const address = await server.start()
  return Object.assign(server, { origin: address.origin, root })
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

function getDraft(body: AnyRecord): AnyRecord {
  return (body.draft ?? body.character ?? body) as AnyRecord
}

function findPackageIdentity(body: AnyRecord): { packageId: string; version?: string } {
  const candidates = [body.item, body.package, body.published, body.manifest, body.item?.manifest, body]
  for (const candidate of candidates) {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) continue
    const item = candidate as AnyRecord
    const packageId = item.packageId ?? item.id ?? item.manifest?.id
    if (typeof packageId === 'string' && packageId.length > 0) {
      const version = item.version ?? item.manifest?.version
      return { packageId, ...(typeof version === 'string' ? { version } : {}) }
    }
  }
  throw new Error(`publish response contains no package identity: ${JSON.stringify(body)}`)
}

async function collectTextFiles(root: string): Promise<Array<{ path: string; content: string }>> {
  const result: Array<{ path: string; content: string }> = []
  async function visit(directory: string): Promise<void> {
    let entries
    try { entries = await readdir(directory, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (/\.(md|markdown|txt)$/i.test(entry.name)) result.push({ path, content: await readFile(path, 'utf8') })
    }
  }
  await visit(root)
  return result
}

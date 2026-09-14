import { mkdtemp, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentRuntimePort, AgentTurnRequest, SkillAuthoringDraft } from '@dsh-cyber/contracts'

import { createCyberServer, type CyberServer } from '../src/index.js'

const servers: CyberServer[] = []
const roots: string[] = []
afterEach(async () => { for (const server of servers.splice(0)) await server.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

describe('Skill Center authoring routes', () => {
  it('analyzes, publishes, installs, loads and exposes one generated Skill package', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-skill-authoring-route-')); roots.push(root)
    const server = await createCyberServer({
      stateRoot: root, workspacePath: root, port: 0, bootstrapDefaultWorld: true, runtime: new QuietRuntime(),
      skillAuthoringAnalyzer: { analyze: async () => ({ draft }) },
    }); servers.push(server)
    const { origin } = await server.start()
    const workspace = (await get(origin, '/api/workspaces')).items[0]
    const world = (await get(origin, `/api/workspaces/${workspace.id}/worlds`)).items[0]

    const analyzed = await post(origin, `/api/workspaces/${workspace.id}/skill-authoring/analyze`, { source: { kind: 'description', text: '做发布检查' } })
    expect(analyzed.draft).toMatchObject({ id: draft.id, integrationId: 'builtin.recipe' })
    const published = await post(origin, `/api/workspaces/${workspace.id}/skill-authoring/publish`, { source: { kind: 'description', text: '做发布检查' }, draft })
    expect(published.item.manifest).toMatchObject({ kind: 'skill', version: '1.0.0', entrypoints: [{ id: draft.id, kind: 'skill' }] })

    const preview = await post(origin, `/api/workspaces/${workspace.id}/packages/preview`, { manifest: published.item.manifest })
    await post(origin, `/api/workspaces/${workspace.id}/packages/install`, { manifest: published.item.manifest, sourceDirectory: published.item.sourceDirectory, approvalToken: preview.approvalToken, worldId: world.id })
    const catalog = await get(origin, `/api/workspaces/${workspace.id}/skill-catalog`)
    expect(catalog.items).toContainEqual(expect.objectContaining({ id: draft.id, kind: 'recipe', worldAvailable: true }))
    const detail = await get(origin, `/api/workspaces/${workspace.id}/skills/${encodeURIComponent(draft.id)}/detail`)
    expect(detail).toMatchObject({ editable: true, tree: expect.arrayContaining([{ path: 'SKILL.md', kind: 'file' }]) })
    const edited = await post(origin, `/api/workspaces/${workspace.id}/skill-authoring/publish`, {
      source: { kind: 'description', text: '补充验收证据' }, draft: { ...draft, instructions: '核对测试、版本、风险、证据和回滚方案。' },
      basePackageId: published.item.manifest.id, basePackageVersion: published.item.manifest.version,
    })
    expect(edited.item.manifest).toMatchObject({ id: published.item.manifest.id, version: '1.0.1' })

    const settings = await put(origin, `/api/workspaces/${workspace.id}/skill-settings`, { scope: 'workspace', scopeId: workspace.id, skillIds: [draft.id] })
    expect(settings.global).toMatchObject({ configured: true, skillIds: [draft.id] })
    expect((await get(origin, `/api/worlds/${world.id}/skill-catalog`)).items.find((item: { id: string }) => item.id === draft.id)).toMatchObject({ worldAvailable: true })
  })

  it('imports a ZIP package through the fixed host directory and activates its World instance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-skill-import-route-')); roots.push(root)
    const server = await createCyberServer({
      stateRoot: root, workspacePath: root, port: 0, bootstrapDefaultWorld: true, runtime: new QuietRuntime(),
      skillAuthoringAnalyzer: { analyze: async () => ({ draft }) },
    }); servers.push(server)
    const { origin } = await server.start()
    const workspace = (await get(origin, '/api/workspaces')).items[0]
    const world = (await get(origin, `/api/workspaces/${workspace.id}/worlds`)).items[0]
    const skillBody = Buffer.from(JSON.stringify({
      schemaVersion: 1,
      id: 'custom.imported-check',
      displayName: '导入检查',
      summary: '验证导入流程。',
      routingHints: ['导入'],
      integrationId: 'builtin.recipe',
      dependencies: [],
      dataEgress: [],
      instructions: '检查包清单与文件完整性。',
    }, null, 2) + '\n')
    const packageBody = Buffer.from(JSON.stringify({
      schemaVersion: 1,
      id: 'external.skill.imported-check',
      version: '1.0.0',
      kind: 'skill',
      displayName: '导入检查包',
      summary: '用于验证技能包导入。',
      license: 'MIT',
      publisher: '测试发布者',
      capabilities: ['skill:recipe'],
      dataEgress: [],
      files: [{ path: 'skill.json', sha256: createHash('sha256').update(skillBody).digest('hex') }],
      entrypoints: [{ id: 'custom.imported-check', kind: 'skill', path: 'skill.json' }],
    }, null, 2) + '\n')
    const archive = zipStore([
      ['external.skill.imported-check/dsh-cyber.package.json', packageBody],
      ['external.skill.imported-check/skill.json', skillBody],
    ])
    const form = new FormData()
    form.append('files', new Blob([archive], { type: 'application/zip' }), 'imported-check.zip')
    form.append('worldId', world.id)
    const response = await fetch(`${origin}/api/workspaces/${workspace.id}/skill-authoring/import`, { method: 'POST', body: form })
    expect(response.status).toBe(201)
    const result = await response.json() as { installed: { packageId: string; version: string } }
    expect(result.installed).toMatchObject({ packageId: 'external.skill.imported-check', version: '1.0.0' })
    expect((await get(origin, `/api/workspaces/${workspace.id}/skill-catalog`)).items).toContainEqual(expect.objectContaining({ id: 'custom.imported-check', skillPackage: expect.objectContaining({ displayName: '导入检查包' }) }))
    expect((await get(origin, `/api/worlds/${world.id}/skill-catalog`)).items).toContainEqual(expect.objectContaining({ id: 'custom.imported-check', worldAvailable: true }))

    const folderForm = new FormData()
    folderForm.append('files', new Blob([packageBody], { type: 'application/json' }), 'dsh-cyber.package.json')
    folderForm.append('files', new Blob([skillBody], { type: 'application/json' }), 'skill.json')
    folderForm.append('relativePaths', JSON.stringify(['folder-root/dsh-cyber.package.json', 'folder-root/skill.json']))
    const folderResponse = await fetch(`${origin}/api/workspaces/${workspace.id}/skill-authoring/import`, { method: 'POST', body: folderForm })
    expect(folderResponse.status).toBe(201)
  })
})

const draft: SkillAuthoringDraft = { schemaVersion: 1, id: 'custom.release-check', displayName: '发布检查', summary: '检查发布前条件。', routingHints: ['发布', '检查'], integrationId: 'builtin.recipe', dependencies: [], dataEgress: [], instructions: '核对测试、版本、风险和回滚方案。', sourceSummary: '测试草稿。' }
class QuietRuntime implements AgentRuntimePort { async runTurn(request: AgentTurnRequest) { return { agentSessionId: request.agent.agentSessionId ?? 'quiet', finalResponse: '完成', eventCount: 0 } } async close() {} }
async function get(origin: string, path: string): Promise<any> { const response = await fetch(`${origin}${path}`); expect(response.status).toBe(200); return response.json() }
async function post(origin: string, path: string, body: unknown): Promise<any> { const response = await fetch(`${origin}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); expect(response.status).toBeLessThan(300); return response.json() }
async function put(origin: string, path: string, body: unknown): Promise<any> { const response = await fetch(`${origin}${path}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); expect(response.status).toBeLessThan(300); return response.json() }

function zipStore(entries: Array<[string, Buffer]>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const [name, body] of entries) {
    const nameBytes = Buffer.from(name, 'utf8')
    const crc = crc32(body)
    const local = Buffer.alloc(30 + nameBytes.length + body.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(body.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    nameBytes.copy(local, 30)
    body.copy(local, 30 + nameBytes.length)
    locals.push(local)

    const central = Buffer.alloc(46 + nameBytes.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(body.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    nameBytes.copy(central, 46)
    centrals.push(central)
    offset += local.length
  }
  const central = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(central.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, central, eocd])
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { gunzip } from 'node:zlib'

import { afterEach, describe, expect, it } from 'vitest'

import type { AgentRuntimePort, AgentTurnRequest, World } from '@dsh-cyber/contracts'
import { createCyberServer, type CyberServer } from '../src/index.js'

const gunzipAsync = promisify(gunzip)
const servers: CyberServer[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
})

class QuietRuntime implements AgentRuntimePort {
  async runTurn(request: AgentTurnRequest) {
    return { agentSessionId: request.agent.agentSessionId ?? `agent-${request.agent.id}`, finalResponse: 'ok', eventCount: 0 }
  }
  async close(): Promise<void> {}
}

async function start(stateRoot: string, bootstrapDefaultWorld = false) {
  const server = await createCyberServer({
    stateRoot,
    workspacePath: stateRoot,
    port: 0,
    runtime: new QuietRuntime(),
    bootstrapDefaultWorld,
  })
  servers.push(server)
  const address = await server.start()
  return { server, origin: address.origin }
}

async function json(origin: string, path: string, init?: RequestInit): Promise<{ response: Response; body: any }> {
  const response = await fetch(`${origin}${path}`, init)
  return { response, body: await response.json() }
}

async function createPersonalWorld(origin: string): Promise<{ workspaceId: string; world: World }> {
  const workspaceResult = await json(origin, '/api/workspaces', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '本地实例' }),
  })
  const workspaceId = workspaceResult.body.workspace.id as string
  const worldResult = await json(origin, `/api/workspaces/${workspaceId}/worlds`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '我的世界', templateId: 'personal-world' }),
  })
  return { workspaceId, world: worldResult.body.world as World }
}

describe('world experience stabilization', () => {
  it('uses the same personal-world template in server bootstrap and browser onboarding semantics', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-cyber-bootstrap-'))
    const { origin } = await start(stateRoot, true)
    const workspaces = await json(origin, '/api/workspaces')
    expect(workspaces.body.items).toHaveLength(1)
    const workspaceId = workspaces.body.items[0].id as string
    const worlds = await json(origin, `/api/workspaces/${workspaceId}/worlds`)
    expect(worlds.body.items).toHaveLength(1)
    expect(worlds.body.items[0]).toMatchObject({ name: '我的世界', templateId: 'personal-world' })
    const snapshot = await json(origin, `/api/worlds/${worlds.body.items[0].id}/snapshot`)
    expect(snapshot.body.employees.map((employee: { displayName: string }) => employee.displayName)).toEqual(['管家'])
  })

  it('stores new attachments inside the world without creating a second world lock', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-cyber-world-assets-'))
    const { origin } = await start(stateRoot)
    const { world } = await createPersonalWorld(origin)
    const source = Buffer.from('only this world may read me\n', 'utf8')

    const upload = await json(origin, `/api/worlds/${world.id}/assets/attachment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'private.txt', mimeType: 'text/plain', dataBase64: source.toString('base64') }),
    })
    expect(upload.response.status).toBe(201)
    const attachment = upload.body.attachment as { assetId: string; url: string }
    expect(attachment.url).toBe(`/api/worlds/${world.id}/assets/${attachment.assetId}`)

    const beforeLock = await fetch(`${origin}${attachment.url}`)
    expect(beforeLock.status).toBe(200)
    expect(Buffer.from(await beforeLock.arrayBuffer()).equals(source)).toBe(true)

    const password = await json(origin, `/api/worlds/${world.id}/access/password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'world-secret' }),
    })
    expect(password.response.status).toBe(410)

    const restored = await fetch(`${origin}${attachment.url}`)
    expect(restored.status).toBe(200)
    expect(Buffer.from(await restored.arrayBuffer()).equals(source)).toBe(true)
  })

  it('backs up database, worlds, world assets and packages while excluding cache and credentials', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-cyber-backup-'))
    const { origin } = await start(stateRoot)
    const { world } = await createPersonalWorld(origin)

    const currentSettings = await json(origin, `/api/worlds/${world.id}/settings`)
    expect(currentSettings.response.status).toBe(200)
    const savedSettings = await json(origin, `/api/worlds/${world.id}/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expectedRevision: currentSettings.body.revision,
        lore: '备份测试世界',
        scenario: '本地验证',
      }),
    })
    expect(savedSettings.response.status).toBe(200)
    const upload = await json(origin, `/api/worlds/${world.id}/assets/attachment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'backup.txt', mimeType: 'text/plain', dataBase64: Buffer.from('asset').toString('base64') }),
    })
    expect(upload.response.status).toBe(201)

    const worldRoot = join(stateRoot, 'worlds', encodeURIComponent(world.id))
    await mkdir(join(worldRoot, 'files'), { recursive: true })
    await writeFile(join(worldRoot, 'files', 'note.md'), '# kept\n')
    await mkdir(join(worldRoot, 'cache'), { recursive: true })
    await writeFile(join(worldRoot, 'cache', 'throw-away.tmp'), 'skip')
    await mkdir(join(stateRoot, 'packages', 'sample'), { recursive: true })
    await writeFile(join(stateRoot, 'packages', 'sample', 'manifest.txt'), 'package')
    await mkdir(join(stateRoot, 'credentials'), { recursive: true })
    await writeFile(join(stateRoot, 'credentials', 'secret.txt'), 'must-not-copy')

    const backup = await json(origin, '/api/system/backup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(backup.response.status).toBe(201)
    expect(backup.body).toMatchObject({ kind: 'backup', format: 'dsh-cyber-local-backup', bundle: true })
    const destination = backup.body.output as string
    expect((await stat(destination)).isFile()).toBe(true)
    expect(destination.endsWith('.dshbackup')).toBe(true)

    // Newline-delimited JSON: header record first, then one record per chunk.
    const lines = (await gunzipAsync(await readFile(destination))).toString('utf8').split('\n').filter(Boolean)
    const bundle = JSON.parse(lines[0]!) as { excluded: string[] }
    const records = lines.slice(1).map((line) => JSON.parse(line) as {
      path: string
      sha256: string
      chunkIndex: number
      dataBase64: string
    })
    const entries = new Map(records
      .filter((record) => record.chunkIndex === 0)
      .map((record) => [record.path, record]))
    expect(entries.has('database.sqlite')).toBe(true)
    expect(Buffer.from(entries.get(`worlds/${encodeURIComponent(world.id)}/settings.json`)!.dataBase64, 'base64').toString('utf8')).toContain('备份测试世界')
    expect(Buffer.from(entries.get(`worlds/${encodeURIComponent(world.id)}/files/note.md`)!.dataBase64, 'base64').toString('utf8')).toContain('# kept')
    expect([...entries.keys()].some((path) => path.startsWith(`worlds/${encodeURIComponent(world.id)}/assets/attachments/`))).toBe(true)
    expect(Buffer.from(entries.get('packages/sample/manifest.txt')!.dataBase64, 'base64').toString('utf8')).toBe('package')
    expect([...entries.keys()].some((path) => path.includes('/cache/'))).toBe(false)
    expect([...entries.keys()].some((path) => path.startsWith('credentials/'))).toBe(false)
    expect(bundle.excluded).toContain('credentials')
    for (const record of records) expect(record.sha256).toMatch(/^[a-f0-9]{64}$/)
  })
})

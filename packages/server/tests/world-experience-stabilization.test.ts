import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { AgentRuntimePort, AgentTurnRequest, World } from '@dsh-cyber/contracts'
import { createCyberServer, type CyberServer } from '../src/index.js'

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

function cookieFrom(response: Response): string {
  const raw = response.headers.get('set-cookie')
  if (!raw) throw new Error('missing set-cookie')
  return raw.split(';', 1)[0]!
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

  it('stores new attachments inside the world and requires that world access lock to read them', async () => {
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
    expect(password.response.status).toBe(200)

    const locked = await fetch(`${origin}${attachment.url}`)
    expect(locked.status).toBe(423)

    const unlock = await json(origin, `/api/worlds/${world.id}/access/unlock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'world-secret' }),
    })
    const cookie = cookieFrom(unlock.response)
    const restored = await fetch(`${origin}${attachment.url}`, { headers: { Cookie: cookie } })
    expect(restored.status).toBe(200)
    expect(Buffer.from(await restored.arrayBuffer()).equals(source)).toBe(true)
  })

  it('backs up database, worlds, world assets and packages while excluding cache and credentials', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-cyber-backup-'))
    const { origin } = await start(stateRoot)
    const { world } = await createPersonalWorld(origin)

    await json(origin, `/api/worlds/${world.id}/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lore: '备份测试世界', scenario: '本地验证' }),
    })
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

    const backup = await json(origin, '/api/system/backup', { method: 'POST', body: '{}' })
    expect(backup.response.status).toBe(201)
    expect(backup.body.kind).toBe('backup-bundle')
    const destination = backup.body.output as string

    await expect(stat(join(destination, 'database.sqlite'))).resolves.toBeDefined()
    await expect(readFile(join(destination, 'worlds', encodeURIComponent(world.id), 'settings.json'), 'utf8')).resolves.toContain('备份测试世界')
    await expect(readFile(join(destination, 'worlds', encodeURIComponent(world.id), 'files', 'note.md'), 'utf8')).resolves.toContain('# kept')
    await expect(stat(join(destination, 'worlds', encodeURIComponent(world.id), 'assets', 'attachments'))).resolves.toBeDefined()
    await expect(readFile(join(destination, 'packages', 'sample', 'manifest.txt'), 'utf8')).resolves.toBe('package')
    await expect(stat(join(destination, 'worlds', encodeURIComponent(world.id), 'cache', 'throw-away.tmp'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(join(destination, 'credentials', 'secret.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    const manifest = JSON.parse(await readFile(join(destination, 'backup-manifest.json'), 'utf8')) as { excluded: string[] }
    expect(manifest.excluded).toContain('credentials')
  })
})

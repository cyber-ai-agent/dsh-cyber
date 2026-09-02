import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { WorldImportAnalyzeResult, WorldThemeManifestV1 } from '@dsh-cyber/contracts'
import { validateWorldThemeManifest } from '@dsh-cyber/world-runtime'

import { createCyberServer, type CyberServer } from '../src/index.js'
import { AvatarImageError, decodeAvatarBase64 } from '../src/services/avatar-image-guard.js'
import { WORLD_BACKGROUND_MAX_BYTES } from '../src/services/world-theme-package-compiler.js'

/**
 * World Generator — the upload half of the scene answer.
 *
 * A user-supplied raster replaces the background image of an official scene
 * and nothing else: the anchors, navigation and interactables still come from
 * the official pick. The bytes walk the same boundary the Character Generator
 * avatar walks (magic-byte sniffed, byte-budgeted before decoding, file name
 * validated but never joined into a path) and then the same theme asset check
 * the installer runs, unchanged.
 */

type AnyRecord = Record<string, any>

const servers: CyberServer[] = []
const roots: string[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('World Generator background upload', () => {
  it('publishes a PNG background over an official scene and the installed theme references it', async () => {
    const server = await startServer()
    const workspace = server.store.listWorkspaces()[0]!
    const bytes = pngBytes(1536, 1024)
    const published = await publish(server, { scene: upload('official-moonlit-tavern', 'image/png', bytes) })
    expect(published.status, JSON.stringify(published.body)).toBe(201)
    const theme = published.body.theme as WorldThemeManifestV1
    expect(validateWorldThemeManifest(theme)).toEqual({ valid: true, errors: [] })
    // The geometry is the official scene's; only the background asset changed.
    expect(theme.scenes.map((scene) => scene.id)).toEqual(['moonlit-hall'])
    expect(theme.scenes[0]!.anchors.length).toBeGreaterThan(0)
    const background = theme.assets.find((asset) => asset.src === 'assets/background.png')
    expect(background).toMatchObject({ kind: 'image', pixelArt: false })
    expect(theme.scenes[0]!.layers.some((layer) => layer.assetId === background!.id)).toBe(true)
    expect(theme.assets.some((asset) => asset.src === 'assets/moonlit-tavern-world.png')).toBe(false)
    const files = (published.body.item.manifest.files as AnyRecord[]).map((file) => String(file.path))
    expect(files).toContain('assets/background.png')
    expect(files).not.toContain('assets/moonlit-tavern-world.png')

    // The market preview is the uploaded raster, byte for byte.
    const item = published.body.item as AnyRecord
    const preview = await fetch(`${server.origin}/api/marketplace/packages/${encodeURIComponent(item.manifest.id)}/${item.manifest.version}/preview?workspaceId=${encodeURIComponent(workspace.id)}`)
    expect(preview.status).toBe(200)
    expect(preview.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await preview.arrayBuffer()).equals(bytes)).toBe(true)

    // Install through the ordinary boundary; the active theme carries the upload.
    const approval = await postJson(server.origin, `/api/workspaces/${workspace.id}/marketplace/preview`, { packageId: item.manifest.id, version: item.manifest.version })
    expect(approval.status, JSON.stringify(approval.body)).toBe(200)
    const installed = await postJson(server.origin, `/api/workspaces/${workspace.id}/marketplace/install`, { packageId: item.manifest.id, version: item.manifest.version, approvalToken: approval.body.preview.approvalToken })
    expect(installed.status, JSON.stringify(installed.body)).toBe(201)
    const created = await postJson(server.origin, `/api/workspaces/${workspace.id}/marketplace/worlds`, { packageId: item.manifest.id, name: '上传背景的世界' })
    expect(created.status, JSON.stringify(created.body)).toBe(201)
    const binding = server.store.getWorldThemeBinding(created.body.world.id as string)
    expect(binding?.status).toBe('active')
    expect(binding?.manifest.assets.map((asset) => asset.src)).toContain('assets/background.png')
    const served = await fetch(`${server.origin}/api/worlds/${created.body.world.id}/theme-assets/${encodeURIComponent(background!.id)}`)
    expect(served.status).toBe(200)
    expect(Buffer.from(await served.arrayBuffer()).equals(bytes)).toBe(true)
  })

  it('stores JPEG bytes under a .jpg path even when the file name says PNG', async () => {
    const server = await startServer()
    const workspace = server.store.listWorkspaces()[0]!
    const bytes = jpegBytes(1440, 1080)
    const published = await publish(server, { scene: { ...upload('official-cyber-nocturne', 'image/jpeg', bytes), fileName: 'backdrop.png' } })
    expect(published.status, JSON.stringify(published.body)).toBe(201)
    const theme = published.body.theme as WorldThemeManifestV1
    expect(theme.assets.some((asset) => asset.src === 'assets/background.jpg')).toBe(true)
    expect(theme.assets.some((asset) => asset.src.endsWith('.png') && asset.kind === 'image')).toBe(false)
    const item = published.body.item as AnyRecord
    const preview = await fetch(`${server.origin}/api/marketplace/packages/${encodeURIComponent(item.manifest.id)}/${item.manifest.version}/preview?workspaceId=${encodeURIComponent(workspace.id)}`)
    expect(preview.headers.get('content-type')).toBe('image/jpeg')
  })

  it('refuses a declared type that disagrees with the bytes and containers that are not images', async () => {
    const server = await startServer()
    const mismatch = await publish(server, { scene: { ...upload('official-cyber-nocturne', 'image/png', jpegBytes()), fileName: 'backdrop.png' } })
    expect(mismatch.status, JSON.stringify(mismatch.body)).toBe(422)
    expect(mismatch.body.error.code).toBe('world_background_mime_mismatch')
    for (const [mimeType, bytes] of [
      ['image/png', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>', 'utf8')],
      ['image/png', Buffer.from('GIF89a', 'ascii')],
      ['image/webp', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    ] as const) {
      const response = await publish(server, { scene: upload('official-cyber-nocturne', mimeType, bytes) })
      expect(response.status, `${mimeType} ${JSON.stringify(response.body)}`).toBe(422)
      expect(response.body.error.code).toMatch(/^world_background_/u)
    }
    const themes = await getJson(server.origin, `/api/marketplace?market=theme&workspaceId=${encodeURIComponent(server.store.listWorkspaces()[0]!.id)}`)
    expect(themes.body.items.every((entry: AnyRecord) => entry.verified === true)).toBe(true)
  })

  it('refuses an oversized upload before decoding it', async () => {
    const server = await startServer()
    for (const extra of [5 * 1024 * 1024 + 1, WORLD_BACKGROUND_MAX_BYTES + 1]) {
      const oversize = Buffer.concat([pngBytes(256, 256), Buffer.alloc(extra)])
      const response = await publish(server, { scene: upload('official-cyber-nocturne', 'image/png', oversize) })
      expect(response.status, `${extra} -> ${JSON.stringify(response.body)}`).toBe(422)
      expect(response.body.error.code).toBe('world_background_size_invalid')
    }
    // The budget is checked on the encoded length: a payload that is both too
    // long and not base64 fails on size, so nothing past the budget is decoded.
    const encodedBudget = Math.ceil(WORLD_BACKGROUND_MAX_BYTES / 3) * 4
    expect(thrownCode(() => decodeAvatarBase64('!'.repeat(encodedBudget + 4), WORLD_BACKGROUND_MAX_BYTES))).toBe('character_avatar_size_invalid')
    expect(thrownCode(() => decodeAvatarBase64('!'.repeat(encodedBudget), WORLD_BACKGROUND_MAX_BYTES))).toBe('character_avatar_data_invalid')
  })

  it('refuses traversal and other hostile file names instead of rewriting them', async () => {
    const server = await startServer()
    for (const fileName of ['../../../../etc/passwd.png', '/etc/passwd.png', 'C:\\Windows\\evil.png', 'CON.png', '..', 'bidi\u202eGNP.exe.png', `${'a'.repeat(400)}.png`]) {
      const response = await publish(server, { scene: { ...upload('official-cyber-nocturne', 'image/png', pngBytes()), fileName } })
      expect(response.status, `${JSON.stringify(fileName)} -> ${JSON.stringify(response.body)}`).toBe(422)
      expect(response.body.error.code).toBe('world_background_filename_invalid')
    }
  })

  it('still binds the upload to an official scene from the allowlist', async () => {
    const server = await startServer()
    for (const id of ['../../marketplace/themes/official-cyber-nocturne', 'generated.world.other', '']) {
      const response = await publish(server, { scene: upload(id, 'image/png', pngBytes()) })
      expect(response.status, `${JSON.stringify(id)} -> ${JSON.stringify(response.body)}`).toBe(422)
      expect(response.body.error.code).toMatch(/^world_scene_/u)
    }
    const incomplete = await publish(server, { scene: { kind: 'upload', id: 'official-cyber-nocturne', fileName: 'a.png' } })
    expect(incomplete.status).toBe(422)
    expect(incomplete.body.error.code).toBe('world_scene_invalid')
  })
})

function thrownCode(run: () => unknown): string | undefined {
  try {
    run()
    return undefined
  } catch (error) {
    return error instanceof AvatarImageError ? error.code : String(error)
  }
}

function upload(id: string, mimeType: string, bytes: Buffer): AnyRecord {
  return { kind: 'upload', id, fileName: 'backdrop.png', mimeType, dataBase64: bytes.toString('base64') }
}

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

function jpegBytes(width = 64, height = 64): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00])
  const sof0 = Buffer.alloc(21)
  sof0[0] = 0xff
  sof0[1] = 0xc0
  sof0.writeUInt16BE(19, 2)
  sof0[4] = 8
  sof0.writeUInt16BE(height, 5)
  sof0.writeUInt16BE(width, 7)
  sof0[9] = 3
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof0, Buffer.from([0xff, 0xd9]), Buffer.alloc(32)])
}

async function publish(server: { origin: string; store: { listWorkspaces(): Array<{ id: string }> } }, overrides: AnyRecord): Promise<{ status: number; body: AnyRecord }> {
  const workspaceId = server.store.listWorkspaces()[0]!.id
  const source = { kind: 'paste' as const, text: '一家社区法律援助诊所，律师、助理和志愿者分工推进来访者的问题梳理。'.repeat(4) }
  const analyzed = await postJson(server.origin, `/api/workspaces/${workspaceId}/world-generator/analyze`, { source })
  expect(analyzed.status, JSON.stringify(analyzed.body)).toBe(200)
  return postJson(server.origin, `/api/workspaces/${workspaceId}/world-generator/publish`, { source, draft: analyzed.body.draft, ...overrides })
}

async function startServer() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-world-generator-upload-'))
  roots.push(root)
  const server = await createCyberServer({
    stateRoot: root,
    workspacePath: root,
    port: 0,
    bootstrapDefaultWorld: true,
    worldImportAnalyzer: staticAnalyzer(),
  } as Parameters<typeof createCyberServer>[0])
  servers.push(server)
  const address = await server.start()
  return Object.assign(server, { origin: address.origin, root })
}

function staticAnalyzer() {
  return {
    async analyze(): Promise<WorldImportAnalyzeResult> {
      return {
        draft: {
          schemaVersion: 1,
          targetWorldTemplateId: 'personal-world',
          displayName: '社区法律援助诊所',
          summary: '面向社区居民的小型法律援助诊所。',
          terminology: { world: '诊所', participant: '成员', session: '案情会', milestone: '办案记录' },
          workflow: ['来访登记', '问题梳理'],
          rules: ['只根据来访者提供的材料判断。'],
          cast: [{
            schemaVersion: 1,
            targetWorldTemplateId: 'personal-world',
            displayName: '值班律师',
            role: '法律评估',
            summary: '负责法律评估和最终建议。',
            persona: '只依据来访者提供的材料判断，时效问题当天标红。',
            personalityTraits: [],
            background: '',
            requestedSkillIds: [],
            requestedCapabilities: [],
            sourceSummary: '来自用户提供的世界资料。',
            sourceRefs: ['source:paste'],
          }],
          sourceSummary: '来自用户提供的世界资料。',
          sourceRefs: ['source:paste'],
        },
      }
    },
  }
}

async function postJson(origin: string, path: string, body: unknown): Promise<{ status: number; body: AnyRecord }> {
  const response = await fetch(`${origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: response.status, body: await response.json().catch(() => ({})) as AnyRecord }
}

async function getJson(origin: string, path: string): Promise<{ status: number; body: AnyRecord }> {
  const response = await fetch(`${origin}${path}`)
  return { status: response.status, body: await response.json().catch(() => ({})) as AnyRecord }
}

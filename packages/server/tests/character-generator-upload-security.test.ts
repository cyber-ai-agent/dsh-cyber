import { mkdir, mkdtemp, readdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createCyberServer, type CyberServer } from '../src/index.js'
import { characterGeneratorMarketplaceRoot } from '../src/services/character-generator-marketplace.js'

const servers: CyberServer[] = []
const roots: string[] = []

type AnyRecord = Record<string, any>

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Character Generator avatar upload boundary', () => {
  it('rejects bytes that only look like WebP once the high bit is masked away', async () => {
    const server = await startServer()
    const response = await publish(server, { avatar: upload('image/webp', highBitWebp()) })
    expect(response.status, JSON.stringify(response.body)).toBe(422)
    expect(errorCode(response.body)).toMatch(/avatar/u)
  })

  it('rejects a container that declares an image type but carries no supported image', async () => {
    const server = await startServer()
    for (const [mimeType, bytes] of [
      ['image/png', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>', 'utf8')],
      ['image/png', Buffer.from('GIF89a', 'ascii')],
      ['image/png', jpegBytes(32, 32)],
      ['image/jpeg', pngBytes(32, 32)],
      ['image/webp', pngBytes(32, 32)],
      ['image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    ] as const) {
      const response = await publish(server, { avatar: upload(mimeType, bytes) })
      expect(response.status, `${mimeType} ${JSON.stringify(response.body)}`).toBe(422)
    }
  })

  it('rejects an image header that declares an implausible pixel surface', async () => {
    const server = await startServer()
    const png = await publish(server, { avatar: upload('image/png', pngBytes(30_000, 30_000)) })
    expect(png.status, JSON.stringify(png.body)).toBe(422)
    const jpeg = await publish(server, { avatar: upload('image/jpeg', jpegBytes(30_000, 30_000)) })
    expect(jpeg.status, JSON.stringify(jpeg.body)).toBe(422)
    const webp = await publish(server, { avatar: upload('image/webp', webpBytes(30_000, 30_000)) })
    expect(webp.status, JSON.stringify(webp.body)).toBe(422)
  })

  it('rejects hostile upload file names instead of silently rewriting them', async () => {
    const server = await startServer()
    for (const fileName of [
      '../../../../etc/passwd.png',
      '/etc/passwd.png',
      '..%2f..%2fescape.png',
      'C:\\Windows\\System32\\evil.png',
      'CON.png',
      'nul.PNG',
      'trailing.png.',
      '..',
      '.',
      `${'a'.repeat(400)}.png`,
      'bidi\u202eGNP.exe.png',
      'nbsp\u00a0\u200b.png',
    ]) {
      const response = await publish(server, { avatar: { ...upload('image/png', pngBytes()), fileName } })
      expect(response.status, `${JSON.stringify(fileName)} -> ${JSON.stringify(response.body)}`).toBe(422)
      expect(errorCode(response.body)).toMatch(/avatar/u)
    }
  })

  it('still accepts a well formed upload and stores it under the sniffed extension', async () => {
    const server = await startServer()
    const response = await publish(server, { avatar: upload('image/png', pngBytes(256, 256)) })
    expect(response.status, JSON.stringify(response.body)).toBe(201)
    const files = (response.body.item?.manifest?.files ?? []).map((file: AnyRecord) => String(file.path))
    expect(files).toContain('preview.png')
  })

  it('rejects an upload larger than 5 MiB', async () => {
    const server = await startServer()
    const oversize = Buffer.concat([pngBytes(256, 256), Buffer.alloc(5 * 1024 * 1024)])
    const response = await publish(server, { avatar: upload('image/png', oversize) })
    expect(response.status, JSON.stringify(response.body)).toBe(422)
  })

  it('rejects base64 that is not a canonical encoding', async () => {
    const server = await startServer()
    for (const dataBase64 of ['', 'not base64!', 'AAAA\nAAAA', '../wAAAA', 'QQ']) {
      const response = await publish(server, { avatar: { kind: 'upload', fileName: 'a.png', mimeType: 'image/png', dataBase64 } })
      expect(response.status, `${JSON.stringify(dataBase64)} -> ${JSON.stringify(response.body)}`).toBe(422)
    }
  })

  it('refuses to publish through a symlinked directory component under the state root', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'dsh-character-generator-outside-'))
    roots.push(outside)
    const server = await startServer(async (root) => {
      await mkdir(join(root, 'workshop'), { recursive: true })
      await symlink(outside, join(root, 'workshop', 'character-generator'), 'dir')
    })
    const response = await publish(server, { avatar: upload('image/png', pngBytes()) })
    expect(response.status, JSON.stringify(response.body)).toBe(422)
    expect(await readdir(outside)).toEqual([])
  })

  it('refuses to publish when the talent directory itself is a symlink out of the root', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'dsh-character-generator-outside-'))
    roots.push(outside)
    const server = await startServer()
    // Generated talents are workspace-scoped, so the hostile link has to be
    // planted on the path the publish actually walks. The workspace id only
    // exists after boot, and the root is derived from the same helper the
    // product writes through so this can never drift back onto a path the
    // guard is not asked about.
    const workspaceId = server.store.listWorkspaces()[0]!.id
    const marketplaceRoot = characterGeneratorMarketplaceRoot(server.root, workspaceId)
    await mkdir(marketplaceRoot, { recursive: true })
    await symlink(outside, join(marketplaceRoot, 'talent'), 'dir')

    const response = await publish(server, { avatar: upload('image/png', pngBytes()) })
    expect(response.status, JSON.stringify(response.body)).toBe(422)
    expect(await readdir(outside)).toEqual([])
  })
})

function errorCode(body: AnyRecord): string {
  return String(body?.error?.code ?? body?.code ?? '')
}

function upload(mimeType: string, bytes: Buffer): AnyRecord {
  return { kind: 'upload', fileName: 'avatar.png', mimeType, dataBase64: bytes.toString('base64') }
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

function webpBytes(width = 64, height = 64): Buffer {
  const chunk = Buffer.alloc(18)
  chunk.write('VP8X', 0, 'latin1')
  chunk.writeUInt32LE(10, 4)
  chunk.writeUIntLE(width - 1, 12, 3)
  chunk.writeUIntLE(height - 1, 15, 3)
  const riff = Buffer.alloc(12)
  riff.write('RIFF', 0, 'latin1')
  riff.writeUInt32LE(4 + chunk.byteLength, 4)
  riff.write('WEBP', 8, 'latin1')
  return Buffer.concat([riff, chunk])
}

/**
 * Not a WebP: every magic byte carries the high bit set, so it only decodes to
 * "RIFF"/"WEBP" through Node's lossy 7-bit `ascii` decoder.
 */
function highBitWebp(): Buffer {
  const bytes = Buffer.alloc(64)
  bytes.set([0xd2, 0xc9, 0xc6, 0xc6], 0)
  bytes.writeUInt32LE(56, 4)
  bytes.set([0xd7, 0xc5, 0xc2, 0xd0], 8)
  return bytes
}

async function startServer(prepare?: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-character-generator-upload-'))
  roots.push(root)
  await prepare?.(root)
  const server = await createCyberServer({
    stateRoot: root,
    workspacePath: root,
    port: 0,
    bootstrapDefaultWorld: true,
    characterImportAnalyzer: stubAnalyzer(),
  } as Parameters<typeof createCyberServer>[0])
  servers.push(server)
  const address = await server.start()
  return Object.assign(server, { origin: address.origin, root })
}

function stubAnalyzer(): unknown {
  const analyze = async () => ({ draft: structuredClone(draftTemplate) })
  return Object.assign(analyze, { analyze, generate: analyze })
}

const draftTemplate = {
  schemaVersion: 1,
  targetWorldTemplateId: 'personal-world',
  displayName: '资料整理员',
  role: '资料整理与归档助理',
  summary: '把零散材料整理成可检索的条目。',
  persona: '只依据当前世界中可验证的材料回答，区分事实与假设。',
  personalityTraits: [],
  background: '',
  requestedSkillIds: [],
  requestedCapabilities: [],
}

async function publish(
  server: { origin: string; store: { listWorkspaces(): Array<{ id: string }> } },
  overrides: AnyRecord,
): Promise<{ status: number; body: AnyRecord }> {
  const workspaceId = server.store.listWorkspaces()[0]!.id
  const response = await fetch(`${server.origin}/api/workspaces/${workspaceId}/character-generator/publish`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      draft: structuredClone(draftTemplate),
      source: { kind: 'paste', text: '整理员：负责把零散材料归档成条目。' },
      targetWorldTemplateId: 'personal-world',
      ...overrides,
    }),
  })
  return { status: response.status, body: (await response.json().catch(() => ({}))) as AnyRecord }
}

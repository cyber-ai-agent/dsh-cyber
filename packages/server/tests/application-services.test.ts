import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { SqliteStore } from '@dsh-cyber/persistence'

import { AssetService } from '../src/services/asset-service.js'
import { ServiceError } from '../src/services/service-error.js'
import { WorldFileService } from '../src/services/world-file-service.js'
import { WorldRootService } from '../src/services/world-root-service.js'
import { WorkspaceFileService } from '../src/services/workspace-file-service.js'

const temporaryRoots: string[] = []

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('AssetService', () => {
  it('removes the committed file when persistence fails', async () => {
    const stateRoot = await temporaryRoot()
    const store = {
      getWorkspace: () => ({}),
      saveLocalAsset: () => { throw new Error('database rejected asset') },
      getLocalAsset: () => undefined,
    } as unknown as Pick<SqliteStore, 'getWorkspace' | 'saveLocalAsset' | 'getLocalAsset'>
    const assets = new AssetService(store, stateRoot)

    await expect(assets.uploadBackground({
      workspaceId: 'workspace-1',
      mimeType: 'image/png',
      dataBase64: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64'),
    })).rejects.toThrow('database rejected asset')

    expect(await readdir(join(stateRoot, 'assets', 'workspace-1'))).toEqual([])
  })
})

describe('WorldFileService', () => {
  it('stores attachments under the owning world and verifies them on read', async () => {
    const stateRoot = await temporaryRoot()
    const roots = new WorldRootService(stateRoot)
    const files = new WorldFileService(roots)
    const source = Buffer.from('private world note\n', 'utf8')

    const attachment = await files.uploadAttachment('world-a', {
      name: 'note.txt',
      mimeType: 'text/plain',
      dataBase64: source.toString('base64'),
    })
    expect(attachment.url).toContain('/api/worlds/world-a/assets/')

    const worldRoot = await roots.ensure('world-a')
    const entries = await readdir(join(worldRoot.assetsPath, 'attachments'))
    expect(entries.some((entry) => entry === `${attachment.assetId}.txt`)).toBe(true)
    expect(entries.some((entry) => entry === `${attachment.assetId}.json`)).toBe(true)

    const restored = await files.readAttachment('world-a', attachment.assetId)
    expect(restored.contentType).toBe('text/plain')
    expect(restored.body.equals(source)).toBe(true)
    await expect(files.readAttachment('world-b', attachment.assetId)).rejects.toMatchObject<ServiceError>({
      kind: 'not-found',
      code: 'asset_not_found',
    })
    const metadata = JSON.parse(await readFile(join(worldRoot.assetsPath, 'attachments', `${attachment.assetId}.json`), 'utf8')) as { name: string }
    expect(metadata.name).toBe('note.txt')
  })
})

describe('WorkspaceFileService', () => {
  it('lists safe files while rejecting hidden and traversal paths', async () => {
    const root = await temporaryRoot()
    await mkdir(join(root, 'src'))
    await writeFile(join(root, 'src', 'main.ts'), 'export {}\n')
    await writeFile(join(root, '.env'), 'SECRET=redacted\n')
    const files = new WorkspaceFileService(root)

    const listing = await files.list('')
    expect(listing.items.map((item) => item.name)).toEqual(['src'])
    await expect(files.preview('../outside.txt')).rejects.toMatchObject<ServiceError>({
      kind: 'forbidden',
      code: 'workspace_path_rejected',
    })
  })

  it('accepts a workspace root expressed as a Windows 8.3 short name', async () => {
    const root = await temporaryRoot()
    const expandedRoot = await realpath(root)
    if (expandedRoot === root) return
    await mkdir(join(root, 'src'))
    await writeFile(join(root, 'src', 'main.ts'), 'export {}\n')
    const files = new WorkspaceFileService(root)

    const listing = await files.list('')
    expect(listing.items.map((item) => item.name)).toEqual(['src'])
  })
})

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cyber-service-'))
  temporaryRoots.push(root)
  return root
}

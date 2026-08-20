import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { SqliteStore } from '@dsh-cyber/persistence'

import { AssetService } from '../src/services/asset-service.js'
import { ServiceError } from '../src/services/service-error.js'
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
})

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cyber-service-'))
  temporaryRoots.push(root)
  return root
}

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { WorldAccessService } from '../src/services/world-access-service.js'
import { WorldRootService } from '../src/services/world-root-service.js'

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('WorldAccessService', () => {
  it('does not create or enforce a per-world password lock', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-world-access-'))
    cleanup.push(stateRoot)
    const service = new WorldAccessService(new WorldRootService(stateRoot))

    await expect(service.summary('world-1', request())).resolves.toEqual({
      worldId: 'world-1',
      passwordEnabled: false,
      unlocked: true,
    })
    await expect(service.assertUnlocked('world-1', request())).resolves.toBeUndefined()
    await expect(service.setPassword('world-1', 'secret', response())).rejects.toMatchObject({ status: 410, code: 'world_access_disabled' })
  })

  it('ignores and can remove a legacy per-world lock file without touching world data', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-world-access-'))
    cleanup.push(stateRoot)
    const roots = new WorldRootService(stateRoot)
    const root = await roots.ensure('legacy-world')
    await writeFile(join(root.rootPath, '.access.json'), '{"schemaVersion":1}\n', 'utf8')
    await writeFile(join(root.filesPath, 'keep.txt'), 'keep', 'utf8')
    const service = new WorldAccessService(roots)

    await expect(service.summary('legacy-world', request())).resolves.toMatchObject({ passwordEnabled: false, unlocked: true })
    await service.clearPassword('legacy-world', response())
    await expect(readFile(join(root.rootPath, '.access.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(root.filesPath, 'keep.txt'), 'utf8')).resolves.toBe('keep')
  })
})

function request(): IncomingMessage {
  return { headers: {}, socket: { remoteAddress: '127.0.0.1' } } as IncomingMessage
}

function response(): ServerResponse {
  return { setHeader() { return this } } as ServerResponse
}

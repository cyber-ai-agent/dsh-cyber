import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { WorldRootService } from '../src/services/world-root-service.js'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('WorldRootService compensation cleanup', () => {
  it('removes only the managed world root created for a world id', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-cyber-world-root-compensation-'))
    roots.push(stateRoot)
    const service = new WorldRootService(stateRoot)
    const world = await service.ensure('world/with-special-id')

    await expect(access(world.rootPath)).resolves.toBeUndefined()
    await service.remove('world/with-special-id')
    await expect(access(world.rootPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

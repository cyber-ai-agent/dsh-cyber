import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createCyberServer } from '../src/server.js'
import { createLocalBackupBundle, restoreLocalBackupBundle } from '../src/services/local-backup-service.js'
import { acquireStateRootLease } from '../src/services/state-root-lease.js'

it('refuses live restore and duplicate server ownership, then permits offline restore', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cyber-server-lease-'))
  const options = { stateRoot: root, workspacePath: root, port: 0 }
  const server = await createCyberServer(options)
  try {
    const address = await server.start()
    expect((await fetch(`${address.origin}/api/health`)).status).toBe(200)
    const backup = await createLocalBackupBundle(root, server.store)
    await expect(createCyberServer(options)).rejects.toThrow('本地数据正在使用中')
    await expect(restoreLocalBackupBundle(root, backup, { force: true })).rejects.toThrow('本地数据正在使用中')
    expect(server.store.doctor().ok).toBe(true)
    await server.close()
    await expect(restoreLocalBackupBundle(root, backup, { force: true })).resolves.toMatchObject({ stateRoot: root })
    const restarted = await createCyberServer(options)
    await restarted.close()
  } finally {
    await server.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('releases ownership when server construction fails before it starts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cyber-server-lease-failure-'))
  try {
    await expect(createCyberServer({ stateRoot: root, workspacePath: join(root, 'missing'), port: 0 })).rejects.toThrow()
    const release = await acquireStateRootLease(root)
    await release()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

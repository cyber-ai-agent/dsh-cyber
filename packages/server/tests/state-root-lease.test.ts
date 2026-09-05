import { fork } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { expect, it } from 'vitest'
import { acquireStateRootLease } from '../src/services/state-root-lease.js'

it('excludes a second owner and releases the same lock idempotently', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cyber-lease-'))
  let release: (() => Promise<void>) | undefined
  try {
    release = await acquireStateRootLease(root)
    await expect(acquireStateRootLease(root)).rejects.toThrow('本地数据正在使用中')
    await release()
    await release()
    release = await acquireStateRootLease(root)
  } finally {
    await release?.()
    await rm(root, { recursive: true, force: true })
  }
})

it('the OS releases an exclusive lease after the owner process is killed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cyber-lease-crash-'))
  const script = join(root, 'owner.mjs')
  await writeFile(script, `import { DatabaseSync } from 'node:sqlite';
    const database = new DatabaseSync(process.argv[2]);
    database.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;');
    process.send('locked');
    setInterval(() => {}, 1000);
  `)
  const child = fork(script, [join(root, '.state-root-lease.sqlite')], { silent: true })
  try {
    const [message] = await once(child, 'message')
    expect(message).toBe('locked')
    await expect(acquireStateRootLease(root)).rejects.toThrow('本地数据正在使用中')
    const exited = once(child, 'exit')
    child.kill('SIGKILL')
    await exited
    const release = await acquireStateRootLease(root)
    await release()
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill('SIGKILL')
      await exited
    }
    await rm(root, { recursive: true, force: true })
  }
})

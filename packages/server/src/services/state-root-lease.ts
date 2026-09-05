import { mkdir, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/**
 * A separate SQLite file supplies an OS-backed, process-lifetime advisory lock.
 * It lives outside every restored root. Never unlink this file: replacing its
 * inode would let a second owner acquire a different lock for the same state.
 * SQLite releases its file locks even if the owning process crashes.
 */
export async function acquireStateRootLease(stateRoot: string): Promise<() => Promise<void>> {
  await mkdir(resolve(stateRoot), { recursive: true })
  const root = await realpath(resolve(stateRoot))
  const database = new DatabaseSync(join(root, '.state-root-lease.sqlite'))
  try {
    database.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;')
  } catch (error) {
    database.close()
    const code = (error as { errcode?: number }).errcode
    if (code === 5 || code === 6) {
      throw new Error('本地数据正在使用中，请先关闭该数据目录对应的服务再恢复或重新启动。', { cause: error })
    }
    throw error
  }
  let released = false
  return async () => {
    if (released) return
    released = true
    try {
      database.exec('ROLLBACK')
    } finally {
      database.close()
    }
  }
}

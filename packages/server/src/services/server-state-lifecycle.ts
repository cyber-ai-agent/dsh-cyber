import type { SqliteStore } from '@dsh-cyber/persistence'
import { acquireStateRootLease } from './state-root-lease.js'
import { recoverLocalRestoreTransactions } from './local-backup-service.js'

/** Own the filesystem generation before the server opens any business data. */
export async function createServerWithStateRootLease<
  Options extends { stateRoot: string },
  Server extends { start(): Promise<unknown>; close(): Promise<void> },
>(
  options: Options,
  create: (options: Options, onStoreOpened: (store: SqliteStore) => void) => Promise<Server>,
): Promise<Server> {
  const release = await acquireStateRootLease(options.stateRoot)
  let openedStore: SqliteStore | undefined
  try {
    await recoverLocalRestoreTransactions(options.stateRoot)
    const server = await create(options, (store) => { openedStore = store })
    let closing: Promise<void> | undefined
    const close = (): Promise<void> => {
      closing ??= (async () => {
        await server.close()
        await release()
      })()
      return closing
    }
    return {
      ...server,
      async start() {
        try {
          return await server.start()
        } catch (error) {
          await close()
          throw error
        }
      },
      close,
    }
  } catch (error) {
    openedStore?.close()
    await release()
    throw error
  }
}

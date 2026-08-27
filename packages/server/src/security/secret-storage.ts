import { randomUUID } from 'node:crypto'
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Port for a future Keychain, DPAPI, Secret Service, or durable file fallback. */
export interface SecretStoragePort {
  read(): Promise<Buffer | undefined>
  write(value: Buffer): Promise<void>
  delete(): Promise<void>
}

export interface AtomicFileOperations {
  mkdir: typeof mkdir
  open: typeof open
  rename: typeof rename
  rm: typeof rm
  chmod: typeof chmod
  readFile: typeof readFile
}

const DEFAULT_OPERATIONS: AtomicFileOperations = { mkdir, open, rename, rm, chmod, readFile }

export class AtomicFileSecretStorage implements SecretStoragePort {
  readonly #path: string
  readonly #operations: AtomicFileOperations

  constructor(path: string, operations: AtomicFileOperations = DEFAULT_OPERATIONS) {
    this.#path = path
    this.#operations = operations
  }

  async read(): Promise<Buffer | undefined> {
    try {
      return await this.#operations.readFile(this.#path)
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return undefined
      throw error
    }
  }

  async write(value: Buffer): Promise<void> {
    const directory = dirname(this.#path)
    await this.#operations.mkdir(directory, { recursive: true, mode: 0o700 })
    await this.#operations.chmod(directory, 0o700).catch(() => undefined)
    const temporary = `${this.#path}.tmp-${randomUUID()}`
    try {
      const handle = await this.#operations.open(temporary, 'wx', 0o600)
      try {
        await handle.writeFile(value)
        await handle.sync()
      } finally {
        await handle.close()
      }
      await this.#operations.rename(temporary, this.#path)
      await this.#operations.chmod(this.#path, 0o600).catch(() => undefined)
      await syncDirectory(directory, this.#operations)
    } catch (error) {
      await this.#operations.rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
  }

  async delete(): Promise<void> {
    await this.#operations.rm(this.#path, { force: true })
    await syncDirectory(dirname(this.#path), this.#operations)
  }
}

export class SerializedWriteQueue {
  #tail: Promise<void> = Promise.resolve()

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation)
    this.#tail = result.then(() => undefined, () => undefined)
    return result
  }
}

async function syncDirectory(directory: string, operations: AtomicFileOperations): Promise<void> {
  try {
    const handle = await operations.open(directory, 'r')
    try { await handle.sync() } finally { await handle.close() }
  } catch {
    // Windows and some filesystems do not allow opening directories. The file
    // itself is already fsynced and atomically renamed; directory fsync is best effort.
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code
}

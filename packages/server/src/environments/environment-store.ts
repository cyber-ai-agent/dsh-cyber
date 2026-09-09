import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import {
  normalizeEnvironmentProfile,
  type EnvironmentProfile,
} from '@dsh-cyber/contracts'

/**
 * Durable home of the machine profile under `stateRoot/environments/`.
 *
 * The profile is local-first data: a git pull, a rebuild or an upgrade must
 * never touch it. Publishing follows the repository's backup semantics -
 * write a uniquely named temp file beside the target, flush it through a
 * writable handle (Windows can reject fsync on read-only handles), verify the
 * bytes read back, then publish.
 */
export class EnvironmentProfileStore {
  readonly #root: string
  #queue: Promise<void> = Promise.resolve()

  constructor(stateRoot: string) {
    this.#root = join(stateRoot, 'environments')
  }

  path(profileId: string): string {
    return join(this.#root, `${this.sanitize(profileId)}.json`)
  }

  /** Loads one profile, or undefined when the file is missing or untrustworthy. */
  load(profileId: string): EnvironmentProfile | undefined {
    const file = this.path(profileId)
    if (!existsSync(file)) return undefined
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
      return normalizeEnvironmentProfile(parsed)
    } catch {
      // Corrupt data is treated as absent: the next refresh re-derives it.
      return undefined
    }
  }

  /** Saves one profile. Serialized per store so concurrent publishes never race the target. */
  async save(profile: EnvironmentProfile): Promise<void> {
    const job = this.#queue.then(() => this.publish(profile))
    this.#queue = job.then(
      () => undefined,
      () => undefined,
    )
    await job
  }

  private async publish(profile: EnvironmentProfile): Promise<void> {
    mkdirSync(this.#root, { recursive: true })
    const file = this.path(profile.profileId)
    const tempFile = `${file}.${process.pid}.${Date.now()}.tmp`
    const encoded = JSON.stringify(profile, null, 2)
    writeFileSync(tempFile, encoded, { flag: 'wx' })
    try {
      await syncFile(tempFile)
      // Read the published bytes back and verify the exact content before
      // replacing the target, mirroring the local backup's verification pass.
      const readBack = readFileSync(tempFile, 'utf8')
      if (sha256Hex(readBack) !== sha256Hex(encoded)) {
        throw new Error('环境档案写盘校验失败')
      }
      if (process.platform === 'win32') {
        // fs.rename cannot replace an existing target on Windows; remove
        // first. A crash in this window shows an absent profile, which the
        // next refresh re-derives - the same failure shape as the backup.
        rmSync(file, { force: true })
      }
      renameSync(tempFile, file)
    } finally {
      // On a failure the temp file is ours to clean; the target is untouched.
      try { unlinkSync(tempFile) } catch { /* already published or already gone */ }
    }
  }

  /**
   * File-name form of a profile id. `:` is legal in the id (`ssh:<connection>`)
   * but not in a Windows file name, so the two are deliberately different:
   * `ssh:device-1` becomes `ssh-device-1.json`, and the id inside the file
   * stays exact.
   */
  private sanitize(profileId: string): string {
    const safe = profileId.replace(/[^a-z0-9._-]/gi, '-')
    return safe || 'profile'
  }
}

/**
 * Durable flush through a writable handle, the same boundary the local backup
 * service uses: a read-only fsync can return EPERM on Windows, and the
 * failure mode must stay diagnosable, not fatal.
 */
async function syncFile(path: string): Promise<void> {
  const handle = await open(path, 'r+')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

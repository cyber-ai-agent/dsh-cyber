import { chmod, mkdir, mkdtemp, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { IntegrationSecretVault } from '../src/integrations/integration-secret-vault.js'
import { ModelCredentialService } from '../src/services/model-credential-service.js'
import {
  AtomicFileSecretStorage,
  type AtomicFileOperations,
  type SecretStoragePort,
} from '../src/security/secret-storage.js'

const cleanup: string[] = []
afterEach(async () => { await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })

describe('atomic secret storage', () => {
  it('preserves the previous file when atomic rename fails and enforces private modes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-secret-storage-'))
    cleanup.push(root)
    const path = join(root, 'credentials', 'vault.json')
    const working = new AtomicFileSecretStorage(path)
    await working.write(Buffer.from('old'))
    if (process.platform !== 'win32') {
      expect((await stat(path)).mode & 0o777).toBe(0o600)
      expect((await stat(join(root, 'credentials'))).mode & 0o777).toBe(0o700)
    }

    const operations: AtomicFileOperations = {
      chmod,
      mkdir,
      open,
      readFile,
      rm,
      rename: async () => { throw Object.assign(new Error('rename failed'), { code: 'EIO' }) },
    }
    const failing = new AtomicFileSecretStorage(path, operations)
    await expect(failing.write(Buffer.from('new'))).rejects.toThrow('rename failed')
    expect((await working.read())?.toString()).toBe('old')
  })

  it('serializes Integration Vault set/delete, keeps copy-on-write state on failure, and survives restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-integration-vault-'))
    cleanup.push(root)
    const storage = new MemorySecretStorage()
    const vault = await IntegrationSecretVault.open(root, storage)
    await Promise.all([vault.set('a', 'secret-a'), vault.set('b', 'secret-b')])
    expect(vault.resolve('a')).toBe('secret-a')
    expect(vault.resolve('b')).toBe('secret-b')

    await Promise.all([vault.set('race', 'temporary'), vault.delete('race')])
    expect(vault.resolve('race')).toBeUndefined()
    storage.failNextWrite = true
    await expect(vault.set('failed', 'must-not-appear')).rejects.toThrow('persist failed')
    expect(vault.resolve('failed')).toBeUndefined()
    expect(vault.resolve('a')).toBe('secret-a')

    vault.close()
    const reopened = await IntegrationSecretVault.open(root, storage)
    expect(reopened.resolve('a')).toBe('secret-a')
    expect(reopened.resolve('b')).toBe('secret-b')
    reopened.close()
  })

  it('serializes model credential mutations and never advances env or memory before persistence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-model-vault-'))
    cleanup.push(root)
    const storage = new MemorySecretStorage()
    const service = await ModelCredentialService.open(root, storage)
    await Promise.all([service.set('profile-a', 'key-a'), service.set('profile-b', 'key-b')])
    expect(service.resolve('profile-a')).toBe('key-a')
    expect(service.resolve('profile-b')).toBe('key-b')
    await Promise.all([service.set('race', 'temporary'), service.delete('race')])
    expect(service.resolve('race')).toBeUndefined()

    storage.failNextWrite = true
    await expect(service.set('failed', 'key-failed')).rejects.toThrow('persist failed')
    expect(service.has('failed')).toBe(false)
    expect(service.resolve('failed')).toBeUndefined()
    service.close()

    const reopened = await ModelCredentialService.open(root, storage)
    expect(reopened.resolve('profile-a')).toBe('key-a')
    expect(reopened.resolve('profile-b')).toBe('key-b')
    reopened.close()
  })
})

class MemorySecretStorage implements SecretStoragePort {
  value: Buffer | undefined
  failNextWrite = false

  async read(): Promise<Buffer | undefined> { return this.value === undefined ? undefined : Buffer.from(this.value) }
  async write(value: Buffer): Promise<void> {
    if (this.failNextWrite) { this.failNextWrite = false; throw new Error('persist failed') }
    this.value = Buffer.from(value)
  }
  async delete(): Promise<void> { this.value = undefined }
}

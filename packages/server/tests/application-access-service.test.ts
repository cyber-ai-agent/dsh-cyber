import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { ApplicationAccessService } from '../src/services/application-access-service.js'
import type { SecretStoragePort } from '../src/security/secret-storage.js'

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('ApplicationAccessService', () => {
  it('locks the whole application and restores access only with a valid session cookie', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-application-access-'))
    cleanup.push(root)
    const service = new ApplicationAccessService(root)
    const issued = response()

    await expect(service.summary(request())).resolves.toEqual({ passwordEnabled: false, unlocked: true, recoveryConfigured: false })
    const mutation = await service.setPassword('correct horse', issued.value)
    expect(mutation.recoveryCode).toMatch(/^[A-F0-9]{5}(?:-[A-F0-9]{5}){5}$/)
    const cookie = cookieHeader(issued.headers.get('set-cookie'))

    await expect(service.summary(request())).resolves.toEqual({ passwordEnabled: true, unlocked: false, recoveryConfigured: true })
    await expect(service.assertUnlocked(request())).rejects.toMatchObject({ status: 423, code: 'application_locked' })
    await expect(service.summary(request(cookie))).resolves.toEqual({ passwordEnabled: true, unlocked: true, recoveryConfigured: true })
    await expect(service.assertUnlocked(request(cookie))).resolves.toBeUndefined()
  })

  it('does not persist plaintext and supports changing the password on Windows-safe storage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-application-access-'))
    cleanup.push(root)
    const service = new ApplicationAccessService(root)
    const first = response()
    const firstMutation = await service.setPassword('first secret', first.value)
    const second = response()
    const secondMutation = await service.setPassword('second secret', second.value)

    const persisted = await readFile(join(root, 'credentials', 'application-access.json'), 'utf8')
    expect(persisted).not.toContain('first secret')
    expect(persisted).not.toContain('second secret')
    await expect(service.unlock('first secret', request(), response().value)).rejects.toMatchObject({ status: 401 })
    const unlocked = response()
    await expect(service.unlock('second secret', request(), unlocked.value)).resolves.toEqual({ passwordEnabled: true, unlocked: true, recoveryConfigured: true })
    await expect(service.summary(request(cookieHeader(unlocked.headers.get('set-cookie'))))).resolves.toEqual({ passwordEnabled: true, unlocked: true, recoveryConfigured: true })
    await expect(service.recover(firstMutation.recoveryCode, 'third secret', request(), response().value)).rejects.toMatchObject({ status: 401, code: 'application_recovery_invalid' })
    const recovered = response()
    const recoveredMutation = await service.recover(secondMutation.recoveryCode.toLowerCase().replaceAll('-', ''), 'third secret', request(), recovered.value)
    expect(recoveredMutation.recoveryCode).not.toBe(secondMutation.recoveryCode)
    await expect(service.unlock('second secret', request(), response().value)).rejects.toMatchObject({ status: 401 })
    await expect(service.unlock('third secret', request(), response().value)).resolves.toMatchObject({ passwordEnabled: true, unlocked: true, recoveryConfigured: true })
  })

  it('fails closed when the persisted application lock policy is invalid', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-application-access-'))
    cleanup.push(root)
    await mkdir(join(root, 'credentials'), { recursive: true })
    await writeFile(join(root, 'credentials', 'application-access.json'), '{"schemaVersion":0}\n', 'utf8')
    const service = new ApplicationAccessService(root)

    await expect(service.summary(request())).rejects.toMatchObject({ status: 500, code: 'application_access_policy_invalid' })
    await expect(service.assertUnlocked(request())).rejects.toMatchObject({ status: 500, code: 'application_access_policy_invalid' })
  })

  it('upgrades a legacy lock with a recovery code after a valid unlock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-application-access-'))
    cleanup.push(root)
    const service = new ApplicationAccessService(root)
    const initial = response()
    await service.setPassword('legacy secret', initial.value)
    const path = join(root, 'credentials', 'application-access.json')
    const legacy = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    delete legacy.recoveryHash
    await writeFile(path, JSON.stringify(legacy), 'utf8')

    const unlocked = response()
    const result = await service.unlock('legacy secret', request(), unlocked.value)
    expect(result.recoveryCode).toMatch(/^[A-F0-9]{5}(?:-[A-F0-9]{5}){5}$/)
    expect(result.recoveryConfigured).toBe(true)
    expect(JSON.parse(await readFile(path, 'utf8')).recoveryHash).toEqual(expect.any(String))
  })

  it('keeps the previous lock policy readable when a replacement write fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-application-access-'))
    cleanup.push(root)
    const storage = new FailingStorage()
    const service = new ApplicationAccessService(root, storage)
    await service.setPassword('first secret', response().value)
    storage.failNextWrite = true
    await expect(service.setPassword('second secret', response().value)).rejects.toThrow('persist failed')
    await expect(service.unlock('first secret', request(), response().value)).resolves.toMatchObject({ unlocked: true })
    await expect(service.unlock('second secret', request(), response().value)).rejects.toMatchObject({ status: 401 })
  })
})

class FailingStorage implements SecretStoragePort {
  value: Buffer | undefined
  failNextWrite = false
  async read() { return this.value === undefined ? undefined : Buffer.from(this.value) }
  async write(value: Buffer) { if (this.failNextWrite) { this.failNextWrite = false; throw new Error('persist failed') }; this.value = Buffer.from(value) }
  async delete() { this.value = undefined }
}

function request(cookie?: string): IncomingMessage {
  return { headers: cookie === undefined ? {} : { cookie }, socket: { remoteAddress: '127.0.0.1' } } as IncomingMessage
}

function response(): { value: ServerResponse; headers: Map<string, string> } {
  const headers = new Map<string, string>()
  return {
    headers,
    value: { setHeader(name: string, value: string | number | readonly string[]) { headers.set(name.toLowerCase(), String(value)); return this } } as ServerResponse,
  }
}

function cookieHeader(value: string | undefined): string {
  if (value === undefined) throw new Error('expected session cookie')
  return value.split(';', 1)[0]!
}

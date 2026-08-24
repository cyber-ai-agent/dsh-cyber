import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import type { SqliteStore } from '@dsh-cyber/persistence'
import { afterEach, describe, expect, it } from 'vitest'

import { ApplicationUpdateService } from '../src/services/application-update-service.js'

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('ApplicationUpdateService', () => {
  it('fails closed outside a clean main checkout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-app-update-'))
    cleanup.push(root)
    const service = new ApplicationUpdateService({} as SqliteStore, join(root, 'state'), root)

    await expect(service.check(false)).resolves.toMatchObject({
      supported: false,
      updateAvailable: false,
    })
  })

  it('reports a fast-forward update from origin/main', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-app-update-'))
    cleanup.push(root)
    const origin = join(root, 'origin.git')
    const application = join(root, 'application')
    const publisher = join(root, 'publisher')
    git(root, ['init', '--bare', origin])
    git(root, ['init', '-b', 'main', application])
    configureAuthor(application)
    await writeFile(join(application, 'version.txt'), 'one\n', 'utf8')
    git(application, ['add', 'version.txt'])
    git(application, ['commit', '-m', 'initial'])
    git(application, ['remote', 'add', 'origin', origin])
    git(application, ['push', '-u', 'origin', 'main'])
    git(root, ['clone', '--branch', 'main', origin, publisher])
    configureAuthor(publisher)
    await writeFile(join(publisher, 'version.txt'), 'two\n', 'utf8')
    git(publisher, ['add', 'version.txt'])
    git(publisher, ['commit', '-m', 'update'])
    git(publisher, ['push', 'origin', 'main'])

    const service = new ApplicationUpdateService({} as SqliteStore, join(root, 'state'), application)
    await expect(service.check(true)).resolves.toMatchObject({
      supported: true,
      branch: 'main',
      commitsBehind: 1,
      updateAvailable: true,
    })
  })
})

function configureAuthor(cwd: string): void {
  git(cwd, ['config', 'user.name', 'DSH Test'])
  git(cwd, ['config', 'user.email', 'dsh-test@example.invalid'])
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, windowsHide: true, stdio: 'ignore' })
}

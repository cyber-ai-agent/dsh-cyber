import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const desktop = require('../runtime.cjs') as {
  defaultStateRoot(environment: NodeJS.ProcessEnv): string
  runtimePaths(input: { packaged: boolean; resourcesPath: string; desktopRoot: string; environment: NodeJS.ProcessEnv }): Record<string, string>
  assertRuntime(paths: Record<string, string>): void
  needsPreflightBackup(stateRoot: string, marker: string, version: string): boolean
  writeLaunchMarker(stateRoot: string, marker: string, version: string): void
  isAllowedOrigin(target: string, origin: string): boolean
  externalUrl(target: string): string | undefined
  launchHost(paths: Record<string, string>, stateRoot: string): { originPromise: Promise<string>; exitedPromise: Promise<void>; stop(): Promise<void> }
  runBackup(paths: Record<string, string>, stateRoot: string): Promise<void>
}
const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

describe('Windows desktop runtime boundary', () => {
  it('keeps packaged resources separate from the unchanged local data root', () => {
    const paths = desktop.runtimePaths({ packaged: true, resourcesPath: 'C:\\Program Files\\DSH Cyber\\resources', desktopRoot, environment: {} })
    expect(paths.cli).toContain(join('runtime', 'lib', 'bin.js'))
    expect(paths.webRoot).toBe(join('C:\\Program Files\\DSH Cyber\\resources', 'web'))
    expect(desktop.defaultStateRoot({ LOCALAPPDATA: 'C:\\Users\\Me\\AppData\\Local' })).toBe(resolve('C:\\Users\\Me\\AppData\\Local', 'DSH Cyber'))
  })

  it('requires a verified backup once per desktop version and data root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-marker-'))
    const stateRoot = join(root, 'state')
    const marker = join(root, 'shell', 'runtime-version.json')
    try {
      expect(desktop.needsPreflightBackup(stateRoot, marker, '0.1.0-preview.1')).toBe(false)
      await mkdir(join(stateRoot, 'data'), { recursive: true })
      await writeFile(join(stateRoot, 'data', 'dsh-cyber.sqlite'), 'existing-data')
      expect(desktop.needsPreflightBackup(stateRoot, marker, '0.1.0-preview.1')).toBe(true)
      desktop.writeLaunchMarker(stateRoot, marker, '0.1.0-preview.1')
      expect(desktop.needsPreflightBackup(stateRoot, marker, '0.1.0-preview.1')).toBe(false)
      expect(desktop.needsPreflightBackup(stateRoot, marker, '0.1.0-preview.2')).toBe(true)
      expect(desktop.needsPreflightBackup(join(root, 'other'), marker, '0.1.0-preview.1')).toBe(false)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('admits only the owned loopback origin into the desktop window', () => {
    expect(desktop.isAllowedOrigin('http://127.0.0.1:43123/knowledge', 'http://127.0.0.1:43123')).toBe(true)
    expect(desktop.isAllowedOrigin('http://127.0.0.1:43124/', 'http://127.0.0.1:43123')).toBe(false)
    expect(desktop.externalUrl('https://example.com/help')).toBe('https://example.com/help')
    expect(desktop.externalUrl('file:///C:/secret.txt')).toBeUndefined()
    expect(desktop.externalUrl('javascript:alert(1)')).toBeUndefined()
  })

  it('starts the actual isolated Host, stops it, then creates an offline Backup Bundle', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-desktop-host-'))
    const paths = desktop.runtimePaths({
      packaged: false, resourcesPath: '', desktopRoot,
      environment: { ...process.env, DSH_CYBER_DESKTOP_NODE: process.execPath },
    })
    let host: ReturnType<typeof desktop.launchHost> | undefined
    try {
      desktop.assertRuntime(paths)
      host = desktop.launchHost(paths, stateRoot)
      const origin = await host.originPromise
      const health = await fetch(`${origin}/api/health`).then((response) => response.json())
      expect(health).toMatchObject({ ok: true })
      await host.stop()
      await host.exitedPromise
      await desktop.runBackup(paths, stateRoot)
      expect((await readdir(join(stateRoot, 'backups'))).some((name) => name.endsWith('.dshbackup'))).toBe(true)
    } finally {
      await host?.stop()
      await rm(stateRoot, { recursive: true, force: true })
    }
  }, 120_000)
})

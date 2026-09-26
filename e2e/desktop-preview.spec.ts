import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { _electron as electron, expect, test } from '@playwright/test'

test.skip(process.platform !== 'win32', 'Windows desktop preview')

const require = createRequire(import.meta.url)
const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'desktop')
const packagedExecutable = join(desktopRoot, '.desktop-build', 'artifacts', 'win-unpacked', 'DSH Cyber.exe')

test('keeps one local Host alive while hidden and closes it on explicit exit', async ({}, info) => {
  const electronExecutable = require(require.resolve('electron', { paths: [desktopRoot] })) as string
  const privateRoot = await mkdtemp(join(tmpdir(), 'dsh-desktop-e2e-'))
  const stateRoot = join(privateRoot, 'state')
  const shellRoot = join(privateRoot, 'shell')
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined
  try {
    const desktopEnvironment = {
      ...process.env,
      DSH_CYBER_DESKTOP_DATA_DIR: stateRoot,
      DSH_CYBER_DESKTOP_USER_DATA_DIR: shellRoot,
    }
    application = await electron.launch({
      executablePath: electronExecutable,
      args: [desktopRoot],
      env: desktopEnvironment,
    })
    const page = await application.firstWindow()
    const issues: string[] = []
    page.on('pageerror', (error) => issues.push(error.message))
    page.on('console', (message) => { if (message.type() === 'error' || message.type() === 'warning') issues.push(message.text()) })
    await expect.poll(() => page.url(), { timeout: 30_000 }).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
    await expect(page.locator('body')).toContainText('开始与角色对话')
    const origin = new URL(page.url()).origin
    expect(await fetch(`${origin}/api/health`).then((response) => response.json())).toMatchObject({ ok: true })
    for (const size of [{ width: 1440, height: 900 }, { width: 1920, height: 1080 }, { width: 3840, height: 2160 }]) {
      await page.setViewportSize(size)
      await page.screenshot({ path: info.outputPath(`desktop-${size.width}x${size.height}.png`) })
    }
    await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false }) })
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close())
    await expect.poll(() => application!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible())).toBe(false)
    expect(existsSync(join(shellRoot, 'background-close-confirmed'))).toBe(true)
    expect(await fetch(`${origin}/api/health`).then((response) => response.status)).toBe(200)
    const second = spawn(electronExecutable, [desktopRoot], { env: desktopEnvironment, stdio: 'ignore', windowsHide: true })
    expect(await new Promise<number | null>((resolvePromise, reject) => { second.once('error', reject); second.once('exit', resolvePromise) })).toBe(0)
    await expect.poll(() => application!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible())).toBe(true)
    expect(issues, issues.join('\n')).toEqual([])
    const closed = application.waitForEvent('close')
    await application.evaluate(({ app }) => app.quit())
    await closed
    application = undefined
    await expect.poll(async () => fetch(`${origin}/api/health`).then(() => 'running').catch(() => 'stopped')).toBe('stopped')
  } finally {
    await application?.close().catch(() => undefined)
    await rm(privateRoot, { recursive: true, force: true })
  }
})

test('packaged Windows app backs up existing local data and opens without repository dependencies', async () => {
  test.skip(!existsSync(packagedExecutable), 'run pnpm desktop:package:win:dir first')
  const { runCli } = await import('../packages/cli/lib/index.js')
  const privateRoot = await mkdtemp(join(tmpdir(), 'dsh-desktop-packaged-e2e-'))
  const stateRoot = join(privateRoot, 'state')
  const shellRoot = join(privateRoot, 'shell')
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined
  try {
    expect(await runCli(['web', '--port', '0', '--data-dir', stateRoot, '--workspace', stateRoot, '--no-open'], {
      io: { stdout: () => undefined, stderr: () => undefined },
      waitForShutdown: async (server) => { await server.close() },
    })).toBe(0)
    application = await electron.launch({
      executablePath: packagedExecutable,
      args: [],
      env: { ...process.env, DSH_CYBER_DESKTOP_DATA_DIR: stateRoot, DSH_CYBER_DESKTOP_USER_DATA_DIR: shellRoot },
    })
    const page = await application.firstWindow()
    await expect.poll(() => page.url(), { timeout: 30_000 }).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
    await expect(page.locator('body')).toContainText('开始与角色对话')
    expect((await readdir(join(stateRoot, 'backups'))).some((name) => name.endsWith('.dshbackup'))).toBe(true)
    expect(existsSync(join(shellRoot, 'runtime-version.json'))).toBe(true)
    const origin = new URL(page.url()).origin
    const closed = application.waitForEvent('close')
    await application.evaluate(({ app }) => app.quit())
    await closed
    application = undefined
    await expect.poll(async () => fetch(`${origin}/api/health`).then(() => 'running').catch(() => 'stopped')).toBe('stopped')
  } finally {
    await application?.close().catch(() => undefined)
    await rm(privateRoot, { recursive: true, force: true })
  }
})

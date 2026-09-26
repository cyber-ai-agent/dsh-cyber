import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const target = process.argv[2]
if (!['dir', 'nsis'].includes(target)) throw new Error('用法：node scripts/build-win.mjs dir|nsis')
const require = createRequire(import.meta.url)
const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const child = spawn(process.execPath, [require.resolve('electron-builder/cli.js'), '--win', target, '--publish', 'never'], {
  cwd: desktopRoot,
  env: { ...process.env, ELECTRON_GET_USE_PROXY: '1' },
  stdio: 'inherit',
  windowsHide: true,
})
const status = await new Promise((resolvePromise, reject) => {
  child.once('error', reject)
  child.once('exit', (code) => resolvePromise(code ?? 1))
})
if (status !== 0) process.exitCode = status

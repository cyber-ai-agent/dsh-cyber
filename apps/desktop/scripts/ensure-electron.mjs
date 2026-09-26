import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const entry = require.resolve('electron/cli.js')
const child = spawn(process.execPath, [entry, '--version'], {
  env: { ...process.env, ELECTRON_GET_USE_PROXY: '1' },
  stdio: 'inherit',
  windowsHide: true,
})
const status = await new Promise((resolvePromise, reject) => {
  child.once('error', reject)
  child.once('exit', (code) => resolvePromise(code ?? 1))
})
if (status !== 0) process.exitCode = status

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(desktopRoot, '..', '..')
const dataRoot = resolve(process.env.DSH_CYBER_DESKTOP_DATA_DIR || join(repoRoot, '.private', 'desktop-dev-state'))
const userDataRoot = resolve(process.env.DSH_CYBER_DESKTOP_USER_DATA_DIR || join(dataRoot, 'desktop-shell'))
mkdirSync(dataRoot, { recursive: true })
console.log(`桌面开发数据：${dataRoot}`)
const child = spawn(require('electron'), [desktopRoot], {
  cwd: desktopRoot,
  env: { ...process.env, DSH_CYBER_DESKTOP_DATA_DIR: dataRoot, DSH_CYBER_DESKTOP_USER_DATA_DIR: userDataRoot },
  stdio: 'inherit',
})
const status = await new Promise((resolvePromise, reject) => {
  child.once('error', reject)
  child.once('exit', (code) => resolvePromise(code ?? 1))
})
if (status !== 0) process.exitCode = status

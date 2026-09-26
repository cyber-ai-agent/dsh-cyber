import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, copyFileSync, writeFileSync, readdirSync, mkdtempSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const repoRoot = resolve(desktopRoot, '..', '..')
const stage = resolve(desktopRoot, '.desktop-build', 'runtime')
const pnpmEntry = process.env.npm_execpath

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('桌面预览包目前只支持在 Windows x64 上构建')
if (!pnpmEntry || !/\.(?:cjs|mjs|js)$/i.test(pnpmEntry)) throw new Error('请通过 pnpm run prepare:runtime 启动打包准备')
if (!existsSync(join(repoRoot, 'packages', 'web', 'dist', 'index.html'))) throw new Error('请先运行 pnpm build')
const inside = relative(desktopRoot, stage)
if (!inside || inside.startsWith('..' + sep) || inside === '..' || resolve(desktopRoot, inside) !== stage) {
  throw new Error('桌面运行时目录不在本项目中')
}

rmSync(stage, { recursive: true, force: true })
mkdirSync(stage, { recursive: true })
const deployed = spawnSync(process.execPath, [pnpmEntry, '--config.inject-workspace-packages=true', '--config.node-linker=hoisted', '--filter', '@dsh-cyber/cli', 'deploy', '--prod', stage], {
  cwd: repoRoot,
  stdio: 'inherit',
  windowsHide: true,
})
if (deployed.error) throw deployed.error
if (deployed.status !== 0) throw new Error(`生产运行时整理失败（退出码 ${deployed.status ?? '未知'}）`)

const cli = join(stage, 'lib', 'bin.js')
if (!existsSync(cli)) throw new Error('整理后的生产运行时缺少 DSH Cyber CLI')
verifyPortableLinks(stage)
const node = join(stage, 'node.exe')
copyFileSync(process.execPath, node)
writeFileSync(join(stage, 'desktop-runtime.json'), `${JSON.stringify({
  schemaVersion: 1,
  platform: process.platform,
  arch: process.arch,
  nodeVersion: process.version,
  nodeSha256: createHash('sha256').update(readFileSync(node)).digest('hex'),
}, null, 2)}\n`)
await smokeRuntime()
console.log(`桌面运行时已准备：${stage}`)

function verifyPortableLinks(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const target = join(directory, entry.name)
    if (entry.isSymbolicLink()) {
      throw new Error(`桌面运行时不能保留链接目录：${target}`)
    } else if (entry.isDirectory()) {
      verifyPortableLinks(target)
    }
  }
}

async function smokeRuntime() {
  const require = createRequire(import.meta.url)
  const { launchHost, runBackup } = require('../runtime.cjs')
  const stateRoot = mkdtempSync(join(tmpdir(), 'dsh-desktop-pack-smoke-'))
  const contained = relative(tmpdir(), stateRoot)
  if (!contained.startsWith('dsh-desktop-pack-smoke-') || contained.includes(sep)) throw new Error('隔离验收目录无效')
  const paths = {
    node,
    cli,
    webRoot: join(repoRoot, 'packages', 'web', 'dist'),
    marketplaceRoot: join(repoRoot, 'marketplace'),
  }
  let host
  try {
    host = launchHost(paths, stateRoot)
    const origin = await host.originPromise
    const response = await fetch(`${origin}/api/health`)
    if (!response.ok || (await response.json()).ok !== true) throw new Error('独立桌面运行时健康检查失败')
    await host.stop()
    await runBackup(paths, stateRoot)
    if (!readdirSync(join(stateRoot, 'backups')).some((name) => name.endsWith('.dshbackup'))) throw new Error('独立桌面运行时未生成 Backup Bundle')
  } finally {
    await host?.stop()
    rmSync(stateRoot, { recursive: true, force: true })
  }
}

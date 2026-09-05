import { watch } from 'node:fs'
import { resolve } from 'node:path'
import { prepareLocalPackage } from '../packages/package-runtime/src/package-authoring.js'

const KNOWN_FLAGS = new Set(['--check', '--watch', '--dev'])
const args = process.argv.slice(2)
const paths = args.filter((value) => !value.startsWith('--'))
const flags = args.filter((value) => value.startsWith('--'))
const check = flags.includes('--check')
const watchMode = flags.includes('--watch')
const devRevision = flags.includes('--dev')
// `--dev` writes a new version, so it pairs with neither the read-only check
// nor the watcher, which would mint a revision on every keystroke.
const usageError = paths.length !== 1
  || flags.some((value) => !KNOWN_FLAGS.has(value))
  || [check, watchMode, devRevision].filter(Boolean).length > 1
if (usageError) {
  console.error('用法：pnpm package:prepare <扩展包目录> [--check | --watch | --dev]')
  console.error('  --check  只检查不写文件，需要更新时返回非零退出码')
  console.error('  --watch  持续同步文件清单与哈希')
  console.error('  --dev    把本地改动放到明确标记的 -dev.N 版本上，不覆盖已安装的发行版本')
  process.exitCode = 1
} else {
  const directory = resolve(paths[0]!)
  let running = false
  let dirty = false
  async function refresh() {
    if (running) { dirty = true; return }
    running = true
    try {
      const result = await prepareLocalPackage(directory, { check, devRevision })
      if (result.changed || !watchMode) console.log(`${result.changed ? check ? '需要更新' : '已更新' : '已是最新'}：${result.files} 个文件，版本 ${result.version}，${result.manifestPath}`)
      if (result.changed && check) process.exitCode = 1
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error))
      if (!watchMode) process.exitCode = 1
    } finally { running = false; if (dirty) { dirty = false; void refresh() } }
  }
  await refresh()
  if (watchMode) {
    let timer: ReturnType<typeof setTimeout> | undefined
    const watcher = watch(directory, { recursive: true }, () => {
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() => { timer = undefined; void refresh() }, 200)
    })
    watcher.on('error', (error) => { console.error(error.message); watcher.close(); process.exitCode = 1 })
    console.log('正在监听源码变化，自动维护文件清单与哈希。Ctrl+C 退出。')
  }
}

import { watch } from 'node:fs'
import { resolve } from 'node:path'
import { prepareLocalPackage } from '../packages/package-runtime/src/package-authoring.js'

const args = process.argv.slice(2)
const paths = args.filter((value) => !value.startsWith('--'))
if (paths.length !== 1 || args.some((value) => value.startsWith('--') && !['--check', '--watch'].includes(value)) || (args.includes('--check') && args.includes('--watch'))) {
  console.error('用法：pnpm package:prepare <扩展包目录> [--check | --watch]')
  process.exitCode = 1
} else {
  const directory = resolve(paths[0]!)
  let running = false
  let dirty = false
  async function refresh() {
    if (running) { dirty = true; return }
    running = true
    try {
      const result = await prepareLocalPackage(directory, { check: args.includes('--check') })
      if (result.changed || !args.includes('--watch')) console.log(`${result.changed ? args.includes('--check') ? '需要更新' : '已更新' : '已是最新'}：${result.files} 个文件，${result.manifestPath}`)
      if (result.changed && args.includes('--check')) process.exitCode = 1
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error))
      if (!args.includes('--watch')) process.exitCode = 1
    } finally { running = false; if (dirty) { dirty = false; void refresh() } }
  }
  await refresh()
  if (args.includes('--watch')) {
    let timer: ReturnType<typeof setTimeout> | undefined
    const watcher = watch(directory, { recursive: true }, () => {
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() => { timer = undefined; void refresh() }, 200)
    })
    watcher.on('error', (error) => { console.error(error.message); watcher.close(); process.exitCode = 1 })
    console.log('正在监听源码变化，自动维护文件清单与哈希。Ctrl+C 退出。')
  }
}

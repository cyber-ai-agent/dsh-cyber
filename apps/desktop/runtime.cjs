const { spawn } = require('node:child_process')
const { createHash, randomUUID } = require('node:crypto')
const { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } = require('node:fs')
const { homedir } = require('node:os')
const { dirname, join, resolve } = require('node:path')

const READY_PREFIX = 'DSH_CYBER_DESKTOP_READY '

function defaultStateRoot(environment = process.env) {
  return resolve(environment.LOCALAPPDATA ? join(environment.LOCALAPPDATA, 'DSH Cyber') : join(homedir(), '.dsh-cyber'))
}

function runtimePaths({ packaged, resourcesPath, desktopRoot, environment = process.env }) {
  if (packaged) {
    const runtimeRoot = join(resourcesPath, 'runtime')
    return {
      node: join(runtimeRoot, 'node.exe'),
      cli: join(runtimeRoot, 'lib', 'bin.js'),
      webRoot: join(resourcesPath, 'web'),
      marketplaceRoot: join(resourcesPath, 'marketplace'),
      icon: join(resourcesPath, 'favicon.png'),
    }
  }
  const repoRoot = resolve(desktopRoot, '..', '..')
  return {
    node: environment.DSH_CYBER_DESKTOP_NODE || 'node',
    cli: join(repoRoot, 'packages', 'cli', 'lib', 'bin.js'),
    webRoot: join(repoRoot, 'packages', 'web', 'dist'),
    marketplaceRoot: join(repoRoot, 'marketplace'),
    icon: join(repoRoot, 'packages', 'web', 'public', 'favicon.png'),
  }
}

function assertRuntime(paths) {
  for (const key of ['cli', 'webRoot', 'marketplaceRoot', 'icon']) {
    if (!existsSync(paths[key])) throw new Error(`桌面运行时缺少 ${key}，请重新构建桌面包`)
  }
  if (paths.node !== 'node' && !existsSync(paths.node)) throw new Error('桌面包缺少 Node 运行时')
}

function dataRootId(stateRoot) {
  return createHash('sha256').update(resolve(stateRoot).toLowerCase()).digest('hex')
}

function needsPreflightBackup(stateRoot, markerPath, version) {
  if (!existsSync(join(stateRoot, 'data', 'dsh-cyber.sqlite'))) return false
  try {
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'))
    return marker.version !== version || marker.dataRootId !== dataRootId(stateRoot)
  } catch { return true }
}

function writeLaunchMarker(stateRoot, markerPath, version) {
  mkdirSync(dirname(markerPath), { recursive: true })
  const temporary = `${markerPath}.${randomUUID()}.tmp`
  writeFileSync(temporary, `${JSON.stringify({ version, dataRootId: dataRootId(stateRoot) })}\n`, { flag: 'wx' })
  renameSync(temporary, markerPath)
}

function cliArguments(paths, stateRoot, command) {
  if (command === 'backup') return [paths.cli, 'backup', '--data-dir', stateRoot]
  return [
    paths.cli, 'web', '--port', '0', '--data-dir', stateRoot, '--workspace', stateRoot,
    '--web-root', paths.webRoot, '--marketplace-root', paths.marketplaceRoot,
    '--desktop-control',
  ]
}

function spawnCli(paths, stateRoot, command) {
  mkdirSync(stateRoot, { recursive: true })
  const environment = { ...process.env, NODE_ENV: 'production' }
  delete environment.ELECTRON_RUN_AS_NODE
  return spawn(paths.node, cliArguments(paths, stateRoot, command), {
    cwd: stateRoot,
    env: environment,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
}

function runBackup(paths, stateRoot) {
  return new Promise((resolvePromise, reject) => {
    const child = spawnCli(paths, stateRoot, 'backup')
    const timeout = setTimeout(() => child.kill(), 30 * 60_000)
    child.once('error', (error) => { clearTimeout(timeout); reject(error) })
    child.once('exit', (code) => {
      clearTimeout(timeout)
      if (code === 0) resolvePromise()
      else reject(new Error('本地数据备份未完成；桌面版已停止启动，原有资料保持原样。'))
    })
    child.stdout.resume()
    child.stderr.resume()
  })
}

function launchHost(paths, stateRoot) {
  const child = spawnCli(paths, stateRoot, 'web')
  child.stdin.on('error', () => undefined)
  let ready = false
  let exited = false
  let pending = ''
  let resolveExit
  const exitedPromise = new Promise((resolvePromise) => { resolveExit = resolvePromise })
  const originPromise = new Promise((resolvePromise, reject) => {
    const timeout = setTimeout(() => reject(new Error('本地服务启动超时')), 90_000)
    const fail = () => {
      clearTimeout(timeout)
      if (!ready) reject(new Error('本地服务未能启动；请检查是否已有 DSH Cyber 正在使用这份数据。'))
    }
    child.stdout.on('data', (chunk) => {
      pending += chunk.toString('utf8')
      if (pending.length > 16_384) pending = pending.slice(-16_384)
      for (;;) {
        const newline = pending.indexOf('\n')
        if (newline < 0) break
        const line = pending.slice(0, newline).trim()
        pending = pending.slice(newline + 1)
        if (!line.startsWith(READY_PREFIX)) continue
        try {
          const { origin } = JSON.parse(line.slice(READY_PREFIX.length))
          const url = new URL(origin)
          if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port) throw new Error('本地服务地址无效')
          ready = true
          clearTimeout(timeout)
          resolvePromise(url.origin)
        } catch { fail() }
      }
    })
    child.once('error', fail)
    child.once('exit', fail)
  })
  child.stderr.resume()
  child.once('exit', () => { exited = true; resolveExit() })
  return {
    child,
    originPromise,
    exitedPromise,
    get exited() { return exited },
    async stop() {
      if (exited) return
      child.stdin.end('shutdown\n')
      let timeout
      await Promise.race([exitedPromise, new Promise((resolvePromise) => { timeout = setTimeout(resolvePromise, 20_000) })])
      clearTimeout(timeout)
      if (!exited) { child.kill(); await exitedPromise }
    },
  }
}

function isAllowedOrigin(target, origin) {
  try { return new URL(target).origin === origin } catch { return false }
}

function externalUrl(target) {
  try {
    const url = new URL(target)
    return ['https:', 'http:', 'mailto:'].includes(url.protocol) ? url.href : undefined
  } catch { return undefined }
}

module.exports = {
  READY_PREFIX,
  assertRuntime,
  defaultStateRoot,
  runtimePaths,
  needsPreflightBackup,
  writeLaunchMarker,
  runBackup,
  launchHost,
  isAllowedOrigin,
  externalUrl,
}

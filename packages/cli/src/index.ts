import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join, resolve } from 'node:path'

import {
  clearActiveHarnessRuntime,
  inspectHarnessCandidate,
  inspectHarnessCompatibility,
  readActiveHarnessRuntime,
} from '@dsh-cyber/harness-adapter'
import { SqliteStore } from '@dsh-cyber/persistence'
import { createCyberServer, type CyberServer } from '@dsh-cyber/server'

export interface CliIo {
  stdout: (line: string) => void
  stderr: (line: string) => void
}

export interface CliContext {
  cwd?: string
  environment?: NodeJS.ProcessEnv
  io?: CliIo
  openBrowser?: (url: string) => Promise<void>
  waitForShutdown?: (server: CyberServer) => Promise<void>
}

export async function runCli(args: string[], context: CliContext = {}): Promise<number> {
  const io = context.io ?? {
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
  }
  try {
    const command = args[0] ?? 'help'
    if (command === 'help' || command === '--help' || command === '-h') {
      io.stdout(helpText())
      return 0
    }
    const options = parseOptions(args.slice(1))
    const environment = context.environment ?? process.env
    const cwd = resolve(context.cwd ?? process.cwd())
    const stateRoot = resolve(optionString(options, 'data-dir') ?? defaultStateRoot(environment))

    if (command === 'web') {
      const port = optionInteger(options, 'port') ?? 43123
      const workspacePath = resolve(optionString(options, 'workspace') ?? cwd)
      const server = await createCyberServer({ stateRoot, workspacePath, port })
      const address = await server.start()
      try {
        io.stdout(`DSH Cyber 已启动：${address.origin}`)
        io.stdout(`本地数据：${stateRoot}`)
        if (!optionBoolean(options, 'no-open')) {
          await (context.openBrowser ?? openExternal)(address.origin)
        }
        await (context.waitForShutdown ?? waitForProcessShutdown)(server)
        return 0
      } finally {
        await server.close()
      }
    }

    if (command === 'doctor') {
      const compatibility = await inspectHarnessCompatibility(join(stateRoot, 'runtime', 'harness-home'))
      const databasePath = join(stateRoot, 'data', 'dsh-cyber.sqlite')
      let database: ReturnType<SqliteStore['doctor']> | { initialized: false } = {
        initialized: false,
      }
      if (existsSync(databasePath)) {
        const store = await SqliteStore.open(databasePath, { readOnly: true })
        try {
          database = store.doctor()
        } finally {
          store.close()
        }
      }
      const report = { ok: compatibility.ok && ('initialized' in database || database.ok), compatibility, database }
      io.stdout(JSON.stringify(report, null, 2))
      return report.ok ? 0 : 1
    }

    if (command === 'runtime-check') {
      const candidateRoot = optionString(options, 'candidate-root')
      if (candidateRoot === undefined) throw new Error('--candidate-root is required')
      const report = await inspectHarnessCandidate({
        candidateRoot: resolve(candidateRoot),
        stateRoot: join(stateRoot, 'runtime'),
      })
      io.stdout(JSON.stringify(report, null, 2))
      return report.ok ? 0 : 1
    }

    if (command === 'runtime-rollback') {
      const runtimeStateRoot = join(stateRoot, 'runtime')
      const active = await readActiveHarnessRuntime(runtimeStateRoot)
      const databasePath = join(stateRoot, 'data', 'dsh-cyber.sqlite')
      if (existsSync(databasePath)) {
        const store = await SqliteStore.open(databasePath)
        try {
          const transaction = active === undefined
            ? store.listRuntimeUpdateTransactions().find((item) => item.status === 'activated')
            : store.getRuntimeUpdateTransaction(active.transactionId)
          if (transaction?.status === 'activated') {
            const backup = await store.backup(defaultArtifactPath(stateRoot, 'backup'))
            await clearActiveHarnessRuntime(runtimeStateRoot)
            store.transitionRuntimeUpdate({
              transactionId: transaction.id,
              status: 'rolled-back',
              report: { ok: true, recovery: 'cli', backup, returnedToBundledRuntime: true },
            })
            io.stdout(`已恢复内置 DSH 运行时；数据库备份：${backup}`)
            return 0
          }
        } finally {
          store.close()
        }
      }
      await clearActiveHarnessRuntime(runtimeStateRoot)
      io.stdout(active === undefined ? '当前已使用内置 DSH 运行时。' : '已清除候选运行时指针，恢复内置 DSH。')
      return 0
    }

    if (command === 'backup' || command === 'export') {
      const databasePath = join(stateRoot, 'data', 'dsh-cyber.sqlite')
      if (!existsSync(databasePath)) throw new Error(`Database not found: ${databasePath}`)
      const output = optionString(options, 'output') ?? defaultArtifactPath(stateRoot, command)
      const store = await SqliteStore.open(databasePath)
      try {
        const destination = command === 'backup'
          ? await store.backup(output)
          : await store.exportJson(output)
        io.stdout(destination)
      } finally {
        store.close()
      }
      return 0
    }

    throw new Error(`Unknown command: ${command}`)
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error))
    return 1
  }
}

function parseOptions(args: string[]): Map<string, string | true> {
  const options = new Map<string, string | true>()
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    if (token === undefined || !token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`)
    const key = token.slice(2)
    if (!key) throw new Error('Invalid empty option')
    if (key === 'no-open') {
      options.set(key, true)
      continue
    }
    const value = args[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for --${key}`)
    options.set(key, value)
    index += 1
  }
  return options
}

function optionString(options: Map<string, string | true>, key: string): string | undefined {
  const value = options.get(key)
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function optionBoolean(options: Map<string, string | true>, key: string): boolean {
  return options.get(key) === true
}

function optionInteger(options: Map<string, string | true>, key: string): number | undefined {
  const value = optionString(options, key)
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new Error(`Invalid --${key}: ${value}`)
  }
  return parsed
}

function defaultStateRoot(environment: NodeJS.ProcessEnv): string {
  const localAppData = environment.LOCALAPPDATA
  return localAppData
    ? join(localAppData, 'DSH Cyber')
    : join(homedir(), '.dsh-cyber')
}

function defaultArtifactPath(stateRoot: string, kind: 'backup' | 'export'): string {
  const timestamp = new Date().toISOString().replaceAll(/[:.]/g, '-')
  const extension = kind === 'backup' ? 'sqlite' : 'json'
  return join(stateRoot, 'backups', `dsh-cyber-${timestamp}.${extension}`)
}

function openExternal(url: string): Promise<void> {
  const system = platform()
  const command = system === 'win32' ? 'rundll32.exe' : system === 'darwin' ? 'open' : 'xdg-open'
  const args = system === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url]
  return new Promise((resolvePromise, reject) => {
    const child = execFile(command, args, { windowsHide: system === 'win32' }, (error) => {
      if (error) reject(error)
      else resolvePromise()
    })
    child.unref()
  })
}

function waitForProcessShutdown(server: CyberServer): Promise<void> {
  return new Promise((resolvePromise) => {
    let settling = false
    const shutdown = () => {
      if (settling) return
      settling = true
      process.off('SIGINT', shutdown)
      process.off('SIGTERM', shutdown)
      void server.close().finally(resolvePromise)
    }
    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
  })
}

function helpText(): string {
  return [
    'DSH Cyber',
    '',
    '用法：',
    '  dsh-cyber web [--port 43123] [--data-dir PATH] [--workspace PATH] [--no-open]',
    '  dsh-cyber doctor [--data-dir PATH]',
    '  dsh-cyber runtime-check --candidate-root PATH [--data-dir PATH]',
    '  dsh-cyber runtime-rollback [--data-dir PATH]',
    '  dsh-cyber backup [--data-dir PATH] [--output FILE]',
    '  dsh-cyber export [--data-dir PATH] [--output FILE]',
    '',
    'Web 服务固定监听 loopback；Phase 1 不开放公网监听。',
  ].join('\n')
}

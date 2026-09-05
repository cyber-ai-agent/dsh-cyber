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
import { acquireStateRootLease, createCyberServer, createLocalBackupBundle, recoverLocalRestoreTransactions, restoreLocalBackupBundle, type CyberServer } from '@dsh-cyber/server'

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
  let releaseState: (() => Promise<void>) | undefined
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
    // Offline commands must not open SQLite halfway through a restore. The
    // running server offers its own live backup/diagnostic endpoints.
    if (['doctor', 'runtime-check', 'runtime-rollback', 'backup', 'export', 'prune'].includes(command)) {
      releaseState = await acquireStateRootLease(stateRoot)
      await recoverLocalRestoreTransactions(stateRoot)
    }

    if (command === 'web') {
      const port = optionInteger(options, 'port') ?? 43123
      const workspacePath = resolve(optionString(options, 'workspace') ?? cwd)
      const server = await createCyberServer({ stateRoot, workspacePath, port, bootstrapDefaultWorld: true })
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
            const backup = await createLocalBackupBundle(stateRoot, store)
            await clearActiveHarnessRuntime(runtimeStateRoot)
            store.transitionRuntimeUpdate({
              transactionId: transaction.id,
              status: 'rolled-back',
              report: { ok: true, recovery: 'cli', backup, returnedToBundledRuntime: true },
            })
            io.stdout(`已恢复内置 DSH 运行时；本地数据 Bundle：${backup}`)
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
          ? await createLocalBackupBundle(stateRoot, store, { output })
          : await store.exportJson(output)
        io.stdout(destination)
      } finally {
        store.close()
      }
      return 0
    }

    if (command === 'restore') {
      const input = optionString(options, 'input')
      if (input === undefined) throw new Error('restore 需要 --input <备份文件>')
      const source = resolve(cwd, input)
      if (!existsSync(source)) throw new Error(`Backup not found: ${source}`)
      const result = await restoreLocalBackupBundle(stateRoot, source, { force: optionBoolean(options, 'force') })
      io.stdout(`已恢复到：${result.stateRoot}`)
      io.stdout(`备份创建于：${result.createdAt}`)
      io.stdout(`恢复内容：${result.included.join('、')}`)
      io.stdout(`文件数：${result.files}，字节数：${result.bytes}`)
      return 0
    }

    if (command === 'prune') {
      const before = pruneCutoff(options)
      const databasePath = join(stateRoot, 'data', 'dsh-cyber.sqlite')
      if (!existsSync(databasePath)) throw new Error(`Database not found: ${databasePath}`)
      const store = await SqliteStore.open(databasePath)
      try {
        const result = store.pruneHistory({ before })
        io.stdout(`已清理 ${before} 之前的运行记录：`)
        io.stdout(`  领域事件 ${result.domainEvents}`)
        io.stdout(`  会话回合 ${result.workTurns}`)
        io.stdout(`  代理运行 ${result.agentRuns}`)
        io.stdout(`  模型调用日志 ${result.modelInteractions}`)
        io.stdout('聊天记录、Skill 动作账本和审批历史不在清理范围内。')
      } finally {
        store.close()
      }
      return 0
    }

    throw new Error(`Unknown command: ${command}`)
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error))
    return 1
  } finally {
    await releaseState?.()
  }
}

/**
 * Retention needs an explicit cutoff. There is no default, because a wrong
 * default here silently deletes history the user wanted.
 */
function pruneCutoff(options: Map<string, string | true>): string {
  const before = optionString(options, 'before')
  const keepDays = optionInteger(options, 'keep-days')
  if (before !== undefined && keepDays !== undefined) throw new Error('--before 和 --keep-days 只能选一个')
  if (before !== undefined) {
    const parsed = Date.parse(before)
    if (!Number.isFinite(parsed)) throw new Error(`无法解析日期：${before}`)
    return new Date(parsed).toISOString()
  }
  if (keepDays !== undefined) {
    if (keepDays < 1) throw new Error('--keep-days 至少为 1')
    return new Date(Date.now() - keepDays * 24 * 60 * 60 * 1_000).toISOString()
  }
  throw new Error('prune 需要 --before <日期> 或 --keep-days <天数>')
}

function parseOptions(args: string[]): Map<string, string | true> {
  const options = new Map<string, string | true>()
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    if (token === undefined || !token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`)
    const key = token.slice(2)
    if (!key) throw new Error('Invalid empty option')
    if (key === 'no-open' || key === 'force') {
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
  const extension = kind === 'backup' ? 'dshbackup' : 'json'
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
    '  dsh-cyber backup [--data-dir PATH] [--output FILE.dshbackup]',
    '  dsh-cyber restore --input FILE.dshbackup [--data-dir PATH] [--force]',
    '  dsh-cyber export [--data-dir PATH] [--output FILE.json]',
    '  dsh-cyber prune (--before DATE | --keep-days N) [--data-dir PATH]',
    '',
    'backup 会包含数据库、世界、资产、已安装包、创意工坊项目和 Skill 动作；不包含模型密钥与运行时缓存。',
    'restore 会先完整校验每个分片和整文件摘要，再替换目标目录；目标已有数据时需要 --force。',
    'prune 只清理运行遥测（领域事件、会话回合、代理运行、模型调用日志）；聊天记录、Skill 动作账本和审批历史保留。',
    'Web 服务固定监听 loopback；Phase 1 不开放公网监听。',
  ].join('\n')
}

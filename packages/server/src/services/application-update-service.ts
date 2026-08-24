import { execFile } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

import type { SqliteStore } from '@dsh-cyber/persistence'

import { createLocalBackupBundle } from './local-backup-service.js'
import { ServiceError } from './service-error.js'

const execFileAsync = promisify(execFile)

export interface ApplicationUpdateStatus {
  supported: boolean
  channel: 'main'
  branch?: string
  currentRevision?: string
  targetRevision?: string
  commitsBehind?: number
  updateAvailable?: boolean
  reason?: string
}

export class ApplicationUpdateService {
  readonly #store: SqliteStore
  readonly #stateRoot: string
  readonly #applicationRoot: string
  #applying = false

  constructor(store: SqliteStore, stateRoot: string, applicationRoot: string) {
    this.#store = store
    this.#stateRoot = stateRoot
    this.#applicationRoot = resolve(applicationRoot)
  }

  async check(fetchRemote = true): Promise<ApplicationUpdateStatus> {
    try {
      const repositoryRoot = resolve(await this.#git(['rev-parse', '--show-toplevel']))
      if (!samePath(repositoryRoot, this.#applicationRoot)) return unsupported('当前启动目录不是 DSH Cyber 仓库根目录')
      const branch = await this.#git(['branch', '--show-current'])
      if (branch !== 'main') return { ...unsupported('请先切换到 main 分支再使用应用更新'), branch }
      const changes = await this.#git(['status', '--porcelain'])
      if (changes !== '') return { ...unsupported('当前程序目录存在未提交改动，不能自动更新'), branch }
      if (fetchRemote) await this.#git(['fetch', '--quiet', 'origin', 'main'])
      const currentRevision = await this.#git(['rev-parse', 'HEAD'])
      const targetRevision = await this.#git(['rev-parse', 'origin/main'])
      const [aheadText = '0', behindText = '0'] = (await this.#git(['rev-list', '--left-right', '--count', 'HEAD...origin/main'])).split(/\s+/)
      const ahead = Number(aheadText)
      const commitsBehind = Number(behindText)
      if (!Number.isFinite(ahead) || !Number.isFinite(commitsBehind)) return unsupported('无法读取版本差异')
      if (ahead > 0) return { ...unsupported('本地 main 包含远端没有的提交，不能自动快进更新'), branch, currentRevision, targetRevision, commitsBehind }
      return { supported: true, channel: 'main', branch, currentRevision, targetRevision, commitsBehind, updateAvailable: commitsBehind > 0 }
    } catch (error) {
      return unsupported(errorMessage(error))
    }
  }

  async apply(approved: boolean) {
    if (!approved) throw new ServiceError('conflict', 'application_update_approval_required', '应用更新需要明确确认')
    if (this.#applying) throw new ServiceError('conflict', 'application_update_in_progress', '应用更新正在进行中')
    this.#applying = true
    const candidateParent = join(this.#stateRoot, 'runtime', 'application-updates')
    const candidateRoot = join(candidateParent, randomUUID())
    let worktreeCreated = false
    try {
      const before = await this.check(true)
      if (!before.supported) throw new ServiceError('conflict', 'application_update_unavailable', before.reason ?? '当前环境不能自动更新')
      if (!before.updateAvailable) return { ok: true as const, applicationUpdate: before, restartRequired: false as const }

      await mkdir(candidateParent, { recursive: true })
      await this.#git(['worktree', 'add', '--detach', candidateRoot, 'origin/main'])
      worktreeCreated = true
      await runPnpmVerification(candidateRoot)

      const unchanged = await this.check(false)
      if (!unchanged.supported || unchanged.currentRevision !== before.currentRevision || unchanged.targetRevision !== before.targetRevision) {
        throw new ServiceError('conflict', 'application_update_changed', '验证期间本地或远端版本发生变化，请重新检查更新')
      }
      const backup = await createLocalBackupBundle(this.#stateRoot, this.#store, {
        output: join(this.#stateRoot, 'backups', `pre-application-${artifactTimestamp()}.dshbackup`),
      })
      await this.#git(['merge', '--ff-only', 'origin/main'])
      await runPnpmVerification(this.#applicationRoot)
      const status = await this.check(false)
      return { ok: true as const, applicationUpdate: status, backup, restartRequired: true as const }
    } finally {
      if (worktreeCreated) {
        try { await this.#git(['worktree', 'remove', '--force', candidateRoot]) } catch { await rm(candidateRoot, { recursive: true, force: true }) }
      }
      this.#applying = false
    }
  }

  async #git(args: string[]): Promise<string> {
    const result = await execFileAsync('git', ['-C', this.#applicationRoot, ...args], {
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      encoding: 'utf8',
    })
    return result.stdout.trim()
  }
}

function unsupported(reason: string): ApplicationUpdateStatus {
  return { supported: false, channel: 'main', updateAvailable: false, reason }
}

async function runPnpmVerification(cwd: string): Promise<void> {
  if (process.platform === 'win32') {
    const command = process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe'
    await execFileAsync(command, ['/d', '/s', '/c', 'pnpm install --frozen-lockfile && pnpm build'], {
      cwd,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      encoding: 'utf8',
    })
    return
  }
  await execFileAsync('pnpm', ['install', '--frozen-lockfile'], { cwd, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' })
  await execFileAsync('pnpm', ['build'], { cwd, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' })
}

function artifactTimestamp(): string {
  return new Date().toISOString().replaceAll(/[:.]/g, '-').replace('T', '_').replace('Z', '')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left)
  const normalizedRight = resolve(right)
  return process.platform === 'win32'
    ? normalizedLeft.toLocaleLowerCase() === normalizedRight.toLocaleLowerCase()
    : normalizedLeft === normalizedRight
}

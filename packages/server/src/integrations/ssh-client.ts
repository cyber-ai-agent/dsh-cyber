import { createHash } from 'node:crypto'

import { Client } from 'ssh2'

export const SSH_CONNECT_TIMEOUT_MS = 12_000
export const SSH_EXEC_TIMEOUT_MS = 30_000
export const SSH_OUTPUT_CAP_BYTES = 16 * 1024
export const SSH_SESSION_IDLE_MS = 5 * 60 * 1000

export type SshFailureKind = 'unreachable' | 'auth-failed' | 'command-failed' | 'timeout' | 'stream-lost'

export class SshError extends Error {
  readonly kind: SshFailureKind
  constructor(kind: SshFailureKind, message: string) {
    super(message)
    this.name = 'SshError'
    this.kind = kind
  }
}

export interface SshDeviceCredential {
  host: string
  port: number
  username: string
  privateKey?: string
  password?: string
}

export interface SshExecResult {
  code: number | null
  stdout: string
  stderr: string
}

/**
 * One-shot SSH executor: open a transport, run one command, close it. Used by
 * the trusted skill adapter when no session pool is configured and by tests.
 */
export function sshExecOnce(credential: SshDeviceCredential, command: string, options: { timeoutMs?: number } = {}): Promise<SshExecResult> {
  const pool = new SshSessionPool()
  return pool.exec(credential, command, options).finally(() => pool.close())
}

interface PoolEntry {
  key: string
  client: Client
  idleTimer: NodeJS.Timeout | undefined
  /** First connection attempt for a fresh entry; later commands wait on it. */
  connecting: Promise<void> | undefined
  running: Promise<void>
  /** Rejects commands that are active or queued when the transport dies. */
  transportFailure: Promise<never>
  failTransport: (error: SshError) => void
  clientError: (error: Error) => void
}

/**
 * Long-lived SSH sessions keyed by a device fingerprint (host/port/user plus
 * hashed credentials). A conversation that issues several commands against the
 * same device reuses one authenticated transport instead of reconnecting every
 * command; sessions idle out after `SSH_SESSION_IDLE_MS`. Editing the
 * connection's credentials or disabling/deleting it changes the fingerprint or
 * closes the session so stale sessions never outlive their authorization.
 *
 * Exec is serialized per transport; the pool never opens an interactive shell
 * and every command still goes through the same approval/preflight boundary.
 */
export class SshSessionPool {
  readonly #idleMs: number
  readonly #entries = new Map<string, PoolEntry>()
  #closed = false

  constructor(options: { idleMs?: number } = {}) {
    this.#idleMs = options.idleMs ?? SSH_SESSION_IDLE_MS
  }

  static fingerprint(device: SshDeviceCredential): string {
    return createHash('sha256').update(JSON.stringify({
      host: device.host,
      port: device.port,
      username: device.username,
      // Only hashes of the secrets take part in the key: the pool never keeps
      // plaintext credentials around for longer than one connect call.
      privateKeyHash: device.privateKey === undefined ? undefined : createHash('sha256').update(device.privateKey).digest('hex'),
      passwordHash: device.password === undefined ? undefined : createHash('sha256').update(device.password).digest('hex'),
    })).digest('hex')
  }

  get size(): number { return this.#entries.size }

  async exec(credential: SshDeviceCredential, command: string, options: { timeoutMs?: number } = {}): Promise<SshExecResult> {
    if (this.#closed) throw new Error('SSH session pool is closed')
    const key = SshSessionPool.fingerprint(credential)
    const entry = await this.#acquire(key, credential)
    // Serialize commands per transport so concurrent turns on the same device
    // cannot interleave exec streams. Every caller appends its own gate to
    // `running` before awaiting the previous gate, so two first commands can
    // never both pass the old resolved promise.
    const previous = entry.running
    let release!: () => void
    entry.running = new Promise<void>((resolve) => { release = resolve })
    await previous
    try {
      const result = await Promise.race([
        execOnClient(entry.client, command, options.timeoutMs),
        entry.transportFailure,
      ])
      this.#touch(entry)
      return result
    } catch (error) {
      // Transport/auth/timeout loss poisons the pooled session: drop it so the
      // next command reconnects instead of failing on a dead handle.
      if (error instanceof SshError && error.kind !== 'command-failed') this.#drop(key, entry)
      throw error
    } finally {
      release()
    }
  }

  /** Invalidate one device (credential change, disable or delete). */
  async invalidate(credential: SshDeviceCredential): Promise<void> {
    this.#drop(SshSessionPool.fingerprint(credential))
  }

  /** Close every pooled transport. Idempotent. */
  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    const entries = [...this.#entries.values()]
    for (const entry of entries) this.#drop(entry.key, entry)
  }

  #acquire(key: string, credential: SshDeviceCredential): Promise<PoolEntry> {
    const existing = this.#entries.get(key)
    if (existing !== undefined) {
      // A second concurrent first command arrives while the first connect is
      // still in flight: ssh2 Client.exec throws "Not connected" if called
      // before `ready`, so we must wait for the cached attempt, not return a
      // half-connected entry.
      if (existing.connecting !== undefined) {
        return existing.connecting.then(() => { this.#touch(existing); return existing })
      }
      this.#touch(existing)
      return Promise.resolve(existing)
    }
    let failTransport!: (error: SshError) => void
    const transportFailure = new Promise<never>((_resolve, reject) => { failTransport = reject })
    // A connection can fail while no command is waiting on it. Consume the
    // rejection here so a later command may still observe the same failure
    // without creating an unhandled-rejection process event.
    transportFailure.catch(() => undefined)
    const entry: PoolEntry = {
      key,
      client: new Client(),
      idleTimer: undefined,
      connecting: undefined,
      running: Promise.resolve(),
      transportFailure,
      failTransport,
      clientError: () => undefined,
    }
    entry.clientError = (error: Error): void => {
      entry.failTransport(new SshError('stream-lost', `SSH 连接中断，远端动作结果未知：${error.message}`))
      this.#drop(key, entry)
    }
    // Keep a listener for the entire pooled lifetime. `connect()` temporarily
    // adds its own handshake listener; removing that listener on `ready` must
    // not leave the Node EventEmitter with no error consumer.
    entry.client.on('error', entry.clientError)
    this.#entries.set(key, entry)
    const attempt = connect(entry.client, credential).catch((error) => {
      // A failed first attempt poisons nothing but the map entry itself.
      this.#drop(key, entry)
      throw error
    })
    entry.connecting = attempt
    return attempt.then(() => {
      entry.connecting = undefined
      this.#touch(entry)
      return entry
    })
  }

  #touch(entry: PoolEntry): void {
    if (entry.idleTimer !== undefined) clearTimeout(entry.idleTimer)
    entry.idleTimer = setTimeout(() => { this.#drop(entry.key, entry) }, this.#idleMs)
    // An idle SSH transport must never keep the app process alive.
    entry.idleTimer.unref?.()
  }

  #drop(key: string, expected?: PoolEntry): void {
    const entry = this.#entries.get(key)
    if (entry === undefined || (expected !== undefined && entry !== expected)) return
    this.#entries.delete(key)
    if (entry.idleTimer !== undefined) clearTimeout(entry.idleTimer)
    entry.client.off('error', entry.clientError)
    entry.failTransport(new SshError('stream-lost', 'SSH 会话已关闭，远端动作结果未知'))
    try { entry.client.end() } catch { /* already closed */ }
  }
}

async function connect(client: Client, credential: SshDeviceCredential): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      client.off('ready', onReady)
      const message = error.message
      const authish = /authentication|permission denied|publickey|password|key/i.test(message)
      reject(new SshError(authish ? 'auth-failed' : 'unreachable', authish ? `SSH 认证失败：${message}` : `SSH 连接失败：${message}`))
    }
    const onReady = (): void => {
      client.off('error', onError)
      resolve()
    }
    client.once('ready', onReady)
    client.once('error', onError)
    client.connect({
      host: credential.host,
      port: credential.port,
      username: credential.username,
      // Private key wins; password is the fallback for devices that only
      // allow keyboard-interactive password login.
      ...(credential.privateKey === undefined ? {} : { privateKey: Buffer.from(credential.privateKey, 'utf8') }),
      ...(credential.privateKey !== undefined || credential.password === undefined ? {} : { password: credential.password }),
      readyTimeout: SSH_CONNECT_TIMEOUT_MS,
      keepaliveInterval: 0,
    })
  })
}

/** Run one command on an already-connected transport and sanitize its output. */
function execOnClient(client: Client, command: string, timeoutMs = SSH_EXEC_TIMEOUT_MS): Promise<SshExecResult> {
  return new Promise((resolve, reject) => {
    let settled = false
    const settle = (fn: () => void): void => { if (!settled) { settled = true; fn() } }
    const execTimer = setTimeout(() => settle(() => {
      try { client.end() } catch { /* transport may already be gone */ }
      reject(new SshError('timeout', 'SSH 执行超时，远端动作结果未知；不得自动重试'))
    }), timeoutMs)
    try {
      client.exec(command, { pty: false }, (error, stream) => {
        if (error !== undefined && error !== null) {
          clearTimeout(execTimer)
          settle(() => reject(new SshError('command-failed', `SSH 无法启动命令：${error.message}`)))
          return
        }
        if (stream === undefined) {
          clearTimeout(execTimer)
          settle(() => reject(new SshError('command-failed', 'SSH 未返回命令通道')))
          return
        }
        let stdout = ''
        let stderr = ''
        stream.setEncoding('utf8')
        stream.on('data', (chunk: string) => { stdout = cap(`${stdout}${chunk}`) })
        stream.stderr.setEncoding('utf8')
        stream.stderr.on('data', (chunk: string) => { stderr = cap(`${stderr}${chunk}`) })
        stream.once('close', (code: number | null) => {
          clearTimeout(execTimer)
          settle(() => resolve({ code, stdout: sanitizeOutput(stdout), stderr: sanitizeOutput(stderr) }))
        })
        stream.once('error', (streamError: Error) => {
          clearTimeout(execTimer)
          settle(() => reject(new SshError('stream-lost', `SSH 命令通道中断，远端动作结果未知：${streamError.message}`)))
        })
      })
    } catch (error) {
      clearTimeout(execTimer)
      settle(() => reject(new SshError('stream-lost', `SSH 传输不可用，远端动作结果未知：${error instanceof Error ? error.message : String(error)}`)))
    }
  })
}

/** Remote output is untrusted: strip obvious secrets and bound the size. */
function sanitizeOutput(value: string): string {
  const scrubbed = value
    .replace(/(-----BEGIN [A-Z ]+ PRIVATE KEY-----)[\s\S]*?(-----END [A-Z ]+ PRIVATE KEY-----)/gi, '$1…$2')
    .replace(/(sk-[A-Za-z0-9_-]{12,})/g, 'sk-…')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]{8,}/gi, '$1…')
  return cap(scrubbed)
}

function cap(value: string): string {
  return value.length > SSH_OUTPUT_CAP_BYTES ? `${value.slice(0, SSH_OUTPUT_CAP_BYTES)}\n…（输出截断）` : value
}

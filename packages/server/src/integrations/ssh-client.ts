import { Client } from 'ssh2'

export const SSH_CONNECT_TIMEOUT_MS = 12_000
export const SSH_EXEC_TIMEOUT_MS = 30_000
export const SSH_OUTPUT_CAP_BYTES = 16 * 1024

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
 * One-shot SSH executor used by the trusted skill adapter. The private key
 * comes from the host credential vault and is used straight from memory — it
 * is never written to disk or surfaced in action records.
 *
 * Result mapping stays here in SSH terms (connect/exec); the Skill adapter
 * translates failures into skill action statuses (failed vs outcome-unknown).
 */
export function sshExecOnce(credential: SshDeviceCredential, command: string, options: { timeoutMs?: number } = {}): Promise<SshExecResult> {
  return new Promise((resolve, reject) => {
    const client = new Client()
    const connectTimeoutMs = SSH_CONNECT_TIMEOUT_MS
    const execTimeoutMs = options.timeoutMs ?? SSH_EXEC_TIMEOUT_MS
    let settled = false
    const settle = (fn: () => void): void => { if (!settled) { settled = true; fn() } }

    client.once('error', (error) => settle(() => {
      const message = error.message
      const authish = /authentication|permission denied|publickey|password|key/i.test(message)
      reject(new SshError(authish ? 'auth-failed' : 'unreachable', authish ? `SSH 认证失败：${message}` : `SSH 连接失败：${message}`))
    }))
    client.once('ready', () => {
      client.exec(command, { pty: false }, (error, stream) => {
        if (error !== undefined && error !== null) {
          settle(() => reject(new SshError('command-failed', `SSH 无法启动命令：${error.message}`)))
          return
        }
        if (stream === undefined) {
          settle(() => reject(new SshError('command-failed', 'SSH 未返回命令通道')))
          return
        }
        let stdout = ''
        let stderr = ''
        let execTimer = setTimeout(() => settle(() => { stream.close(); client.end(); reject(new SshError('timeout', 'SSH 执行超时，远端动作结果未知；不得自动重试')) }), execTimeoutMs)
        stream.setEncoding('utf8')
        stream.on('data', (chunk: string) => { stdout = cap(`${stdout}${chunk}`) })
        stream.stderr.setEncoding('utf8')
        stream.stderr.on('data', (chunk: string) => { stderr = cap(`${stderr}${chunk}`) })
        stream.once('close', (code: number | null) => {
          clearTimeout(execTimer)
          settle(() => { client.end(); resolve({ code, stdout: sanitizeOutput(stdout), stderr: sanitizeOutput(stderr) }) })
        })
        stream.once('error', (streamError: Error) => {
          clearTimeout(execTimer)
          settle(() => { client.end(); reject(new SshError('stream-lost', `SSH 命令通道中断，远端动作结果未知：${streamError.message}`)) })
        })
      })
    })

    client.connect({
      host: credential.host,
      port: credential.port,
      username: credential.username,
      // Private key wins; password is the fallback for devices that only
      // allow keyboard-interactive password login.
      ...(credential.privateKey === undefined ? {} : { privateKey: Buffer.from(credential.privateKey, 'utf8') }),
      ...(credential.privateKey !== undefined || credential.password === undefined ? {} : { password: credential.password }),
      readyTimeout: connectTimeoutMs,
      keepaliveInterval: 0,
    })
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

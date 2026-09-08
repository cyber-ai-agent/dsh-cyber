import { connect as tcpConnect } from 'node:net'

import type { IntegrationDescriptor, IntegrationHealth, JsonObject } from '@dsh-cyber/contracts'

import type { IntegrationProvider, IntegrationProviderContext } from './integration-registry.js'

export const SSH_DEVICE_INTEGRATION_ID = 'builtin.ssh-device'

const DESCRIPTOR: IntegrationDescriptor = {
  id: SSH_DEVICE_INTEGRATION_ID,
  displayName: 'SSH 设备',
  summary: '通过 SSH 连接的受信任设备。每台设备一条连接；角色需获授权并逐动作审批后才能执行命令。',
  configFields: [
    { id: 'displayName', displayName: '设备名称', description: '方便角色与用户识别的名称。', kind: 'text', required: false, placeholder: '客厅主机' },
    { id: 'host', displayName: '主机地址', description: '设备的 IP 或主机名；默认仅允许内网与回环地址。', kind: 'text', required: true, placeholder: '192.168.1.10' },
    { id: 'port', displayName: '端口', description: 'SSH 端口。', kind: 'number', required: false, placeholder: '22' },
    { id: 'username', displayName: '登录用户', description: '连接设备时使用的系统用户名。', kind: 'text', required: true, placeholder: 'root' },
    { id: 'allowPublic', displayName: '允许公网设备', description: '默认拒绝公网地址；打开后仍会在每次执行时提示高风险。', kind: 'boolean', required: false },
  ],
  secretFields: [
    { id: 'privateKey', displayName: '登录私钥', description: 'OpenSSH 私钥原文，仅在本机加密凭据库保存，保存后不回显。', kind: 'secret', required: false, multiline: true, placeholder: '-----BEGIN OPENSSH PRIVATE KEY-----' },
  ],
  skillIds: ['device.ssh.command'],
  dataEgress: ['设备名称/主机地址', '角色经审批后执行的命令文本'],
  allowsMultipleConnections: true,
}

export class SshDeviceIntegrationProvider implements IntegrationProvider {
  readonly descriptor = DESCRIPTOR

  validateConfig(config: JsonObject): JsonObject {
    const host = typeof config.host === 'string' ? config.host.trim() : ''
    if (!host) throw new Error('SSH 主机地址不能为空')
    if (host.includes(' ') || host.includes('/')) throw new Error('SSH 主机地址格式无效')
    const port = config.port === undefined || config.port === '' ? 22 : Number(config.port)
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('SSH 端口无效')
    const username = typeof config.username === 'string' ? config.username.trim() : ''
    if (!username) throw new Error('SSH 登录用户不能为空')
    const displayName = typeof config.displayName === 'string' ? config.displayName.trim().slice(0, 80) : ''
    const allowPublic = config.allowPublic === true
    if (!allowPublic && !isPrivateHost(host)) {
      throw new Error('SSH 只允许连接内网或回环设备；公网设备需要显式开启“允许公网设备”')
    }
    return {
      ...(displayName ? { displayName } : {}),
      host,
      port,
      username,
      ...(allowPublic ? { allowPublic: true } : {}),
    }
  }

  async testConnection(context: IntegrationProviderContext): Promise<IntegrationHealth> {
    const startedAt = Date.now()
    const config = this.validateConfig(context.config)
    const credentialPresent = Boolean(context.credential)
    const detail = credentialPresent
      ? 'SSH 端口可达，凭据已保存（完整登录验证在执行命令时进行）'
      : 'SSH 端口可达，但尚未配置私钥或密码'
    try {
      await probeSshBanner(String(config.host), Number(config.port), 5_000)
      return { status: 'ready', detail, checkedAt: context.now.toISOString(), latencyMs: Date.now() - startedAt }
    } catch (error) {
      const message = error instanceof Error ? error.message : '无法连接'
      return { status: 'unreachable', detail: message, checkedAt: context.now.toISOString(), latencyMs: Date.now() - startedAt }
    }
  }
}

function probeSshBanner(host: string, port: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = tcpConnect({ host, port })
    const onError = (error: Error): void => { cleanup(); reject(new Error(`SSH 端口无法连接：${error.message}`)) }
    const onTimeout = (): void => { cleanup(); reject(new Error('SSH 连接超时')) }
    const onData = (chunk: Buffer): void => {
      cleanup()
      if (chunk.toString('utf8').startsWith('SSH-')) resolve()
      else reject(new Error('对端不是 SSH 服务'))
    }
    const cleanup = (): void => {
      socket.destroy()
      socket.off('error', onError); socket.off('timeout', onTimeout); socket.off('data', onData)
    }
    socket.setTimeout(timeoutMs)
    socket.once('error', onError)
    socket.once('timeout', onTimeout)
    socket.once('data', onData)
  })
}

export function isPrivateHost(value: string): boolean {
  const host = value.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host === '::1' || host.endsWith('.local')) return true
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (ipv4 === null) return host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:')
  const octets = ipv4.slice(1).map(Number)
  if (octets.some((item) => item > 255)) return false
  const [first, second] = octets
  return first === 10 || first === 127
    || (first === 172 && second !== undefined && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 169 && second === 254)
}

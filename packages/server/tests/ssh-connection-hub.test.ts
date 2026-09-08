import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'

import { afterEach, describe, expect, it } from 'vitest'

import { createBuiltinIntegrationRegistry } from '../src/integrations/builtin-integration-registry.js'
import { IntegrationService } from '../src/integrations/integration-service.js'
import { SSH_DEVICE_INTEGRATION_ID, SshDeviceIntegrationProvider, isPrivateHost } from '../src/integrations/ssh-provider.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

async function openService(): Promise<IntegrationService> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ssh-connections-'))
  roots.push(root)
  return IntegrationService.open(root, createBuiltinIntegrationRegistry())
}

describe('SSH multi-connection hub', () => {
  it('registers an SSH device provider that allows multiple connections', () => {
    const registry = createBuiltinIntegrationRegistry()
    const descriptor = registry.list().find((item) => item.id === SSH_DEVICE_INTEGRATION_ID)
    expect(descriptor).toBeDefined()
    expect(descriptor!.allowsMultipleConnections).toBe(true)
    expect(descriptor!.skillIds).toContain('device.ssh.command')
  })

  it('validates SSH config: host/user required, private-range enforced by default', () => {
    const provider = new SshDeviceIntegrationProvider()
    expect(() => provider.validateConfig({ host: '', username: 'root' })).toThrow(/主机地址不能为空/)
    expect(() => provider.validateConfig({ host: '8.8.8.8', username: 'root' })).toThrow(/只允许连接内网或回环/)
    expect(provider.validateConfig({ host: '10.0.0.8', username: 'root', port: 22 })).toEqual({ host: '10.0.0.8', port: 22, username: 'root' })
    expect(provider.validateConfig({ host: 'example.com', username: 'root', allowPublic: true })).toMatchObject({ host: 'example.com', username: 'root', allowPublic: true })
  })

  it('classifies hosts as private or public consistently', () => {
    for (const host of ['10.1.2.3', '127.0.0.1', 'localhost', '192.168.1.5', '172.16.0.2', '169.254.1.1', '[fd12::1]']) {
      expect(isPrivateHost(host)).toBe(true)
    }
    for (const host of ['8.8.8.8', 'example.com', '1.1.1.1']) {
      expect(isPrivateHost(host)).toBe(false)
    }
  })

  it('keeps several SSH devices of one type with independent credentials', async () => {
    const service = await openService()
    const first = await service.save({
      workspaceId: 'workspace-1', integrationId: SSH_DEVICE_INTEGRATION_ID,
      config: { displayName: '客厅主机', host: '10.0.0.10', username: 'owner' }, enabled: true, credential: 'key-a',
    })
    const second = await service.save({
      workspaceId: 'workspace-1', integrationId: SSH_DEVICE_INTEGRATION_ID,
      config: { displayName: '工作区服务器', host: '192.168.1.20', username: 'deploy' }, enabled: true, credential: 'key-b',
    })
    expect(service.listByType('workspace-1', SSH_DEVICE_INTEGRATION_ID)).toHaveLength(2)
    expect(service.getById('workspace-1', first.id)).toMatchObject({ displayName: '客厅主机', enabled: true })
    expect(service.credentialForConnection('workspace-1', first.id)).toBe('key-a')
    expect(service.credentialForConnection('workspace-1', second.id)).toBe('key-b')
    // Editing one connection never touches the sibling's credential.
    await service.save({
      workspaceId: 'workspace-1', integrationId: SSH_DEVICE_INTEGRATION_ID, connectionId: first.id,
      config: { displayName: '客厅主机(改)', host: '10.0.0.10', username: 'owner' }, enabled: true, credential: 'key-a-v2',
    })
    expect(service.getById('workspace-1', first.id)?.displayName).toBe('客厅主机(改)')
    expect(service.credentialForConnection('workspace-1', first.id)).toBe('key-a-v2')
    expect(service.credentialForConnection('workspace-1', second.id)).toBe('key-b')
    expect(await service.delete('workspace-1', SSH_DEVICE_INTEGRATION_ID, first.id)).toBe(true)
    expect(service.listByType('workspace-1', SSH_DEVICE_INTEGRATION_ID)).toHaveLength(1)
    expect(service.credentialForConnection('workspace-1', second.id)).toBe('key-b')
    service.close()
  })

  it('tests a connection against a reachable SSH banner without sending credentials', async () => {
    const server = createServer((socket) => { socket.write('SSH-2.0-OpenSSH_test\r\n') })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    const service = await openService()
    const connection = await service.save({
      workspaceId: 'workspace-1', integrationId: SSH_DEVICE_INTEGRATION_ID,
      config: { displayName: '本机测试', host: '127.0.0.1', port, username: 'tester' }, enabled: true, credential: 'private-key-material',
    })
    const health = await service.test('workspace-1', SSH_DEVICE_INTEGRATION_ID, connection.id)
    expect(health.status).toBe('ready')
    expect(JSON.stringify(service.list('workspace-1'))).not.toContain('private-key-material')
    service.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('reports an unreachable or non-SSH endpoint as unreachable', async () => {
    const server = createServer((socket) => { socket.write('HTTP/1.1 200 OK\r\n') })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    const service = await openService()
    const connection = await service.save({
      workspaceId: 'workspace-1', integrationId: SSH_DEVICE_INTEGRATION_ID,
      config: { displayName: '非 SSH 端口', host: '127.0.0.1', port, username: 'tester' }, enabled: true,
    })
    expect((await service.test('workspace-1', SSH_DEVICE_INTEGRATION_ID, connection.id)).status).toBe('unreachable')
    service.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
})

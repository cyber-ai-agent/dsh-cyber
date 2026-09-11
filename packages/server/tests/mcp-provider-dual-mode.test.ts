import type { JsonObject } from '@dsh-cyber/contracts'

import { afterEach, describe, expect, it } from 'vitest'

import type { McpClientConnection, McpClientFactory } from '../src/integrations/mcp-client.js'
import {
  MCP_INTEGRATION_ID,
  mcpConnectSpec,
  mcpConnectSpecFor,
  mcpLocalArgs,
  mcpMode,
} from '../src/integrations/mcp-provider.js'
import { createBuiltinIntegrationRegistry } from '../src/integrations/builtin-integration-registry.js'

describe('MCP dual-mode provider', () => {
  it('backfills legacy endpoint configs to the remote mode', () => {
    const config = { service: 'github', endpoint: 'https://mcp.example.com' }
    expect(mcpMode(config)).toBe('remote')
    const spec = mcpConnectSpec(config as JsonObject)
    expect(spec).toEqual({ kind: 'remote', endpoint: 'https://mcp.example.com' })
  })

  it('normalizes a local config into command + collapsed arguments', () => {
    const registry = createBuiltinIntegrationRegistry(new NoopMcpClientFactory())
    const provider = registry.require(MCP_INTEGRATION_ID)
    const config = provider.validateConfig({
      service: 'playwright',
      mode: 'local',
      command: '  npx ',
      args: '@playwright/mcp@latest   --port 8931 --isolated',
      endpoint: 'http://stale.example.com',
      displayName: 'Playwright',
    })
    expect(config).toEqual({
      service: 'playwright',
      mode: 'local',
      command: 'npx',
      args: '@playwright/mcp@latest --port 8931 --isolated',
      displayName: 'Playwright',
    })
    expect(mcpLocalArgs(config)).toEqual(['@playwright/mcp@latest', '--port', '8931', '--isolated'])
  })

  it('rejects local configs that cannot be launched as a plain argv', () => {
    const registry = createBuiltinIntegrationRegistry(new NoopMcpClientFactory())
    const provider = registry.require(MCP_INTEGRATION_ID)
    expect(() => provider.validateConfig({ service: 'x', mode: 'local' })).toThrow('启动命令未配置')
    expect(() => provider.validateConfig({ service: 'x', mode: 'local', command: 'node && rm -rf' })).toThrow('Shell 元字符')
    expect(() => provider.validateConfig({ service: 'x', mode: 'local', command: 'node', args: 'a "b c" d' })).toThrow('Shell 元字符')
    const overflow = Array.from({ length: 17 }, (_, index) => `arg${index}`).join(' ')
    expect(() => provider.validateConfig({ service: 'x', mode: 'local', command: 'node', args: overflow })).toThrow('参数过多')
  })

  it('rejects a remote config without an endpoint even when a stale local endpoint is absent', () => {
    const registry = createBuiltinIntegrationRegistry(new NoopMcpClientFactory())
    const provider = registry.require(MCP_INTEGRATION_ID)
    expect(() => provider.validateConfig({ service: 'x', mode: 'remote' })).toThrow('MCP 地址未配置')
  })

  it('only attaches a bearer credential to remote specs', () => {
    const remote = { service: 'github', mode: 'remote', endpoint: 'https://mcp.example.com' } as JsonObject
    expect(mcpConnectSpecFor(remote)).toEqual({ kind: 'remote', endpoint: 'https://mcp.example.com' })
    expect(mcpConnectSpecFor(remote, 'top-secret')).toEqual({ kind: 'remote', endpoint: 'https://mcp.example.com', bearerToken: 'top-secret' })
    const local = { service: 'pw', mode: 'local', command: 'npx', args: '@playwright/mcp' } as JsonObject
    expect(mcpConnectSpecFor(local, 'top-secret')).toEqual({ kind: 'local', command: 'npx', args: ['@playwright/mcp'] })
  })

  it('tests a local connection through the provider health seam', async () => {
    const calls: Array<{ kind: string }> = []
    const factory: McpClientFactory = {
      async connect(spec) {
        calls.push({ kind: spec.kind })
        return {
          listTools: async () => (spec.kind === 'local' ? [{ name: 'echo', inputSchema: {} }] : []),
          callTool: async () => ({}),
          close: async () => undefined,
        } satisfies McpClientConnection
      },
    }
    const registry = createBuiltinIntegrationRegistry(factory)
    const provider = registry.require(MCP_INTEGRATION_ID)
    const config = provider.validateConfig({ service: 'pw', mode: 'local', command: 'npx', args: '@playwright/mcp' })
    const health = await provider.testConnection({ config, fetch: globalThis.fetch, now: new Date() })
    expect(health.status).toBe('ready')
    expect(health.detail).toContain('1 个工具')
    expect(calls).toEqual([{ kind: 'local' }])
  })
})

class NoopMcpClientFactory implements McpClientFactory {
  async connect(): Promise<McpClientConnection> {
    return { listTools: async () => [], callTool: async () => ({}), close: async () => undefined }
  }
}

import { describe, expect, it, vi } from 'vitest'
import type { IntegrationConnection, World } from '@dsh-cyber/contracts'
import type { SqliteStore } from '@dsh-cyber/persistence'

import type { IntegrationService } from '../src/integrations/integration-service.js'
import type { McpClientFactory, McpResourceContent, McpResourceDefinition } from '../src/integrations/mcp-client.js'
import { McpResourceKnowledgeService } from '../src/services/mcp-resource-knowledge-service.js'
import type { WorldKnowledgeLibraryService } from '../src/services/world-knowledge-library-service.js'

const uri = 'weather://about?access_token=never-store-this'

function fixture(options: {
  connectionWorld?: string
  enabled?: boolean
  resources?: McpResourceDefinition[]
  contents?: McpResourceContent[]
} = {}) {
  const world = { id: 'world-a', workspaceId: 'workspace-a', status: 'active' } as World
  const connection: IntegrationConnection = {
    id: 'mcp-a',
    workspaceId: options.connectionWorld ?? world.workspaceId,
    integrationId: 'builtin.mcp',
    displayName: '天气服务',
    config: { mode: 'remote', service: 'weather', endpoint: 'https://mcp.example.test/mcp' },
    enabled: options.enabled ?? true,
    credentialConfigured: true,
    createdAt: '2026-09-26T00:00:00.000Z',
    updatedAt: '2026-09-26T00:00:00.000Z',
  }
  const resources = options.resources ?? [{ uri, name: 'about', title: '天气说明', mimeType: 'text/plain' }]
  let contents = options.contents ?? [{ uri, mimeType: 'text/plain', text: '明天有雨。' }]
  const close = vi.fn(async () => undefined)
  const connect = vi.fn(async () => ({ listTools: async () => [], callTool: async () => undefined, listResources: async () => resources, readResource: async () => contents, close }))
  const createFromText = vi.fn(async (input: unknown) => ({ id: 'document-a', ...(input as object) }))
  const store = { getWorld: (id: string) => id === world.id ? world : undefined } as Pick<SqliteStore, 'getWorld'>
  const integrations = {
    getById: (workspaceId: string, connectionId: string) => workspaceId === connection.workspaceId && connectionId === connection.id ? connection : undefined,
    credentialForConnection: (workspaceId: string, connectionId: string) => workspaceId === connection.workspaceId && connectionId === connection.id ? 'vault-only-secret' : undefined,
  } as Pick<IntegrationService, 'getById' | 'credentialForConnection'>
  const service = new McpResourceKnowledgeService({
    store,
    integrations,
    clients: { connect } as McpClientFactory,
    library: { createFromText } as unknown as Pick<WorldKnowledgeLibraryService, 'createFromText'>,
  })
  return { service, connect, close, createFromText, setContents: (next: McpResourceContent[]) => { contents = next } }
}

describe('MCP resource to world knowledge', () => {
  it('previews advertised text and imports the reviewed bytes without persisting a credential-bearing URI', async () => {
    const { service, connect, close, createFromText } = fixture()
    const preview = await service.preview('world-a', 'mcp-a', uri)
    expect(preview).toMatchObject({ title: '天气说明', text: '明天有雨。', truncated: false })
    const result = await service.import('world-a', 'mcp-a', uri, preview.contentHash)
    expect(result.id).toBe('document-a')
    expect(createFromText).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'workspace-a',
      worldId: 'world-a',
      title: '天气说明',
      collectionName: 'MCP · 天气服务',
      relativePath: expect.stringMatching(/^mcp\/weather\/[0-9a-f]{32}\.md$/),
    }))
    const saved = JSON.stringify(createFromText.mock.calls[0]?.[0])
    expect(saved).toContain('明天有雨。')
    expect(saved).not.toContain('never-store-this')
    expect(saved).not.toContain('vault-only-secret')
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({ kind: 'remote', bearerToken: 'vault-only-secret' }))
    expect(close).toHaveBeenCalledTimes(2)
  })

  it('refuses a changed resource between preview and import', async () => {
    const { service, setContents, createFromText } = fixture()
    const preview = await service.preview('world-a', 'mcp-a', uri)
    setContents([{ uri, text: '内容已改变。' }])
    await expect(service.import('world-a', 'mcp-a', uri, preview.contentHash)).rejects.toMatchObject({ code: 'mcp_resource_changed' })
    expect(createFromText).not.toHaveBeenCalled()
  })

  it('keeps another workspace or a disabled connection outside the world', async () => {
    const outside = fixture({ connectionWorld: 'workspace-b' })
    await expect(outside.service.list('world-a', 'mcp-a')).rejects.toMatchObject({ code: 'mcp_connection_unavailable' })
    expect(outside.connect).not.toHaveBeenCalled()
    const disabled = fixture({ enabled: false })
    await expect(disabled.service.preview('world-a', 'mcp-a', uri)).rejects.toMatchObject({ code: 'mcp_connection_unavailable' })
    expect(disabled.connect).not.toHaveBeenCalled()
  })

  it('rejects unadvertised, binary and oversized resources before saving', async () => {
    const unadvertised = fixture({ resources: [{ uri: 'weather://other', name: 'other' }] })
    await expect(unadvertised.service.preview('world-a', 'mcp-a', uri)).rejects.toMatchObject({ code: 'mcp_resource_not_advertised' })
    const binary = fixture({ contents: [{ uri, mimeType: 'image/png', blob: 'AA==' }] })
    await expect(binary.service.preview('world-a', 'mcp-a', uri)).rejects.toMatchObject({ code: 'mcp_resource_text_required' })
    const oversized = fixture({ contents: [{ uri, text: 'x'.repeat(1024 * 1024 + 1) }] })
    await expect(oversized.service.preview('world-a', 'mcp-a', uri)).rejects.toMatchObject({ code: 'mcp_resource_too_large' })
    expect(binary.createFromText).not.toHaveBeenCalled()
    expect(oversized.createFromText).not.toHaveBeenCalled()
  })
})

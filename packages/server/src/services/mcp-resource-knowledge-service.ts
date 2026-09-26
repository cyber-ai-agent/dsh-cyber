import { createHash } from 'node:crypto'

import type { IntegrationConnection } from '@dsh-cyber/contracts'
import type { SqliteStore } from '@dsh-cyber/persistence'

import type { IntegrationService } from '../integrations/integration-service.js'
import type { McpClientConnection, McpClientFactory, McpResourceDefinition } from '../integrations/mcp-client.js'
import { MCP_INTEGRATION_ID, mcpConnectSpecFor, mcpServiceSlug } from '../integrations/mcp-provider.js'
import { ServiceError } from './service-error.js'
import type { WorldKnowledgeLibraryService } from './world-knowledge-library-service.js'

const MAX_RESOURCE_URI_CHARS = 2_048
const MAX_RESOURCE_BYTES = 1024 * 1024
const MAX_RESOURCE_PARTS = 16
const PREVIEW_CHARS = 8_000

export interface McpResourcePreview {
  uri: string
  title: string
  mimeType?: string
  text: string
  byteLength: number
  contentHash: string
  truncated: boolean
}

/**
 * User-directed MCP resource reading. The connection belongs to the current
 * world's workspace, and the exact URI must still be advertised before every
 * read. Remote content is bounded text and enters the ordinary local knowledge
 * import path only after the owner chooses Import.
 */
export class McpResourceKnowledgeService {
  readonly #store: Pick<SqliteStore, 'getWorld'>
  readonly #integrations: Pick<IntegrationService, 'getById' | 'credentialForConnection'>
  readonly #clients: McpClientFactory
  readonly #library: Pick<WorldKnowledgeLibraryService, 'createFromText'>

  constructor(options: {
    store: Pick<SqliteStore, 'getWorld'>
    integrations: Pick<IntegrationService, 'getById' | 'credentialForConnection'>
    clients: McpClientFactory
    library: Pick<WorldKnowledgeLibraryService, 'createFromText'>
  }) {
    this.#store = options.store
    this.#integrations = options.integrations
    this.#clients = options.clients
    this.#library = options.library
  }

  async list(worldId: string, connectionId: string): Promise<McpResourceDefinition[]> {
    const connection = this.#connection(worldId, connectionId).connection
    return this.#withClient(connection, async (client) => this.#resources(client))
  }

  async preview(worldId: string, connectionId: string, uri: string): Promise<McpResourcePreview> {
    const connection = this.#connection(worldId, connectionId).connection
    const read = await this.#read(connection, uri)
    return {
      uri,
      title: read.title,
      ...(read.mimeType === undefined ? {} : { mimeType: read.mimeType }),
      text: read.text.slice(0, PREVIEW_CHARS),
      byteLength: read.byteLength,
      contentHash: createHash('sha256').update(read.text).digest('hex'),
      truncated: read.text.length > PREVIEW_CHARS,
    }
  }

  async import(worldId: string, connectionId: string, uri: string, expectedHash: string) {
    if (!/^[0-9a-f]{64}$/.test(expectedHash)) throw new ServiceError('invalid', 'mcp_resource_preview_required', '请先预览要导入的 MCP 资源')
    const { workspaceId, connection } = this.#connection(worldId, connectionId)
    const read = await this.#read(connection, uri)
    if (createHash('sha256').update(read.text).digest('hex') !== expectedHash) {
      throw new ServiceError('conflict', 'mcp_resource_changed', 'MCP 资源在预览后发生变化，请重新预览再导入')
    }
    const fingerprint = createHash('sha256').update(`${connection.id}\0${uri}`).digest('hex')
    const service = mcpServiceSlug(connection.config)
    const title = read.title.replace(/[\r\n#]/g, ' ').trim() || 'MCP 资源'
    const connectionName = connection.displayName.replace(/[\r\n]/g, ' ').trim().slice(0, 80)
    // The raw URI may contain a credential in its query or path. Only a stable
    // digest and the selected connection name enter durable local knowledge.
    const text = `# ${title}\n\n来源：MCP 连接「${connectionName}」\n资源标识：${fingerprint.slice(0, 16)}\n\n${read.text}`
    return this.#library.createFromText({
      workspaceId,
      worldId,
      title,
      text,
      relativePath: `mcp/${service}/${fingerprint.slice(0, 32)}.md`,
      collectionName: `MCP · ${connectionName}`,
      collectionOrigin: 'manual',
    })
  }

  #connection(worldId: string, connectionId: string): { workspaceId: string; connection: IntegrationConnection } {
    const world = this.#store.getWorld(worldId)
    if (world === undefined || world.status === 'archived') {
      throw new ServiceError('not-found', 'world_not_found', '当前世界不存在或已归档')
    }
    const connection = this.#integrations.getById(world.workspaceId, connectionId)
    if (connection === undefined || connection.integrationId !== MCP_INTEGRATION_ID || !connection.enabled) {
      throw new ServiceError('not-found', 'mcp_connection_unavailable', '当前世界所属工作区没有可用的 MCP 连接')
    }
    return { workspaceId: world.workspaceId, connection }
  }

  async #read(connection: IntegrationConnection, uri: string): Promise<{ title: string; mimeType?: string; text: string; byteLength: number }> {
    if (!uri.trim() || uri.length > MAX_RESOURCE_URI_CHARS || /[\0\r\n]/.test(uri)) {
      throw new ServiceError('invalid', 'mcp_resource_uri_invalid', 'MCP 资源地址无效')
    }
    return this.#withClient(connection, async (client) => {
      const resource = (await this.#resources(client)).find((item) => item.uri === uri)
      if (resource === undefined) throw new ServiceError('not-found', 'mcp_resource_not_advertised', '该资源已不在当前 MCP 连接的目录中，请刷新后重试')
      if (client.readResource === undefined) throw new ServiceError('unsupported', 'mcp_resources_unavailable', '当前 MCP 客户端不支持读取资源')
      const contents = await client.readResource(uri)
      if (contents.length === 0 || contents.length > MAX_RESOURCE_PARTS) {
        throw new ServiceError('invalid', 'mcp_resource_parts_invalid', 'MCP 资源内容为空或分段过多')
      }
      const parts: string[] = []
      let byteLength = 0
      for (const part of contents) {
        if (part.uri !== uri || part.blob !== undefined || typeof part.text !== 'string' || !textualMimeType(part.mimeType ?? resource.mimeType)) {
          throw new ServiceError('unsupported', 'mcp_resource_text_required', '目前只能导入当前资源的文本内容；二进制资源请先另存为文件')
        }
        byteLength += Buffer.byteLength(part.text, 'utf8')
        if (byteLength > MAX_RESOURCE_BYTES) throw new ServiceError('too-large', 'mcp_resource_too_large', 'MCP 资源超过 1 MiB，请先在来源服务中缩小内容')
        parts.push(part.text)
      }
      const text = parts.join('\n\n')
      if (!text.trim()) throw new ServiceError('invalid', 'mcp_resource_empty', 'MCP 资源没有可导入的文字')
      return {
        title: (resource.title ?? resource.name).replace(/[\r\n]/g, ' ').slice(0, 180),
        ...(resource.mimeType === undefined ? {} : { mimeType: resource.mimeType }),
        text,
        byteLength,
      }
    })
  }

  async #resources(client: McpClientConnection): Promise<McpResourceDefinition[]> {
    if (client.listResources === undefined) throw new ServiceError('unsupported', 'mcp_resources_unavailable', '当前 MCP 客户端不支持资源目录')
    const listed = await client.listResources()
    return listed.slice(0, 100).flatMap((resource) => {
      if (typeof resource.uri !== 'string' || resource.uri.length === 0 || resource.uri.length > MAX_RESOURCE_URI_CHARS || typeof resource.name !== 'string') return []
      return [{
        uri: resource.uri,
        name: resource.name.replace(/[\r\n]/g, ' ').slice(0, 180),
        ...(typeof resource.title === 'string' ? { title: resource.title.replace(/[\r\n]/g, ' ').slice(0, 180) } : {}),
        ...(typeof resource.description === 'string' ? { description: resource.description.replace(/[\r\n]/g, ' ').slice(0, 300) } : {}),
        ...(typeof resource.mimeType === 'string' ? { mimeType: resource.mimeType.slice(0, 120) } : {}),
      }]
    })
  }

  async #withClient<T>(connection: IntegrationConnection, use: (client: McpClientConnection) => Promise<T>): Promise<T> {
    let client: McpClientConnection
    try {
      client = await this.#clients.connect(mcpConnectSpecFor(
        connection.config,
        this.#integrations.credentialForConnection(connection.workspaceId, connection.id),
      ))
    } catch {
      throw new ServiceError('unavailable', 'mcp_resource_connection_failed', 'MCP 连接暂时不可用，请检查连接设置后重试')
    }
    try { return await use(client) }
    catch (error) {
      if (error instanceof ServiceError) throw error
      throw new ServiceError('unavailable', 'mcp_resource_read_failed', 'MCP 服务未能返回资源，请稍后重试')
    }
    finally { await client.close().catch(() => undefined) }
  }
}

function textualMimeType(value: string | undefined): boolean {
  if (value === undefined) return true
  const mimeType = value.toLowerCase().split(';', 1)[0]?.trim() ?? ''
  return mimeType.startsWith('text/') || mimeType === 'application/json' || mimeType === 'application/xml' || mimeType === 'application/yaml'
}

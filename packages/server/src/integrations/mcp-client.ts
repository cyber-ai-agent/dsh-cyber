import { Client, StreamableHTTPClientTransport, type AuthProvider } from '@modelcontextprotocol/client'

import type { JsonObject } from '@dsh-cyber/contracts'

export interface McpToolDefinition {
  name: string
  description?: string
  inputSchema: JsonObject
  annotations?: JsonObject
}

export interface McpClientConnection {
  listTools(): Promise<McpToolDefinition[]>
  callTool(name: string, args: JsonObject): Promise<unknown>
  close(): Promise<void>
}

export interface McpClientFactory {
  connect(endpoint: string, bearerToken?: string): Promise<McpClientConnection>
}

/** Official MCP SDK transport seam. Tests inject a fake without opening sockets. */
export class OfficialMcpClientFactory implements McpClientFactory {
  async connect(endpoint: string, bearerToken?: string): Promise<McpClientConnection> {
    const client = new Client({ name: 'dsh-cyber', version: '0.1.0' })
    const authProvider: AuthProvider | undefined = bearerToken === undefined
      ? undefined
      : { token: async () => bearerToken }
    const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
      ...(authProvider === undefined ? {} : { authProvider }),
      requestInit: { signal: AbortSignal.timeout(30_000) },
      onInsufficientScope: 'throw',
    })
    await client.connect(transport)
    return {
      async listTools() {
        const tools: McpToolDefinition[] = []
        let cursor: string | undefined
        do {
          const page = await client.listTools(cursor === undefined ? {} : { cursor })
          for (const tool of page.tools) {
            tools.push({
              name: tool.name,
              ...(tool.description === undefined ? {} : { description: tool.description }),
              inputSchema: tool.inputSchema as JsonObject,
              ...(tool.annotations === undefined ? {} : { annotations: tool.annotations as JsonObject }),
            })
          }
          cursor = page.nextCursor
        } while (cursor !== undefined)
        return tools
      },
      callTool(name, args) { return client.callTool({ name, arguments: args }) },
      close() { return client.close() },
    }
  }
}

import { Client, StreamableHTTPClientTransport, type AuthProvider } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

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

/**
 * How a connection talks to an MCP server:
 * - `remote`: connect to an already-running Streamable HTTP endpoint
 *   (optionally with a bearer credential).
 * - `local`: launch the configured local process and speak MCP over its
 *   stdio. The child inherits only the SDK's safe default environment and is
 *   killed when the session closes.
 */
export type McpConnectSpec =
  | { kind: 'remote'; endpoint: string; bearerToken?: string }
  | { kind: 'local'; command: string; args: readonly string[] }

export interface McpClientFactory {
  connect(spec: McpConnectSpec): Promise<McpClientConnection>
}

/** Official MCP SDK transport seam. Tests inject a fake without opening sockets or spawning processes. */
export class OfficialMcpClientFactory implements McpClientFactory {
  async connect(spec: McpConnectSpec): Promise<McpClientConnection> {
    const client = new Client({ name: 'dsh-cyber', version: '0.1.0' })
    if (spec.kind === 'local') {
      const transport = new StdioClientTransport({
        command: spec.command,
        args: [...spec.args],
        stderr: 'ignore',
      })
      await client.connect(transport)
      return wrapMcpClient(client)
    }
    const authProvider: AuthProvider | undefined = spec.bearerToken === undefined
      ? undefined
      : { token: async () => spec.bearerToken }
    const transport = new StreamableHTTPClientTransport(new URL(spec.endpoint), {
      ...(authProvider === undefined ? {} : { authProvider }),
      requestInit: { signal: AbortSignal.timeout(30_000) },
      onInsufficientScope: 'throw',
    })
    await client.connect(transport)
    return wrapMcpClient(client)
  }
}

function wrapMcpClient(client: Client): McpClientConnection {
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

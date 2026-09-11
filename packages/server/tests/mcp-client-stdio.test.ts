import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { OfficialMcpClientFactory } from '../src/integrations/mcp-client.js'

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

/**
 * A hand-rolled minimal MCP stdio server: newline-delimited JSON-RPC over
 * stdin/stdout. It speaks just enough of the protocol (initialize,
 * tools/list, tools/call) to exercise the real StdioClientTransport path —
 * including the process launch and the kill-on-close.
 */
const ECHO_SERVER_SCRIPT = `
import { createInterface } from 'node:readline'

const rl = createInterface({ input: process.stdin })
const send = (message) => { process.stdout.write(JSON.stringify(message) + '\\n') }
rl.on('line', (line) => {
  const text = line.trim()
  if (text === '') return
  let message
  try { message = JSON.parse(text) } catch { return }
  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'echo-mcp', version: '0.1.0' },
      },
    })
  } else if (message.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        tools: [{
          name: 'echo',
          description: 'Echoes the text argument',
          inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
        }],
      },
    })
  } else if (message.method === 'tools/call') {
    const value = message.params?.arguments?.text
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: { content: [{ type: 'text', text: typeof value === 'string' ? 'echo:' + value : 'echo:' }] },
    })
  }
})
`

describe('OfficialMcpClientFactory local (stdio) mode', () => {
  it('launches a local process, discovers and calls its tools, then closes it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mcp-stdio-')); directories.push(directory)
    const scriptPath = join(directory, 'echo-mcp.mjs')
    await writeFile(scriptPath, ECHO_SERVER_SCRIPT, 'utf8')

    const factory = new OfficialMcpClientFactory()
    const connection = await factory.connect({ kind: 'local', command: process.execPath, args: [scriptPath] })
    const tools = await connection.listTools()
    expect(tools).toEqual([
      {
        name: 'echo',
        description: 'Echoes the text argument',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
      },
    ])
    const result = (await connection.callTool('echo', { text: 'hello-mcp' })) as { content?: Array<{ type: string; text?: string }> }
    expect(result.content?.[0]).toMatchObject({ type: 'text', text: 'echo:hello-mcp' })
    await connection.close()
    // Closing the session ended the transport: the dead session no longer
    // serves tools (a live one would still return the echo tool).
    const afterClose = await connection.listTools().catch(() => [])
    expect(afterClose).toEqual([])
  })

  it('fails cleanly when the configured command does not exist', async () => {
    const factory = new OfficialMcpClientFactory()
    const missing = process.platform === 'win32' ? 'dsh-cyber-definitely-missing-mcp' : '/nonexistent/dsh-cyber-mcp'
    await expect(factory.connect({ kind: 'local', command: missing, args: [] })).rejects.toThrow()
  })
})

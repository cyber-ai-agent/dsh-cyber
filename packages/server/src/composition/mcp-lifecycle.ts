import type { CharacterSkillAdapterRegistry } from '../skills/skill-adapter.js'
import type { McpSkillAdapter } from '../skills/mcp-skill-adapter.js'

const MCP_DISCOVERY_TIMEOUT_MS = 5_000

/** User-configured MCP discovery is best-effort and may never gate startup. */
export async function refreshMcpCatalog(adapter: McpSkillAdapter, registry: CharacterSkillAdapterRegistry): Promise<void> {
  try {
    await withTimeout(adapter.refresh(), MCP_DISCOVERY_TIMEOUT_MS)
  } catch (error) {
    adapter.clear()
    console.warn('[dsh-cyber] MCP 工具目录刷新失败，本次保持为空：', error instanceof Error ? error.message : String(error))
  }
  registry.refresh(adapter)
}

function withTimeout<T>(work: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`操作超过 ${milliseconds} 毫秒未完成`)), milliseconds)
    timer.unref?.()
    work.then(resolve, reject).finally(() => clearTimeout(timer))
  })
}

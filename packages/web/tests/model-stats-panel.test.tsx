import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelStatsResponse } from '@dsh-cyber/contracts'
import '../src/i18n/model-hub-messages.js'
import { setUiLocale } from '../src/i18n/runtime.js'
setUiLocale('zh-CN')
import { ModelStatsPanel } from '../src/features/model-hub/ModelStatsPanel.js'
import { fetchModelStats, type HubProvider } from '../src/features/model-hub/api.js'
vi.mock('../src/features/model-hub/api.js', () => ({ fetchModelStats: vi.fn() }))
const fetchStats = vi.mocked(fetchModelStats)
let root: Root; let node: HTMLDivElement
function result(tokens = 10): ModelStatsResponse {
  return { summary: { totalTokensSent: tokens, totalTokensReceived: 5, totalRequests: 1, totalToolCalls: 4, successCount: 1, successRate: 100, avgLatencyMs: 40 },
    items: [{ id: '', name: '系统', tokensSent: tokens, tokensReceived: 5, requests: 1, toolCalls: 4, successCount: 1 }], providers: [] }
}
function deferred() { let resolve!: (value: ModelStatsResponse) => void; let reject!: (e: Error) => void; const promise = new Promise<ModelStatsResponse>((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
async function render(workspaceId = 'ws') { await act(async () => root.render(createElement(ModelStatsPanel, { workspaceId, providers: [{ id: 'p1', workspaceId, name: '服务商一' }] as HubProvider[] }))) }
async function click(text: string) { const button = [...node.querySelectorAll('button')].find((b) => b.textContent === text || b.getAttribute('aria-label') === text)!; expect(button).toBeTruthy(); await act(async () => button.click()) }
const inputValue = () => node.querySelector('.model-hub__stat-card strong')?.textContent
beforeEach(() => { vi.useRealTimers(); fetchStats.mockReset(); fetchStats.mockResolvedValue(result()); node = document.createElement('div'); document.body.append(node); root = createRoot(node) })
afterEach(() => { act(() => root.unmount()); node.remove(); vi.restoreAllMocks() })
describe('model stats state-owned requests', () => {
  it('loads once and changes 7/30/all on the first click with one active range', async () => {
    await render(); expect(fetchStats).toHaveBeenCalledTimes(1)
    await click('近 30 天'); expect(fetchStats).toHaveBeenCalledTimes(2)
    const p = fetchStats.mock.calls[1]![1]!; expect(Date.parse(p.to!) - Date.parse(p.from!)).toBe(30 * 86_400_000)
    expect(node.querySelectorAll('.model-hub__stats-time [aria-pressed="true"]')).toHaveLength(1)
    expect(node.querySelector('.model-hub__stats-time [aria-pressed="true"]')?.textContent).toBe('近 30 天')
    await act(async () => (node.querySelector('.model-hub__stats-time button:last-child') as HTMLButtonElement).click())
    expect(fetchStats.mock.calls[2]![1]!.from).toBe(new Date(0).toISOString())
    await click('近 7 天'); const q = fetchStats.mock.calls[3]![1]!; expect(Date.parse(q.to!) - Date.parse(q.from!)).toBe(7 * 86_400_000)
  })
  it('uses the stable provider key, not its display name', async () => {
    await render(); await click('服务商一')
    expect(fetchStats.mock.calls[1]![1]).toMatchObject({ groupBy: 'provider', providerId: 'provider:p1' })
  })
  it('ignores late old responses and aborts them without showing mismatched numbers', async () => {
    const old = deferred(); const fresh = deferred(); fetchStats.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
    await render(); await click('近 30 天'); expect(fetchStats.mock.calls[0]![2]?.aborted).toBe(true)
    expect(inputValue()).toBeUndefined()
    await act(async () => fresh.resolve(result(99))); expect(inputValue()).toBe('99')
    await act(async () => old.resolve(result(11))); expect(inputValue()).toBe('99')
  })
  it('refreshes fixed filters instead of returning an indefinitely cached result', async () => {
    await render(); fetchStats.mockResolvedValueOnce(result(88)); await click('刷新统计')
    expect(fetchStats).toHaveBeenCalledTimes(2); expect(inputValue()).toBe('88')
  })
  it('does not reuse a response from a previous workspace', async () => {
    await render(); const next = deferred(); fetchStats.mockReturnValueOnce(next.promise); await render('other')
    expect(inputValue()).toBeUndefined(); expect(fetchStats.mock.calls[1]![0]).toBe('other')
    await act(async () => next.resolve(result(55))); expect(inputValue()).toBe('55')
  })
  it('renders loading, failures and real empty results as distinct states', async () => {
    const pending = deferred(); fetchStats.mockReturnValueOnce(pending.promise); await render()
    expect(node.textContent).toContain('加载中'); expect(node.textContent).not.toContain('尚无交互记录')
    await act(async () => pending.reject(new Error('网络错误'))); expect(node.querySelector('[role="alert"]')?.textContent).toBe('网络错误'); expect(node.textContent).not.toContain('尚无交互记录')
    const empty = result(0); empty.items = []; empty.summary.totalRequests = 0; fetchStats.mockResolvedValueOnce(empty); await click('刷新统计')
    expect(node.textContent).toContain('尚无交互记录'); expect(node.querySelector('[role="alert"]')).toBeNull()
  })
  it('discards failures that belong to an old selection', async () => {
    const pending = deferred(); fetchStats.mockReturnValueOnce(pending.promise); await render(); await click('近 30 天')
    await act(async () => pending.reject(new Error('旧请求失败')))
    expect(node.querySelector('[role="alert"]')).toBeNull(); expect(inputValue()).toBe('10')
  })
})

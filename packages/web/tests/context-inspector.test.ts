import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ContextInspection } from '@dsh-cyber/contracts'

import { ContextInspectorPanel } from '../src/components/context-inspector/ContextInspectorPanel.js'
import { setUiLocale } from '../src/i18n/runtime.js'
import '../src/i18n/context-inspector-messages.js'

// The Chinese copy is the safety-relevant wording, so the panel is asserted in
// the locale that wording ships in rather than whatever the test host resolves.
setUiLocale('zh-CN')

const inspection: ContextInspection = {
  conversationId: 'session-1',
  employeeId: 'employee-1',
  employeeName: '小林',
  capturedAt: '2026-08-30T09:00:00.000Z',
  lane: 'direct',
  usedTokens: 1_240,
  budget: { contextWindow: 32_768, inputBudgetTokens: 20_000, memoryTokens: 2_000, historyTokens: 8_000 },
  layers: [
    {
      kind: 'stable-identity',
      id: 'identity:employee-1',
      revision: '3',
      contentHash: '0123456789abcdef0123456789abcdef',
      tokenEstimate: 320,
      sourceCount: 2,
      preview: '你只引用自己真实参与过的经历。',
      previewTruncated: false,
    },
    {
      kind: 'current-request',
      id: 'request:session-1',
      revision: 'fedcba9876543210fedcba9876543210',
      contentHash: 'fedcba9876543210fedcba9876543210',
      tokenEstimate: 40,
      sourceCount: 2,
      preview: '老仓库迁移方案当时怎么定的？',
      previewTruncated: false,
    },
  ],
  memoryHits: [
    {
      memoryId: 'milestone-42',
      scope: 'private',
      score: 3.75,
      reason: '关键词命中：老仓库、迁移｜记忆重要度 0.60',
      occurredAt: '2026-08-20T02:00:00.000Z',
      sourceMessageCount: 4,
      artifactCount: 1,
      summary: '老仓库迁移方案：先冻结写入，再灰度切换。',
    },
  ],
  cache: { state: 'unavailable', stableContextHash: 'aaaabbbbccccddddeeeeffff00001111' },
  coverage: {
    memoryScopes: ['private', 'group', 'task'],
    rawEntryCount: 12,
    droppedOlderEntryCount: 8,
    unrememberedRawEntryCount: 0,
    hydratedMemoryCount: 1,
    hydratedSourceMessageCount: 3,
    rawWindowApplied: true,
    fullReplayFallback: false,
  },
}

afterEach(() => {
  vi.unstubAllGlobals()
})

async function renderPanel(body: unknown, agentRunId?: string): Promise<HTMLElement> {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }))
  vi.stubGlobal('fetch', fetchMock)
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(createElement(ContextInspectorPanel, {
      conversationId: 'session-1',
      demoMode: false,
      ...(agentRunId === undefined ? {} : { agentRunId, onClearRun: () => undefined }),
    }))
  })
  const requested = String((fetchMock.mock.calls[0] as unknown[] | undefined)?.[0] ?? '')
  host.dataset.requested = requested
  return host
}

describe('ContextInspectorPanel', () => {
  it('says what it shows, and never claims to show the model’s reasoning', () => {
    const html = renderToStaticMarkup(createElement(ContextInspectorPanel, { demoMode: false }))
    // The one claim this surface must make, and the one it must never make.
    expect(html).toContain('不是模型的隐藏思维链')
    expect(html).toContain('实际拼装并发送的上下文结构')
    expect(html).not.toMatch(/思维链[^，。]*展示/)
    expect(html).toContain('先在左侧选择一个会话')
  })

  it('shows the layers, the budget and the memory hits of the recorded turn', async () => {
    const host = await renderPanel({ inspection })
    const text = host.textContent ?? ''

    expect(text).toContain('本轮上下文')
    expect(text).toContain('1,240')
    expect(text).toContain('稳定身份')
    expect(text).toContain('本次请求')
    expect(text).toContain('0123456789abcdef0123456789abcdef')
    // A memory hit is explained by id, score and reason, not just listed.
    expect(text).toContain('milestone-42')
    expect(text).toContain('3.75')
    expect(text).toContain('关键词命中')
    expect(text).toContain('来源消息 4 条')
    expect(host.querySelector('.context-inspector__meter')?.getAttribute('aria-label')).toContain('6')
  })

  it('reports missing cache statistics instead of inventing a hit rate', async () => {
    const host = await renderPanel({ inspection })
    const text = host.textContent ?? ''
    expect(text).toContain('本轮无缓存数据')
    // It names the absence rather than showing a number nobody measured.
    expect(text).toContain('不显示命中率')
    expect(text).not.toMatch(/命中的 Token/)
    expect(text).not.toMatch(/未命中的 Token/)
  })

  it('explains an empty record rather than showing a blank panel', async () => {
    const host = await renderPanel({})
    expect(host.textContent ?? '').toContain('发送一条消息后')
  })

  it('asks for the run the trace linked and shows that run’s own record', async () => {
    const host = await renderPanel({ inspection: { ...inspection, agentRunId: 'run-42' } }, 'run-42')
    expect(host.dataset.requested).toContain('/api/agent-runs/run-42/context-inspection')
    const text = host.textContent ?? ''
    expect(text).toContain('正在查看某一次运行的上下文')
    expect(text).toContain('run-42')
    expect(text).toContain('返回会话最新一轮')
    expect(text).toContain('本轮上下文')
    expect(text).toContain('稳定身份')
  })

  it('falls back to the durable snapshot’s numbers and says the full record is gone', async () => {
    const host = await renderPanel({
      snapshot: {
        totalTokenEstimate: 450,
        layers: [{ kind: 'stable-identity', tokenEstimate: 320 }, { kind: 'retrieved-memories', tokenEstimate: 90 }, { kind: 'current-request', tokenEstimate: 40 }],
        memoryHitCount: 2,
        stablePrefixTokens: 320,
        volatileTokens: 130,
        prefixReused: true,
      },
    }, 'run-old')
    const text = host.textContent ?? ''
    expect(text).toContain('持久化快照（仅结构）')
    expect(text).toContain('现已不可用')
    expect(text).toContain('不含任何内容')
    expect(text).toContain('450')
    expect(text).toContain('稳定身份')
    expect(text).toContain('召回的记忆')
    expect(text).toContain('2 条')
    // Nothing the snapshot cannot know is drawn: no preview, no budget, no coverage.
    expect(text).not.toContain('本轮上下文')
    expect(text).not.toContain('这一轮是怎么取舍的')
    expect(host.querySelector('.context-inspector__preview')).toBeNull()
  })

  it('says a run predates snapshots instead of drawing an empty chart', async () => {
    const host = await renderPanel({}, 'run-ancient')
    const text = host.textContent ?? ''
    expect(text).toContain('这次运行没有上下文记录')
    expect(text).toContain('迁移 39')
    expect(text).not.toContain('发送一条消息后')
    expect(host.querySelector('.context-inspector__layers')).toBeNull()
  })
})

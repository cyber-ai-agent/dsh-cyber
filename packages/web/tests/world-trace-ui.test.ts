import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { WorkMessage, World, WorldTraceEntry } from '@dsh-cyber/contracts'

import { ArtifactDock } from '../src/components/ArtifactDock.js'
import { ChatWorkbench, isChatMessage } from '../src/components/ChatWorkbench.js'
import { WorldTraceItem } from '../src/components/world-trace/WorldTraceItem.js'
import { mergeTraceEntries } from '../src/components/world-trace/useWorldTrace.js'

const world: World = {
  id: 'world-1',
  workspaceId: 'workspace-1',
  name: '测试世界',
  templateId: 'personal-world',
  status: 'active',
  createdAt: '2026-08-23T00:00:00.000Z',
  updatedAt: '2026-08-23T00:00:00.000Z',
}

function message(kind: WorkMessage['kind'], content: string, productNotice = false): WorkMessage {
  return {
    id: `${kind}-${content}`,
    sessionId: 'session-1',
    sequence: 1,
    senderId: kind === 'user' ? 'owner' : 'agent-1',
    senderKind: kind === 'user' ? 'owner' : kind === 'system' ? 'system' : 'employee',
    kind,
    content,
    metadata: productNotice ? { productNotice: true } : {},
    createdAt: '2026-08-23T00:00:00.000Z',
  }
}

describe('Chat final-result projection', () => {
  it('keeps final conversation results and removes execution details', () => {
    const messages = [
      message('user', '用户问题'),
      message('reasoning', '不应出现在聊天中的推理'),
      message('tool-call', '不应出现在聊天中的工具调用'),
      message('tool-result', '不应出现在聊天中的工具结果'),
      message('assistant', '最终回答'),
      message('system', '内部协作目标'),
      message('system', '产品通知', true),
    ]
    expect(messages.filter(isChatMessage).map((item) => item.content)).toEqual(['用户问题', '最终回答', '产品通知'])
    const html = renderToStaticMarkup(createElement(ChatWorkbench, {
      demoMode: false,
      world,
      messages,
      employees: [],
      sending: true,
      draft: '',
      onDraftChange: () => undefined,
      onSend: async () => undefined,
      onUploadAttachment: async () => { throw new Error('not used') },
      onOpenDossier: () => undefined,
      onOpenArtifact: () => undefined,
      onRecruit: () => undefined,
    }))
    expect(html).toContain('最终回答')
    expect(html).toContain('产品通知')
    expect(html).toContain('处理中…')
    expect(html).not.toContain('不应出现在聊天中的推理')
    expect(html).not.toContain('工具调用')
  })
})

describe('Trace dock and live merge', () => {
  it('exposes exactly 世界、轨迹、档案 in the right dock', () => {
    const html = renderToStaticMarkup(createElement(ArtifactDock, {
      demoMode: false,
      activeTab: 'trace',
      dossiers: {},
      employees: [],
      world,
      traceContent: createElement('div', {}, '轨迹内容'),
      onTabChange: () => undefined,
      onCollapse: () => undefined,
      onSelectEmployee: () => undefined,
      onDirectEmployee: () => undefined,
      onManageEmployee: () => undefined,
      onShowAllDossiers: () => undefined,
      onInvite: () => undefined,
    }))
    expect(html).toContain('世界')
    expect(html).toContain('轨迹')
    expect(html).toContain('档案')
    expect(html).toContain('轨迹内容')
    expect(html).not.toContain('文件')
    expect(html).not.toContain('预览')
  })

  it('updates one stable visual entry instead of appending a duplicate', () => {
    const running = trace('stable', 'running', '2026-08-23T00:00:00.000Z')
    const completed = trace('stable', 'success', '2026-08-23T00:01:00.000Z')
    expect(mergeTraceEntries([running], [completed])).toEqual([
      expect.objectContaining({ id: 'stable', status: 'success' }),
    ])
  })

  it('does not erase a newer live fact when an older history request completes', () => {
    const live = trace('live-during-refresh', 'running', '2026-08-23T00:02:00.000Z')
    const history = trace('history', 'success', '2026-08-23T00:01:00.000Z')
    expect(mergeTraceEntries([live], [history]).map((entry) => entry.id)).toEqual(['live-during-refresh', 'history'])
  })

  it('renders reasoning and tool facts as keyboard-expandable cards', () => {
    const reasoning = { ...trace('reasoning', 'info', '2026-08-23T00:02:00.000Z'), category: 'agent' as const, summary: '角色生成了推理摘要', detail: '先核对事实，再执行工具。' }
    const tool = { ...trace('tool', 'success', '2026-08-23T00:01:00.000Z'), category: 'tool' as const, summary: '工具执行完成', detail: 'read_file' }
    const html = renderToStaticMarkup(createElement('ol', {},
      createElement(WorldTraceItem, { entry: reasoning, employees: [] }),
      createElement(WorldTraceItem, { entry: tool, employees: [] }),
    ))
    expect(html).toContain('<details>')
    expect(html).toContain('展开推理')
    expect(html).toContain('展开工具详情')
    expect(html).toContain('先核对事实，再执行工具。')
    expect(html).toContain('read_file')
  })
})

function trace(id: string, status: WorldTraceEntry['status'], updatedAt: string): WorldTraceEntry {
  return {
    id,
    worldId: world.id,
    category: 'task',
    status,
    summary: '任务状态',
    sourceKind: 'domain-event',
    sourceId: id,
    createdAt: '2026-08-23T00:00:00.000Z',
    updatedAt,
  }
}

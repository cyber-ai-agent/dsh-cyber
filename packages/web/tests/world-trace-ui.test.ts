import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { WorkMessage, WorkSession, World, WorldTraceEntry } from '@dsh-cyber/contracts'

import { WorldSideDock } from '../src/components/WorldSideDock.js'
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

const session: WorkSession = {
  id: 'session-1',
  workspaceId: world.workspaceId,
  worldId: world.id,
  kind: 'direct',
  title: '与测试角色对话',
  status: 'open',
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
    expect(html).toContain('正在回复中…')
    expect(html).not.toContain('处理中…')
    expect(html).not.toContain('不应出现在聊天中的推理')
    expect(html).not.toContain('工具调用')
  })

  it('opens history from a compact header action instead of rendering a message counter', () => {
    const html = renderToStaticMarkup(createElement(ChatWorkbench, {
      demoMode: false,
      world,
      session,
      messages: [message('user', '当前消息')],
      employees: [],
      draft: '',
      onDraftChange: () => undefined,
      onSend: async () => undefined,
      onUploadAttachment: async () => { throw new Error('not used') },
      onOpenDossier: () => undefined,
      onOpenArtifact: () => undefined,
      onRecruit: () => undefined,
      onOpenHistory: () => undefined,
    }))
    expect(html).toContain('aria-label="查看历史消息"')
    expect(html).toContain('历史消息')
    expect(html).toContain('<h1>测试角色</h1>')
    expect(html).not.toContain('条消息')
  })

  it('keeps the empty center state actionable without exposing an empty history entry', () => {
    const html = renderToStaticMarkup(createElement(ChatWorkbench, {
      demoMode: false,
      world,
      messages: [],
      employees: [],
      draft: '',
      onDraftChange: () => undefined,
      onSend: async () => undefined,
      onUploadAttachment: async () => { throw new Error('not used') },
      onOpenDossier: () => undefined,
      onOpenArtifact: () => undefined,
      onRecruit: () => undefined,
    }))
    expect(html).toContain('选择角色开始对话')
    expect(html).not.toContain('aria-label="查看历史消息"')
  })
})

describe('Trace dock and live merge', () => {
  it('keeps 世界 and 轨迹 fixed while secondary tabs stay behind 更多', () => {
    const html = renderToStaticMarkup(createElement(WorldSideDock, {
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
    expect(html).toContain('更多')
    expect(html).not.toContain('日程')
    expect(html).not.toContain('dock-tabs__more-menu')
    expect(html.match(/class="dock-tab__select"/g)).toHaveLength(2)
    expect(html).toContain('轨迹内容')
    expect(html).not.toContain('文件')
    expect(html).not.toContain('预览')

    const dossierHtml = renderToStaticMarkup(createElement(WorldSideDock, {
      demoMode: false,
      activeTab: 'dossier',
      dossiers: {},
      employees: [],
      world,
      onTabChange: () => undefined,
      onCollapse: () => undefined,
      onSelectEmployee: () => undefined,
      onDirectEmployee: () => undefined,
      onManageEmployee: () => undefined,
      onShowAllDossiers: () => undefined,
      onInvite: () => undefined,
    }))
    expect(dossierHtml).toContain('关闭角色页签')
    expect(dossierHtml).toContain('角色目录')
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
    const reasoning = { ...trace('reasoning', 'info', '2026-08-23T00:02:00.000Z'), category: 'agent' as const, summary: '角色生成了推理摘要', reasoningSummary: '先核对事实，再执行工具。' }
    const tool = { ...trace('tool', 'success', '2026-08-23T00:01:00.000Z'), category: 'tool' as const, summary: '工具执行完成', tools: [{ callId: 'read-1', name: 'read_file', label: '读取文件', description: '读取文件内容用于分析或处理', status: 'success' as const }] }
    const html = renderToStaticMarkup(createElement('ol', {},
      createElement(WorldTraceItem, { entry: reasoning, employees: [] }),
      createElement(WorldTraceItem, { entry: tool, employees: [] }),
    ))
    expect(html).toContain('<details>')
    expect(html.match(/查看过程/g)).toHaveLength(2)
    expect(html).toContain('判断摘要')
    expect(html).toContain('工具调度')
    expect(html).toContain('先核对事实，再执行工具。')
    expect(html).toContain('读取文件')
    expect(html).toContain('读取文件内容用于分析或处理')
    expect(html).toContain('<code>read_file</code>')
  })
})

describe('Trace honesty and run outcome', () => {
  it('renders no 判断摘要 at all when the runtime published no reasoning summary', () => {
    const silent = {
      ...trace('silent-run', 'success', '2026-08-23T00:01:00.000Z'),
      category: 'tool' as const,
      summary: '完成处理，调度了 1 个工具',
      tools: [{ callId: 'write-1', name: 'write_file', label: '写入文件', status: 'success' as const }],
    }
    const html = renderToStaticMarkup(createElement('ol', {}, createElement(WorldTraceItem, { entry: silent, employees: [] })))

    // The card still opens on its real tool facts, and says nothing where the
    // runtime said nothing. No heading, no placeholder, no invented narrative.
    expect(html).toContain('工具调度')
    expect(html).toContain('写入文件')
    expect(html).not.toContain('判断摘要')
    expect(html).not.toContain('暂无')
    expect(html).not.toContain('未提供判断')
    expect(html).not.toContain('思考')
  })

  it('names the artifacts a run produced and hands their id back to the host', () => {
    const opened: string[] = []
    const produced = {
      ...trace('produced', 'success', '2026-08-23T00:03:00.000Z'),
      category: 'tool' as const,
      summary: '完成处理，调度了 1 个工具',
      artifacts: [{ artifactId: 'artifact-7', title: '周度分析报告', kind: 'markdown' as const, version: 2, createdAt: '2026-08-23T00:03:00.000Z' }],
    }
    const html = renderToStaticMarkup(createElement('ol', {}, createElement(WorldTraceItem, {
      entry: produced,
      employees: [],
      onOpenArtifact: (artifactId: string) => { opened.push(artifactId) },
    })))
    expect(html).toContain('产出结果')
    expect(html).toContain('周度分析报告')
    expect(html).toContain('Markdown · v2')
    expect(html).toContain('1 个产物')
    expect(html).toContain('aria-label="打开产物 周度分析报告 · Markdown · v2"')
    expect(opened).toEqual([])
  })

  it('names the real task a run belonged to, and no task for a plain run', () => {
    const fromTask = { ...trace('from-task', 'success', '2026-08-23T00:05:00.000Z'), category: 'agent' as const, sourceKind: 'agent-run' as const, runId: 'run-task', taskId: 'task-77', taskTitle: '整理季度复盘' }
    const plain = { ...trace('plain', 'success', '2026-08-23T00:05:00.000Z'), category: 'agent' as const, sourceKind: 'agent-run' as const, runId: 'run-plain' }
    const taskHtml = renderToStaticMarkup(createElement('ol', {}, createElement(WorldTraceItem, { entry: fromTask, employees: [] })))
    expect(taskHtml).toContain('任务：整理季度复盘')
    expect(taskHtml).toContain('title="task-77"')
    const plainHtml = renderToStaticMarkup(createElement('ol', {}, createElement(WorldTraceItem, { entry: plain, employees: [] })))
    expect(plainHtml).not.toContain('任务：')
  })

  it('shows the snapshot’s per-layer tokens and memory hits inline and links to the run’s context', () => {
    const opened: string[] = []
    const withContext = {
      ...trace('with-context', 'success', '2026-08-23T00:06:00.000Z'),
      category: 'agent' as const,
      sourceKind: 'agent-run' as const,
      runId: 'run-ctx',
      context: {
        totalTokenEstimate: 450,
        layers: [{ kind: 'stable-identity' as const, tokenEstimate: 320 }, { kind: 'retrieved-memories' as const, tokenEstimate: 90 }, { kind: 'current-request' as const, tokenEstimate: 40 }],
        memoryHitCount: 2,
        stablePrefixTokens: 320,
        volatileTokens: 130,
        prefixReused: false,
      },
    }
    const html = renderToStaticMarkup(createElement('ol', {}, createElement(WorldTraceItem, {
      entry: withContext,
      employees: [],
      onOpenContext: (agentRunId: string) => { opened.push(agentRunId) },
    })))
    expect(html).toContain('用了什么上下文')
    expect(html).toContain('稳定身份')
    expect(html).toContain('召回的记忆')
    expect(html).toContain('本次请求')
    expect(html).toContain('命中 2 条')
    expect(html).toContain('上下文 450 Token')
    expect(html).toContain('aria-label="查看运行 run-ctx 的上下文"')
    expect(opened).toEqual([])
  })

  it('offers the context link for a run without a snapshot but draws no numbers for it', () => {
    const noSnapshot = { ...trace('no-snapshot', 'success', '2026-08-23T00:07:00.000Z'), category: 'agent' as const, sourceKind: 'agent-run' as const, runId: 'run-old' }
    const html = renderToStaticMarkup(createElement('ol', {}, createElement(WorldTraceItem, { entry: noSnapshot, employees: [], onOpenContext: () => undefined })))
    expect(html).toContain('查看上下文记录')
    expect(html).not.toContain('命中')
    expect(html).not.toContain('Token（本地估算）')
    // An entry that is not a run gets no context section at all.
    const event = trace('event', 'success', '2026-08-23T00:08:00.000Z')
    const eventHtml = renderToStaticMarkup(createElement('ol', {}, createElement(WorldTraceItem, { entry: event, employees: [], onOpenContext: () => undefined })))
    expect(eventHtml).not.toContain('用了什么上下文')
  })

  it('says nothing about products when the run published none', () => {
    const html = renderToStaticMarkup(createElement('ol', {}, createElement(WorldTraceItem, {
      entry: { ...trace('no-output', 'success', '2026-08-23T00:04:00.000Z'), category: 'agent' as const },
      employees: [],
      onOpenArtifact: () => undefined,
    })))
    expect(html).not.toContain('产出结果')
    expect(html).not.toContain('个产物')
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

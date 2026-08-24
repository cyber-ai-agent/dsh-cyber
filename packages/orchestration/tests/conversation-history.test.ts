import { describe, expect, it } from 'vitest'

import type { JsonObject, WorkMessage } from '@dsh-cyber/contracts'

import {
  buildConversationHistory,
  CONVERSATION_HISTORY_TRUNCATION_NOTICE,
  DEFAULT_CONVERSATION_HISTORY_BUDGET,
  lastAuthoredSequence,
} from '../src/index.js'

let sequence = 0

function message(
  kind: WorkMessage['kind'],
  senderId: string,
  content: string,
  senderKind: WorkMessage['senderKind'] = senderId === 'owner' ? 'owner' : 'employee',
  metadata: JsonObject = {},
): WorkMessage {
  sequence += 1
  return {
    id: `message-${sequence}`,
    sessionId: 'session-1',
    sequence,
    senderId,
    senderKind,
    kind,
    content,
    metadata,
    createdAt: new Date(Date.UTC(2026, 7, 24, 0, 0, sequence)).toISOString(),
  }
}

const SPEAKERS = [
  { id: 'engineer', displayName: '小刘' },
  { id: 'architect', displayName: '老王' },
]

describe('buildConversationHistory', () => {
  it('keeps only user and assistant chat facts', () => {
    const history = buildConversationHistory(
      [
        message('user', 'owner', '帮我看一下登录接口。'),
        message('assistant', 'engineer', '我先建立性能基线。'),
      ],
      SPEAKERS,
    )
    expect(history).toEqual([
      expect.objectContaining({ role: 'user', speakerName: '用户', content: '帮我看一下登录接口。' }),
      expect.objectContaining({ role: 'assistant', speakerName: '小刘', content: '我先建立性能基线。' }),
    ])
  })

  it('excludes reasoning, tool traffic, system notices and transient bubbles', () => {
    const history = buildConversationHistory(
      [
        message('user', 'owner', '帮我看一下登录接口。'),
        message('reasoning', 'engineer', '内部推理不得进入历史。'),
        message('tool-call', 'engineer', '调用工具：read_file'),
        message('tool-result', 'engineer', '工具执行完成'),
        message('system', 'system', '角色协作目标：核对登录链路', 'system'),
        message('assistant', 'system', '产品提示：模型未配置。', 'system'),
        message('assistant', 'engineer', '优化中的临时气泡', 'employee', { localPending: true }),
        message('assistant', 'engineer', '角色协作失败提示', 'employee', { failed: true }),
        message('assistant', 'engineer', '登录接口有一次多余查询。'),
      ],
      SPEAKERS,
    )
    expect(history.map((entry) => entry.content)).toEqual([
      '帮我看一下登录接口。',
      '登录接口有一次多余查询。',
    ])
    const serialized = JSON.stringify(history)
    expect(serialized).not.toContain('内部推理')
    expect(serialized).not.toContain('read_file')
    expect(serialized).not.toContain('产品提示')
    expect(serialized).not.toContain('临时气泡')
  })

  it('redacts credentials that a user pasted into the chat', () => {
    const history = buildConversationHistory(
      [message('user', 'owner', '用这个 key 试试 sk-livesecretkey12345678 谢谢。')],
      SPEAKERS,
    )
    expect(history[0]!.content).not.toContain('sk-livesecretkey12345678')
    expect(history[0]!.content).toContain('[已隐藏敏感信息]')
  })

  it('returns entries in chronological order even when the input is unsorted', () => {
    const first = message('user', 'owner', '第一句')
    const second = message('assistant', 'engineer', '第二句')
    const third = message('user', 'owner', '第三句')
    const history = buildConversationHistory([third, first, second], SPEAKERS)
    expect(history.map((entry) => entry.content)).toEqual(['第一句', '第二句', '第三句'])
  })

  it('keeps the real speaker of every group statement', () => {
    const history = buildConversationHistory(
      [
        message('user', 'owner', '这次发布要不要延后？'),
        message('assistant', 'engineer', '我担心回归测试还没跑完。'),
        message('assistant', 'architect', '我同意延后一天。'),
      ],
      SPEAKERS,
    )
    expect(history.map((entry) => [entry.speakerId, entry.speakerName])).toEqual([
      ['owner', '用户'],
      ['engineer', '小刘'],
      ['architect', '老王'],
    ])
  })

  it('enforces the message-count budget from the newest message backwards', () => {
    const messages = Array.from({ length: 10 }, (_, index) =>
      message(index % 2 === 0 ? 'user' : 'assistant', index % 2 === 0 ? 'owner' : 'engineer', `第 ${index} 条`))
    const history = buildConversationHistory(messages, SPEAKERS, { maxMessages: 4, maxCharacters: 16_000 })
    expect(history).toHaveLength(4)
    expect(history.map((entry) => entry.content)).toEqual(['第 6 条', '第 7 条', '第 8 条', '第 9 条'])
  })

  it('enforces the character budget from the newest message backwards', () => {
    const messages = Array.from({ length: 6 }, (_, index) =>
      message('assistant', 'engineer', 'x'.repeat(100) + String(index)))
    const history = buildConversationHistory(messages, SPEAKERS, { maxMessages: 24, maxCharacters: 220 })
    expect(history).toHaveLength(2)
    expect(history.map((entry) => entry.content.at(-1))).toEqual(['4', '5'])
    const used = history.reduce((total, entry) => total + entry.content.length, 0)
    expect(used).toBeLessThanOrEqual(220)
  })

  it('truncates a single oversized message instead of dropping it silently', () => {
    const history = buildConversationHistory(
      [message('assistant', 'engineer', 'y'.repeat(5_000))],
      SPEAKERS,
      { maxMessages: 24, maxCharacters: 1_000 },
    )
    expect(history).toHaveLength(1)
    expect(history[0]!.content).toContain(CONVERSATION_HISTORY_TRUNCATION_NOTICE)
    expect(history[0]!.content.length).toBeLessThanOrEqual(1_000)
    expect(history[0]!.content.startsWith('yyy')).toBe(true)
  })

  it('does not modify the messages it was given', () => {
    const messages = [
      message('user', 'owner', '第一句'),
      message('reasoning', 'engineer', '内部推理'),
      message('assistant', 'engineer', '第二句'),
    ]
    const snapshot = JSON.parse(JSON.stringify(messages)) as WorkMessage[]
    buildConversationHistory(messages, SPEAKERS)
    expect(messages).toEqual(snapshot)
  })

  it('recovers roughly twelve exchanges by default', () => {
    expect(DEFAULT_CONVERSATION_HISTORY_BUDGET).toEqual({ maxMessages: 24, maxCharacters: 16_000 })
  })

  it('carries the durable sequence of every entry', () => {
    const first = message('user', 'owner', '第一句')
    const second = message('assistant', 'engineer', '第二句')
    const history = buildConversationHistory([first, second], SPEAKERS)
    expect(history.map((entry) => entry.sequence)).toEqual([first.sequence, second.sequence])
  })
})

describe('lastAuthoredSequence', () => {
  it('reports the last conversational statement of one speaker', () => {
    const messages = [
      message('user', 'owner', '问题一'),
      message('assistant', 'engineer', '小刘回答一'),
      message('assistant', 'architect', '老王回答一'),
    ]
    expect(lastAuthoredSequence(messages, 'engineer')).toBe(messages[1]!.sequence)
    expect(lastAuthoredSequence(messages, 'architect')).toBe(messages[2]!.sequence)
    expect(lastAuthoredSequence(messages, 'owner')).toBe(messages[0]!.sequence)
  })

  it('returns 0 for a speaker that has never spoken here', () => {
    expect(lastAuthoredSequence([message('user', 'owner', '问题')], 'engineer')).toBe(0)
  })

  it('ignores reasoning and tool rows so the watermark matches what is replayable', () => {
    const messages = [
      message('assistant', 'engineer', '真正的回答'),
      message('reasoning', 'engineer', '内部推理'),
      message('tool-call', 'engineer', '调用工具：read_file'),
    ]
    expect(lastAuthoredSequence(messages, 'engineer')).toBe(messages[0]!.sequence)
  })
})

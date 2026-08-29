import { describe, expect, it } from 'vitest'

import { GroupIntentRouter } from '../src/services/group-intent-router.js'

describe('GroupIntentRouter', () => {
  const router = new GroupIntentRouter()

  it('keeps questions and open-ended conversation in discussion', () => {
    expect(router.route({ prompt: '大家怎么看这次登录超时？' })).toEqual({
      collaborationMode: 'discussion',
      reason: 'discussion-request',
    })
    expect(router.route({ prompt: '这个登录超时应该怎么修复？' }).collaborationMode).toBe('discussion')
    expect(router.route({ prompt: '晚上好，最近有什么新发现' }).collaborationMode).toBe('discussion')
  })

  it('routes concrete delivery requests into collaboration', () => {
    expect(router.route({ prompt: '请修复登录超时并提交测试结果' })).toEqual({
      collaborationMode: 'task',
      reason: 'deliverable-request',
    })
    expect(router.route({ prompt: '你们分工完成这份发布检查' })).toEqual({
      collaborationMode: 'task',
      reason: 'explicit-collaboration',
    })
    expect(router.route({ prompt: '任务：请读取资料并形成事实总结' }).collaborationMode).toBe('task')
  })

  it('defaults ambiguous group messages to discussion', () => {
    expect(router.route({ prompt: '收到，继续' })).toEqual({
      collaborationMode: 'discussion',
      reason: 'conversation-default',
    })
  })
})

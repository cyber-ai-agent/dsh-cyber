import { describe, expect, it } from 'vitest'
import { parseCreateWorkTask, parseReviewDecision, WorkSystemContractError } from '../src/index.js'

describe('Work System runtime schemas', () => {
  it('parses task creation and review decisions with stable validation', () => {
    expect(parseCreateWorkTask({ title: ' 交付任务 ', description: ' 完成真实闭环 ', priority: 'high' })).toEqual({ title: '交付任务', description: '完成真实闭环', priority: 'high' })
    expect(() => parseCreateWorkTask({ title: '', description: 'x' })).toThrow(WorkSystemContractError)
    expect(parseReviewDecision({ decision: 'accept' })).toEqual({ decision: 'accept', feedback: '' })
    expect(() => parseReviewDecision({ decision: 'request-changes', feedback: '' })).toThrow('必须填写反馈')
  })
})

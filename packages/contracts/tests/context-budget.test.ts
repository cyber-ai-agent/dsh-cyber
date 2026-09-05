import { describe, expect, it } from 'vitest'

import { ContextInputTooLargeError, assertContextInputFits, estimateTextTokens, planContextBudget } from '../src/context-budget.js'

describe('context budget planning', () => {
  it('reserves output and safety space before allocating input sections', () => {
    const plan = planContextBudget({ contextWindow: 8_192, maxOutputTokens: 1_024, fixedText: ['你是一个本地角色。', '检查服务状态'] })
    expect(plan.contextWindow).toBe(8_192)
    expect(plan.maxOutputTokens).toBe(1_024)
    expect(plan.inputBudgetTokens + plan.maxOutputTokens + plan.safetyMarginTokens).toBeLessThanOrEqual(plan.contextWindow)
    expect(plan.workingTokens + plan.historyTokens + plan.memoryTokens + plan.knowledgeTokens + plan.fixedTokens).toBeLessThanOrEqual(plan.inputBudgetTokens)
  })

  it('uses a conservative estimate for Chinese and Latin text', () => {
    expect(estimateTextTokens('你好世界')).toBe(4)
    expect(estimateTextTokens('hello world')).toBeGreaterThanOrEqual(3)
  })

  it('falls back safely when model limits are absent or invalid', () => {
    const plan = planContextBudget({ contextWindow: -1, maxOutputTokens: 99_999_999 })
    expect(plan.contextWindow).toBe(32_768)
    expect(plan.maxOutputTokens).toBeLessThan(plan.contextWindow)
    expect(plan.historyTokens).toBeGreaterThan(plan.memoryTokens)
  })

  it('rejects oversized fixed text instead of reporting a smaller fictional count', () => {
    expect(() => planContextBudget({ contextWindow: 4_096, maxOutputTokens: 1_024, fixedText: ['长设定'.repeat(4_000)] }))
      .toThrow(ContextInputTooLargeError)
  })

  it('allows the exact boundary without inventing a minimum remaining allocation', () => {
    const plan = planContextBudget({ contextWindow: 4_096, maxOutputTokens: 1_024, fixedText: ['中'.repeat(2_560)] })
    expect(plan.fixedTokens).toBe(2_560)
    expect(plan.historyTokens + plan.memoryTokens + plan.workingTokens + plan.knowledgeTokens).toBe(0)
  })

  it('reports only estimates and limits in a rejected input', () => {
    const secret = 'PRIVATE_SOURCE_TEXT'
    try {
      assertContextInputFits([secret], 1)
      throw new Error('expected refusal')
    } catch (error) {
      expect(error).toBeInstanceOf(ContextInputTooLargeError)
      expect(String(error)).toContain('输入过长')
      expect(String(error)).not.toContain(secret)
      expect(JSON.stringify(error)).not.toContain(secret)
    }
  })
})

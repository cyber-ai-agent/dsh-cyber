import { describe, expect, it } from 'vitest'

import { estimateTextTokens, planContextBudget } from '../src/context-budget.js'

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

  it('never over-allocates a small window with a large fixed prompt', () => {
    const plan = planContextBudget({ contextWindow: 4_096, maxOutputTokens: 1_024, fixedText: ['长设定'.repeat(4_000)] })
    expect(plan.fixedTokens + plan.workingTokens + plan.historyTokens + plan.memoryTokens + plan.knowledgeTokens).toBeLessThanOrEqual(plan.inputBudgetTokens)
  })
})

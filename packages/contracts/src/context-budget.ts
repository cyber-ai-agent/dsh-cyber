export interface ContextBudgetPlan {
  contextWindow: number
  maxOutputTokens: number
  safetyMarginTokens: number
  inputBudgetTokens: number
  fixedTokens: number
  workingTokens: number
  historyTokens: number
  memoryTokens: number
  knowledgeTokens: number
}

export interface ContextBudgetInput {
  contextWindow?: number
  maxOutputTokens?: number
  fixedText?: readonly string[]
}

export interface TokenEstimator {
  estimate(text: string): number
}

export const approximateTokenEstimator: TokenEstimator = {
  estimate: estimateTextTokens,
}

const HAN_CHARACTER = /\p{Script=Han}/u

export function estimateTextTokens(value: string): number {
  const text = value.normalize('NFC')
  if (!text) return 0
  let han = 0
  let other = 0
  for (const character of text) {
    if (HAN_CHARACTER.test(character)) han += 1
    else other += character.length
  }
  return Math.max(1, Math.ceil(han + other / 3.5))
}

export function planContextBudget(input: ContextBudgetInput, estimator: TokenEstimator = approximateTokenEstimator): ContextBudgetPlan {
  const contextWindow = boundedInteger(input.contextWindow, 32_768, 4_096, 4_000_000)
  const safetyMarginTokens = Math.max(512, Math.floor(contextWindow * 0.05))
  const outputLimit = Math.max(256, contextWindow - safetyMarginTokens - 1_024)
  const defaultOutput = Math.min(outputLimit, 8_192, Math.max(1_024, Math.floor(contextWindow * 0.2)))
  const maxOutputTokens = boundedInteger(input.maxOutputTokens, defaultOutput, 256, outputLimit)
  const inputBudgetTokens = contextWindow - maxOutputTokens - safetyMarginTokens
  const fixedTokens = Math.min(inputBudgetTokens - 512, (input.fixedText ?? []).reduce((total, value) => total + estimator.estimate(value), 0))
  const allocatable = Math.max(512, inputBudgetTokens - fixedTokens)
  const historyTokens = Math.max(1, Math.floor(allocatable * 0.52))
  const memoryTokens = Math.max(1, Math.floor(allocatable * 0.14))
  const knowledgeTokens = Math.max(1, Math.floor(allocatable * 0.18))
  const workingTokens = Math.max(1, allocatable - historyTokens - memoryTokens - knowledgeTokens)
  return {
    contextWindow,
    maxOutputTokens,
    safetyMarginTokens,
    inputBudgetTokens,
    fixedTokens,
    workingTokens,
    historyTokens,
    memoryTokens,
    knowledgeTokens,
  }
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  return Number.isSafeInteger(value) && value! >= minimum && value! <= maximum ? value! : fallback
}

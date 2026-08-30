import { estimateTextTokens, planContextBudget } from '../packages/contracts/lib/context-budget.js'
import { formatRecoveredHistoryPrompt } from '../packages/harness-adapter/lib/history-prompt.js'

const history = Array.from({ length: 10_000 }, (_, index) => ({
  role: index % 2 === 0 ? 'user' : 'assistant',
  sequence: index + 1,
  speakerId: index % 2 === 0 ? 'owner' : 'employee',
  speakerName: index % 2 === 0 ? '用户' : '员工',
  content: `第 ${index + 1} 轮：${'这是用于验证长会话上下文预算、摘要检查点和恢复性能的内容。'.repeat(4)}`,
  createdAt: '2026-08-31T00:00:00.000Z',
}))
const currentPrompt = '请根据最近上下文继续处理当前任务。'
const plan = planContextBudget({ contextWindow: 32_768, maxOutputTokens: 8_192, fixedText: ['角色 Persona', currentPrompt] })
const originalTokens = history.reduce((total, entry) => total + estimateTextTokens(entry.content), 0)
const startedAt = performance.now()
const prompt = formatRecoveredHistoryPrompt(history, currentPrompt, { maxTokens: plan.historyTokens })
const durationMs = performance.now() - startedAt
const jsonLine = prompt.split('\n').find((line) => line.startsWith('{"type":"recovered_conversation_history"'))
if (jsonLine === undefined) throw new Error('Recovered history envelope missing')
const envelope = JSON.parse(jsonLine)
const recoveredTokens = estimateTextTokens(prompt) - estimateTextTokens(currentPrompt)
const gates = {
  durationUnder250Ms: durationMs < 250,
  recoveredWithinBudget: recoveredTokens <= plan.historyTokens + 512,
  checkpointCreated: Number(envelope.checkpoint?.entryCount ?? 0) > 0,
  recentHistoryRetained: Number(envelope.entries?.at(-1)?.sequence ?? 0) === history.length,
}
const output = {
  historyEntries: history.length,
  originalTokens,
  contextWindow: plan.contextWindow,
  historyBudgetTokens: plan.historyTokens,
  recoveredTokens,
  recentEntries: envelope.entries.length,
  checkpointEntries: envelope.checkpoint.entryCount,
  durationMs,
  reductionRatio: recoveredTokens / originalTokens,
  gates,
}
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
if (Object.values(gates).some((value) => value === false)) process.exitCode = 1

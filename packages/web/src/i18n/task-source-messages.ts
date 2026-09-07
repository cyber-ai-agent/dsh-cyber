import type { UiLocale } from '@dsh-cyber/contracts'
import { defineLocaleCatalogs } from './catalog-parity.js'
import { registerMessages } from './runtime.js'

const zh = {
  'task.source.repeat': '重新执行任务',
  'task.source.confirmed': '已确认完成',
  'task.source.saved': '完成状态已保存，原对话和已有成果保留。',
  'task.source.working': '来源对话正在处理，任务进度会自动更新，无需再次执行。',
  'task.source.finished': '对话执行已结束，请核对下方结果。目标已达成时可直接确认完成。',
  'task.source.interrupted': '来源对话未正常结束。请核对已有成果，已完成的任务可以直接确认，无需重新执行。',
  'task.source.pruned': '来源执行记录已清理，任务确认状态不受影响。',
  'task.source.restart': '服务重启时，本次对话的执行记录被标记为中断。',
  'task.source.diagnostic': '查看中断详情',
  'task.source.noResult': '没有找到可关联的已保存结果。可以回到原对话核对；系统不会把中断自动算作完成。',
  'task.source.reply': '{name} 的已保存回复',
  'task.source.truncated': '此处展示部分内容，完整结果保留在来源对话。',
  'task.source.more': '还有更多结果，请在来源对话或产物中心查看。',
  'task.source.noteLabel': '完成说明',
  'task.source.notePlaceholder': '例如：图片已生成，并已核对保存的结果。',
  'task.source.confirm': '确认完成',
  'task.source.confirmHint': '确认只保存你的完成判断，不会再次调用模型或执行工具。',
} as const
const en: Record<keyof typeof zh, string> = {
  'task.source.repeat': 'Run task again',
  'task.source.confirmed': 'Completion confirmed',
  'task.source.saved': 'Completion is saved. The original conversation and results are preserved.',
  'task.source.working': 'The source conversation is working. Progress updates automatically; no second run is needed.',
  'task.source.finished': 'The conversation has finished. Check the results below and confirm completion when the objective is met.',
  'task.source.interrupted': 'The source conversation did not finish normally. Check existing results and confirm completed work without running it again.',
  'task.source.pruned': 'Source execution history was pruned. Your completion decision is preserved.',
  'task.source.restart': 'A service restart marked this conversation as interrupted.',
  'task.source.diagnostic': 'View interruption details',
  'task.source.noResult': 'No saved results are linked to this turn. Check the original conversation; interruption is never automatically treated as completion.',
  'task.source.reply': 'Saved reply from {name}',
  'task.source.truncated': 'This preview is partial. The full result remains in the source conversation.',
  'task.source.more': 'More results are available in the source conversation or artifact center.',
  'task.source.noteLabel': 'Completion note',
  'task.source.notePlaceholder': 'For example: the image was generated and I checked the saved result.',
  'task.source.confirm': 'Confirm completion',
  'task.source.confirmHint': 'This records your decision only. No model or tool is run again.',
}
const tw: Record<keyof typeof zh, string> = {
  'task.source.repeat': '重新執行任務', 'task.source.confirmed': '已確認完成',
  'task.source.saved': '完成狀態已儲存，原對話和已有成果保留。',
  'task.source.working': '來源對話正在處理，任務進度會自動更新，無需再次執行。',
  'task.source.finished': '對話執行已結束，請核對下方結果。目標已達成時可直接確認完成。',
  'task.source.interrupted': '來源對話未正常結束。請核對已有成果，已完成的任務可以直接確認，無需重新執行。',
  'task.source.pruned': '來源執行記錄已清理，任務確認狀態不受影響。',
  'task.source.restart': '服務重啟時，本次對話的執行記錄被標記為中斷。',
  'task.source.diagnostic': '查看中斷詳情',
  'task.source.noResult': '沒有找到可關聯的已儲存結果。可以回到原對話核對；系統不會把中斷自動算作完成。',
  'task.source.reply': '{name} 的已儲存回覆',
  'task.source.truncated': '此處顯示部分內容，完整結果保留在來源對話。',
  'task.source.more': '還有更多結果，請在來源對話或產物中心查看。',
  'task.source.noteLabel': '完成說明', 'task.source.notePlaceholder': '例如：圖片已產生，並已核對儲存的結果。',
  'task.source.confirm': '確認完成', 'task.source.confirmHint': '確認只儲存你的完成判斷，不會再次呼叫模型或執行工具。',
}
// Explicit gaps use the application's existing English fallback, never Chinese
// literals on an English/non-Chinese page. Parity remains compile-time checked.
const gap = Object.fromEntries(Object.keys(zh).map((key) => [key, null])) as Record<keyof typeof zh, null>
export const TASK_SOURCE_CATALOGS = defineLocaleCatalogs({
  'zh-CN': zh, 'zh-TW': tw, 'en-US': en,
  'ja-JP': gap, 'ko-KR': gap, 'es-ES': gap, 'fr-FR': gap, 'de-DE': gap,
  'pt-BR': gap, 'ru-RU': gap, 'ar-SA': gap, 'hi-IN': gap,
})
for (const [locale, messages] of Object.entries(TASK_SOURCE_CATALOGS)) registerMessages(locale as UiLocale, messages)

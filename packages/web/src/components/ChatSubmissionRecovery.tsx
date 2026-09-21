import { CircleNotch, Paperclip } from '@phosphor-icons/react'
import { useChatSubmissions, type ChatSubmission } from '../chat-submission-store.js'

export function ChatSubmissionRecovery({ ownerKey, hasDraft, onRetry, onRestore }: {
  ownerKey: string | undefined
  hasDraft: boolean
  onRetry(submission: ChatSubmission): Promise<void>
  onRestore(submission: ChatSubmission): void
}) {
  const items = useChatSubmissions().filter((item) => item.ownerKey === ownerKey)
  if (items.length === 0) return null
  return <section className="composer-recovery" aria-label="待确认的发送">
    {items.map((item) => <article key={item.id}>
      <div role="status"><strong>{item.status === 'sending' ? '正在发送…' : item.status === 'rejected' ? '发送失败，内容已保留' : '提交尚未确认，内容已保留'}</strong>
        <p>{item.status === 'sending' ? '正在等待服务端确认接收。' : item.error ?? '连接已中断，可使用原提交核对接收结果。'}</p></div>
      {item.status === 'sending' ? null : <>
        <details><summary>查看保留的内容{item.draft.attachments.length > 0 ? ` · ${item.draft.attachments.length} 个附件` : ''}</summary>
          <p className="composer-recovery__text">{item.draft.text || '附件消息'}</p>
          {item.draft.attachments.map((attachment) => <p key={attachment.id}><Paperclip size={14} /> {attachment.name}</p>)}
        </details>
        <div className="composer-recovery__actions">
          {item.status === 'rejected' ? <button type="button" className="secondary-button" disabled={hasDraft} title={hasDraft ? '请先发送或清空当前草稿，再恢复这条消息。' : '恢复文字、附件和本次模型选择'} onClick={() => onRestore(item)}>恢复到输入框</button> : null}
          <button type="button" className="secondary-button" onClick={() => void onRetry(item)}>重试提交</button>
          <span>{item.status === 'uncertain' ? '使用同一提交核对结果' : '按原内容重新提交'}</span>
        </div>
      </>}
      {item.status === 'sending' ? <CircleNotch size={16} className="spin" aria-hidden="true" /> : null}
    </article>)}
  </section>
}

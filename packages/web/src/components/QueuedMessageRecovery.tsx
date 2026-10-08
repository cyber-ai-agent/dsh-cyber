import { composerDraftStore, useComposerDraft } from '../composer-draft-store.js'

export function QueuedMessageRecovery({ ownerKey, onRestored }: {
  ownerKey: string | undefined
  onRestored(): void
}) {
  const draft = useComposerDraft(ownerKey)
  const recalled = draft.recalledMessage
  if (recalled === undefined) return null
  const occupied = draft.text.length > 0 || draft.attachments.length > 0
  return <section className="composer-recovery" aria-label="已撤回的排队消息">
    <article>
      <div role="status"><strong>排队消息已撤回，内容已保留</strong><p>当前草稿已保留。发送或清空草稿后，可恢复这条消息继续编辑。</p></div>
      <details><summary>查看撤回的内容{recalled.attachments.length > 0 ? ` · ${recalled.attachments.length} 个附件` : ''}</summary>
        <p className="composer-recovery__text">{recalled.text}</p>
        {recalled.attachments.map((attachment) => <p key={attachment.id}>{attachment.name}</p>)}
      </details>
      <div className="composer-recovery__actions"><button type="button" className="secondary-button" disabled={occupied} onClick={() => {
        if (composerDraftStore.restoreRecalledMessage(ownerKey)) onRestored()
      }}>恢复撤回消息</button></div>
    </article>
  </section>
}

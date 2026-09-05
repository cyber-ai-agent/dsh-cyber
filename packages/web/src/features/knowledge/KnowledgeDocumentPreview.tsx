import { CaretLeft, CaretRight, SpinnerGap, WarningCircle } from '@phosphor-icons/react'
import { useEffect, useRef, useState } from 'react'

import { useI18n } from '../../i18n/runtime.js'

import {
  fetchKnowledgeDocumentPreview,
  type KnowledgeDocument,
  type KnowledgeDocumentPreview as KnowledgeDocumentPreviewPayload,
} from './useWorldKnowledge.js'

const WINDOW_PARAGRAPHS = 4

export interface KnowledgeDocumentPreviewProps {
  worldId: string
  document: KnowledgeDocument
  /** The row's expansion state; the body is only fetched once it is open. */
  open: boolean
  demoMode: boolean
}

/**
 * The document body, one window at a time.
 *
 * A knowledge row used to expand to a path and a set of actions, which told the
 * reader where the file is but never what it says. This reads the text the
 * library extracted when it indexed the source, in bounded windows, and states
 * which part is on screen. Paragraphs are rendered as characters — imported
 * content is untrusted data, so nothing here becomes markup, and the sandboxed
 * artifact preview response stays the only surface that renders a document.
 */
export function KnowledgeDocumentPreview({ worldId, document, open, demoMode }: KnowledgeDocumentPreviewProps) {
  const { t } = useI18n()
  const [offset, setOffset] = useState(0)
  const [preview, setPreview] = useState<KnowledgeDocumentPreviewPayload>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [attempt, setAttempt] = useState(0)
  const requestGeneration = useRef(0)

  useEffect(() => {
    setOffset(0)
    setPreview(undefined)
    setError(undefined)
  }, [document.id, document.updatedAt, document.chunkCount])

  useEffect(() => {
    if (!open || demoMode) return undefined
    const generation = ++requestGeneration.current
    setLoading(true)
    setError(undefined)
    void fetchKnowledgeDocumentPreview(worldId, document.id, { offset, limit: WINDOW_PARAGRAPHS })
      .then((value) => {
        if (generation !== requestGeneration.current) return
        setPreview(value)
        setLoading(false)
      })
      .catch((cause: unknown) => {
        if (generation !== requestGeneration.current) return
        setError(cause instanceof Error && /[㐀-鿿]/u.test(cause.message) ? cause.message : t('knowledge.previewError', '正文暂时无法读取，请稍后重试。'))
        setLoading(false)
      })
    return () => { requestGeneration.current += 1 }
  }, [attempt, demoMode, document.id, offset, open, t, worldId])

  if (!open) return null
  if (demoMode) return <p className="knowledge-preview__state">{t('knowledge.previewDemo', '演示世界不提供资料正文预览。')}</p>
  if (error !== undefined) {
    return <p className="knowledge-preview__state knowledge-preview__state--error" role="alert">
      <WarningCircle size={14} aria-hidden="true" />
      <span>{error}</span>
      <button type="button" onClick={() => setAttempt((value) => value + 1)}>{t('knowledge.libraryRetry', '重试')}</button>
    </p>
  }
  if (preview === undefined) {
    return <p className="knowledge-preview__state" role="status"><SpinnerGap size={14} className="knowledge-spin" aria-hidden="true" /><span>{t('knowledge.previewLoading', '正在读取正文…')}</span></p>
  }
  if (!preview.previewable) {
    return <p className="knowledge-preview__state knowledge-preview__state--refused">{t('knowledge.previewUnsupported', '未解析为文本，无法预览')}</p>
  }
  if (preview.total === 0 || preview.paragraphs.length === 0) {
    return <p className="knowledge-preview__state">{t('knowledge.previewEmpty', '这份资料还没有解析出可预览的正文。')}</p>
  }

  const from = preview.offset + 1
  const to = preview.offset + preview.paragraphs.length
  const hasPrevious = preview.offset > 0
  const hasNext = preview.nextOffset !== undefined
  return <section className="knowledge-preview" aria-label={`${document.title} - ${t('knowledge.previewTitle', '资料正文')}`} aria-busy={loading}>
    <p className="knowledge-preview__range">{t('knowledge.previewRange', '第 {from}–{to} 段 · 共 {total}', { from, to, total: preview.total })}</p>
    <div className="knowledge-preview__body" tabIndex={0} role="group" aria-label={t('knowledge.previewTitle', '资料正文')}>
      {preview.paragraphs.map((paragraph) => <p key={paragraph.ordinal}>{paragraph.text}</p>)}
    </div>
    {hasPrevious || hasNext ? <div className="knowledge-preview__pager">
      <button type="button" disabled={!hasPrevious || loading} onClick={() => setOffset(Math.max(0, preview.offset - WINDOW_PARAGRAPHS))}><CaretLeft size={14} aria-hidden="true" />{t('knowledge.previewPrevious', '上一段')}</button>
      <button type="button" disabled={!hasNext || loading} onClick={() => setOffset(preview.nextOffset ?? preview.offset)}>{t('knowledge.previewNext', '下一段')}<CaretRight size={14} aria-hidden="true" /></button>
    </div> : null}
  </section>
}

import {
  ArrowLeft,
  ArrowRight,
  CalendarBlank,
  ClockCounterClockwise,
  MagnifyingGlass,
  UserCircle,
  X,
} from '@phosphor-icons/react'
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import type { WorkMessage, WorkSession } from '@dsh-cyber/contracts'

import { api } from '../api.js'
import type { CyberEmployee } from '../types.js'
import { Avatar } from './Avatar.js'
import { isChatMessage } from './ChatWorkbench.js'

export const MESSAGE_PAGE_SIZE = 20

interface MessageHistoryDialogProps {
  demoMode: boolean
  session: WorkSession
  employees: CyberEmployee[]
  /** The complete local demo transcript; production history is loaded page-by-page. */
  demoMessages?: WorkMessage[]
  onClose(): void
}

interface MessageHistoryPage {
  items: WorkMessage[]
  total: number
  page: number
  pageSize: number
  hasMore: boolean
}

export function MessageHistoryDialog({ demoMode, session, employees, demoMessages, onClose }: MessageHistoryDialogProps) {
  const [searchDraft, setSearchDraft] = useState('')
  const [dateDraft, setDateDraft] = useState('')
  const [search, setSearch] = useState('')
  const [date, setDate] = useState('')
  const [pageNumber, setPageNumber] = useState(1)
  const [result, setResult] = useState<MessageHistoryPage>({ items: [], total: 0, page: 1, pageSize: MESSAGE_PAGE_SIZE, hasMore: false })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [reloadRequest, setReloadRequest] = useState(0)
  const requestIdRef = useRef(0)

  const load = useCallback(async (signal?: AbortSignal) => {
    const requestId = requestIdRef.current + 1
    requestIdRef.current = requestId
    setLoading(true)
    setError(undefined)
    try {
      if (demoMode) {
        const normalizedSearch = search.toLocaleLowerCase()
        const filtered = (demoMessages ?? [])
          .filter((message) => message.sessionId === session.id && isChatMessage(message))
          .filter((message) => normalizedSearch.length === 0 || message.content.toLocaleLowerCase().includes(normalizedSearch))
          .filter((message) => date.length === 0 || message.createdAt.slice(0, 10) === date)
          .sort((left, right) => left.sequence - right.sequence)
        const offset = (pageNumber - 1) * MESSAGE_PAGE_SIZE
        const items = filtered.slice(offset, offset + MESSAGE_PAGE_SIZE)
        if (requestId === requestIdRef.current) {
          setResult({ items, total: filtered.length, page: pageNumber, pageSize: MESSAGE_PAGE_SIZE, hasMore: offset + items.length < filtered.length })
        }
        return
      }
      const query = new URLSearchParams({ view: 'chat', limit: String(MESSAGE_PAGE_SIZE), page: String(pageNumber) })
      if (search) query.set('q', search)
      if (date) query.set('date', date)
      const next = await api<MessageHistoryPage>(
        `/api/sessions/${encodeURIComponent(session.id)}/messages?${query.toString()}`,
        signal === undefined ? undefined : { signal },
      )
      if (requestId === requestIdRef.current) setResult(next)
    } catch (cause) {
      if (requestId !== requestIdRef.current) return
      if (signal?.aborted && signal.reason === 'history-request-cancelled') return
      setError(signal?.aborted && signal.reason === 'history-request-timeout'
        ? '历史消息加载超时，请重试。'
        : cause instanceof Error ? cause.message : '历史消息加载失败')
    } finally {
      if (requestId === requestIdRef.current) setLoading(false)
    }
  }, [date, demoMessages, demoMode, pageNumber, search, session.id])

  useEffect(() => {
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort('history-request-timeout'), 10_000)
    void load(controller.signal).finally(() => window.clearTimeout(timeout))
    return () => {
      window.clearTimeout(timeout)
      controller.abort('history-request-cancelled')
    }
  }, [load, reloadRequest])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const applyFilters = useCallback(() => {
    setSearch(searchDraft.trim())
    setDate(dateDraft)
    setPageNumber(1)
  }, [dateDraft, searchDraft])

  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    applyFilters()
  }

  useEffect(() => {
    const timer = window.setTimeout(applyFilters, 220)
    return () => window.clearTimeout(timer)
  }, [applyFilters])

  const groupedItems = useMemo(() => {
    const groups: Array<{ date: string; items: WorkMessage[] }> = []
    for (const item of result.items) {
      const dateKey = item.createdAt.slice(0, 10)
      const existing = groups[groups.length - 1]
      if (existing?.date === dateKey) existing.items.push(item)
      else groups.push({ date: dateKey, items: [item] })
    }
    return groups
  }, [result.items])

  return (
    <div className="modal-backdrop message-history-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section className="message-history-dialog" role="dialog" aria-modal="true" aria-labelledby="message-history-title">
        <header className="message-history-dialog__header">
          <div className="message-history-dialog__title">
            <span className="message-history-dialog__icon" aria-hidden="true"><ClockCounterClockwise size={22} weight="duotone" /></span>
            <div><h2 id="message-history-title">历史消息</h2><p>{displaySessionTitle(session)} · 共 {result.total} 条可查看消息</p></div>
          </div>
          <button className="icon-button" type="button" aria-label="关闭历史消息" onClick={onClose}><X size={20} /></button>
        </header>

        <form className="message-history-dialog__filters" onSubmit={submitSearch}>
          <label className="message-history-dialog__search"><MagnifyingGlass size={18} aria-hidden="true" /><input aria-label="搜索历史消息" value={searchDraft} onChange={(event) => setSearchDraft(event.target.value)} placeholder="搜索消息内容" /></label>
          <label className="message-history-dialog__date" title="按日期筛选"><CalendarBlank size={18} aria-hidden="true" /><input aria-label="按日期筛选" type="date" value={dateDraft} onChange={(event) => setDateDraft(event.target.value)} /></label>
          {search || date || searchDraft || dateDraft ? <button className="text-button" type="button" onClick={() => { setSearchDraft(''); setDateDraft(''); setSearch(''); setDate(''); setPageNumber(1) }}>清除筛选</button> : <span className="message-history-dialog__filter-hint">输入即筛选</span>}
        </form>

        <div className="message-history-dialog__body" aria-live="polite" aria-busy={loading}>
          {loading ? <div className="message-history-dialog__state">正在加载历史消息…</div> : error !== undefined ? <div className="message-history-dialog__state message-history-dialog__state--error" role="alert"><span>{error}</span><button className="secondary-button" type="button" onClick={() => setReloadRequest((value) => value + 1)}>重新加载</button></div> : groupedItems.length === 0 ? <div className="message-history-dialog__state">没有找到符合条件的消息。</div> : groupedItems.map((group) => (
            <section className="message-history-group" key={group.date}>
              <h3>{formatDateHeading(group.date)}</h3>
              <ol>
                {group.items.map((message) => {
                  const employee = employees.find((item) => item.id === message.senderId)
                  const owner = message.senderKind === 'owner'
                  return <li key={message.id} className={owner ? 'message-history-item message-history-item--owner' : 'message-history-item'}>
                    {owner ? <span className="message-history-item__avatar message-history-item__avatar--owner" aria-label="我的头像"><UserCircle size={24} weight="fill" /></span> : <Avatar index={employee?.avatarIndex ?? 7} size="sm" label={employee?.displayName ?? '角色'} />}
                    <div className="message-history-item__content"><div><strong>{owner ? '我' : employee?.displayName ?? '角色'}</strong><time>{formatTime(message.createdAt)}</time></div><p>{highlightMessage(message.content, search)}</p></div>
                  </li>
                })}
              </ol>
            </section>
          ))}
        </div>

        <footer className="message-history-dialog__footer">
          <span>{result.total === 0 ? '暂无消息' : `第 ${result.page} / ${Math.max(1, Math.ceil(result.total / result.pageSize))} 页`}</span>
          <div><button className="secondary-button" type="button" disabled={loading || pageNumber <= 1} onClick={() => setPageNumber((value) => Math.max(1, value - 1))}><ArrowLeft size={16} />上一页</button><button className="secondary-button" type="button" disabled={loading || !result.hasMore} onClick={() => setPageNumber((value) => value + 1)}>下一页<ArrowRight size={16} /></button></div>
        </footer>
      </section>
    </div>
  )
}

function displaySessionTitle(session: WorkSession): string {
  if (session.kind !== 'direct') return session.title
  const title = session.title.replace(/^与\s*/, '').replace(/\s*对话$/, '').trim()
  return title.length > 0 ? title : session.title
}

function formatDateHeading(value: string): string {
  const parsed = new Date(`${value}T00:00:00`)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' })
}

function formatTime(value: string): string {
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

function highlightMessage(content: string, query: string): ReactNode {
  const normalizedContent = content.replace(/\s+/g, ' ').trim()
  const normalizedQuery = query.trim()
  if (normalizedQuery.length === 0) return normalizedContent

  const lowerContent = normalizedContent.toLocaleLowerCase()
  const lowerQuery = normalizedQuery.toLocaleLowerCase()
  const parts: ReactNode[] = []
  let cursor = 0
  let matchIndex = lowerContent.indexOf(lowerQuery, cursor)
  while (matchIndex >= 0) {
    if (matchIndex > cursor) parts.push(normalizedContent.slice(cursor, matchIndex))
    parts.push(<mark className="message-history-highlight" key={`${matchIndex}-${normalizedQuery}`}>{normalizedContent.slice(matchIndex, matchIndex + normalizedQuery.length)}</mark>)
    cursor = matchIndex + normalizedQuery.length
    matchIndex = lowerContent.indexOf(lowerQuery, cursor)
  }
  if (cursor === 0) return normalizedContent
  if (cursor < normalizedContent.length) parts.push(normalizedContent.slice(cursor))
  return parts
}

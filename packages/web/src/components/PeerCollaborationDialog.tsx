import { ChatsCircle, X } from '@phosphor-icons/react'
import { useEffect, useMemo, useRef, useState } from 'react'

import type { CyberEmployee } from '../types.js'
import { Avatar } from './Avatar.js'

export interface PeerCollaborationDraft {
  participantIds: string[]
  purpose: string
  maxRounds: number
}

interface PeerCollaborationDialogProps {
  initiator: CyberEmployee
  employees: CyberEmployee[]
  busy: boolean
  error?: string
  onClose(): void
  onCreate(input: PeerCollaborationDraft): void
}

export function PeerCollaborationDialog({ initiator, employees, busy, error, onClose, onCreate }: PeerCollaborationDialogProps) {
  const purposeRef = useRef<HTMLInputElement>(null)
  const candidates = useMemo(
    () => employees.filter((employee) => employee.id !== initiator.id && employee.status !== 'archived'),
    [employees, initiator.id],
  )
  const [selectedIds, setSelectedIds] = useState<string[]>(() => candidates[0] === undefined ? [] : [candidates[0].id])
  const [purpose, setPurpose] = useState(`请与相关角色讨论当前工作进展，核对事实并形成可执行的下一步。`)
  const [maxRounds, setMaxRounds] = useState(1)

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    purposeRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      previous?.focus()
    }
  }, [busy, onClose])

  const toggle = (employeeId: string) => {
    if (busy) return
    setSelectedIds((current) => current.includes(employeeId)
      ? current.filter((id) => id !== employeeId)
      : current.length >= 3 ? current : [...current, employeeId])
  }

  const submit = () => {
    const normalizedPurpose = purpose.trim()
    if (busy || selectedIds.length < 1 || !normalizedPurpose) return
    onCreate({ participantIds: selectedIds, purpose: normalizedPurpose, maxRounds })
  }

  return (
    <div className="modal-backdrop group-dialog-backdrop" onMouseDown={(event) => { if (!busy && event.target === event.currentTarget) onClose() }}>
      <section className="group-dialog" role="dialog" aria-modal="true" aria-labelledby="peer-dialog-title">
        <header className="group-dialog__header">
          <div>
            <span><ChatsCircle size={16} weight="fill" /> 角色自主协作</span>
            <h2 id="peer-dialog-title">让 {initiator.displayName} 去沟通</h2>
            <p>他们会使用各自的模型、权限和长期记忆真实讨论，结果会沉淀为共同经历。</p>
          </div>
          <button className="icon-button" type="button" aria-label="关闭角色协作" disabled={busy} onClick={onClose}><X size={18} /></button>
        </header>

        <div className="group-dialog__body">
          <div className="group-dialog__name">
            <span>发起角色</span>
            <div className="group-member is-selected">
              <Avatar index={initiator.avatarIndex} label={initiator.displayName} status={initiator.status} />
              <span><strong>{initiator.displayName}</strong><small>{initiator.role} · 将在每轮最后归纳</small></span>
            </div>
          </div>

          <label className="group-dialog__name">
            <span>讨论目标</span>
            <input
              ref={purposeRef}
              value={purpose}
              maxLength={2_000}
              disabled={busy}
              onChange={(event) => setPurpose(event.target.value)}
              placeholder="例如：向开发工程师确认项目进度，并整理成可向我汇报的结论"
              aria-label="角色协作目标"
            />
          </label>

          <label className="group-dialog__name">
            <span>讨论轮次</span>
            <select value={maxRounds} disabled={busy} onChange={(event) => setMaxRounds(Number(event.target.value))} aria-label="角色协作轮次">
              <option value={1}>1 轮 · 快速确认</option>
              <option value={2}>2 轮 · 允许追问</option>
              <option value={3}>3 轮 · 深入讨论</option>
            </select>
          </label>

          <div className="group-dialog__list" role="group" aria-label="选择协作对象">
            {candidates.map((employee) => {
              const selected = selectedIds.includes(employee.id)
              return (
                <label key={employee.id} className={`group-member${selected ? ' is-selected' : ''}`}>
                  <input type="checkbox" checked={selected} disabled={busy} onChange={() => toggle(employee.id)} />
                  <Avatar index={employee.avatarIndex} label={employee.displayName} status={employee.status} />
                  <span><strong>{employee.displayName}</strong><small>{employee.role} · {employee.currentActivity}</small></span>
                </label>
              )
            })}
            {candidates.length === 0 ? <p>当前世界还没有其他可协作角色。</p> : null}
          </div>
          {error === undefined ? null : <p role="alert" className="settings-inline-error">{error}</p>}
        </div>

        <footer className="group-dialog__footer">
          <span>已选择 {selectedIds.length} 名对象 · 最多 3 名</span>
          <div>
            <button className="secondary-button" type="button" disabled={busy} onClick={onClose}>取消</button>
            <button className="primary-button" type="button" disabled={busy || selectedIds.length < 1 || !purpose.trim()} onClick={submit}>
              {busy ? '角色正在会合…' : '开始真实协作'}
            </button>
          </div>
        </footer>
      </section>
    </div>
  )
}

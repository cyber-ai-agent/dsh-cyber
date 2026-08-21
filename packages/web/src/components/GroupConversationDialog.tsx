import { MagnifyingGlass, UsersThree, X } from '@phosphor-icons/react'
import { useEffect, useMemo, useRef, useState } from 'react'

import type { CyberEmployee } from '../types.js'
import { Avatar } from './Avatar.js'

interface GroupConversationDialogProps {
  employees: CyberEmployee[]
  onClose(): void
  onCreate(input: { title: string; employeeIds: string[] }): void
}

export function GroupConversationDialog({ employees, onClose, onCreate }: GroupConversationDialogProps) {
  const searchRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [title, setTitle] = useState('')
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const filteredEmployees = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    if (!normalized) return employees
    return employees.filter((employee) => `${employee.displayName} ${employee.role}`.toLocaleLowerCase().includes(normalized))
  }, [employees, query])

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    searchRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      previous?.focus()
    }
  }, [onClose])

  const toggle = (employeeId: string) => {
    setSelectedIds((current) => current.includes(employeeId)
      ? current.filter((id) => id !== employeeId)
      : [...current, employeeId])
  }

  const submit = () => {
    if (selectedIds.length < 2) return
    const selectedEmployees = selectedIds
      .map((id) => employees.find((employee) => employee.id === id))
      .filter((employee): employee is CyberEmployee => employee !== undefined)
    onCreate({
      title: title.trim() || selectedEmployees.map((employee) => employee.displayName).join('、'),
      employeeIds: selectedIds,
    })
  }

  return (
    <div className="modal-backdrop group-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section className="group-dialog" role="dialog" aria-modal="true" aria-labelledby="group-dialog-title">
        <header className="group-dialog__header">
          <div>
            <span><UsersThree size={16} weight="fill" /> 当前世界</span>
            <h2 id="group-dialog-title">创建群聊</h2>
            <p>选择至少两名角色。群聊会在你发送第一条消息时正式创建。</p>
          </div>
          <button className="icon-button" type="button" aria-label="关闭创建群聊" onClick={onClose}><X size={18} /></button>
        </header>

        <div className="group-dialog__body">
          <label className="group-dialog__search">
            <MagnifyingGlass size={17} />
            <input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索角色或角色" aria-label="搜索群聊成员" />
          </label>
          <label className="group-dialog__name">
            <span>群聊名称</span>
            <input value={title} maxLength={48} onChange={(event) => setTitle(event.target.value)} placeholder="可选，默认使用成员名称" />
          </label>

          <div className="group-dialog__list" role="group" aria-label="选择群聊成员">
            {filteredEmployees.map((employee) => {
              const selected = selectedIds.includes(employee.id)
              return (
                <label key={employee.id} className={`group-member${selected ? ' is-selected' : ''}`}>
                  <input type="checkbox" checked={selected} onChange={() => toggle(employee.id)} />
                  <Avatar index={employee.avatarIndex} label={employee.displayName} status={employee.status} />
                  <span><strong>{employee.displayName}</strong><small>{employee.role} · {employee.currentActivity}</small></span>
                </label>
              )
            })}
          </div>
        </div>

        <footer className="group-dialog__footer">
          <span>已选择 {selectedIds.length} 人</span>
          <div>
            <button className="secondary-button" type="button" onClick={onClose}>取消</button>
            <button className="primary-button" type="button" disabled={selectedIds.length < 2} onClick={submit}>创建群聊</button>
          </div>
        </footer>
      </section>
    </div>
  )
}

import { MagnifyingGlass, UsersThree, X } from '@phosphor-icons/react'
import { useEffect, useMemo, useRef, useState } from 'react'

import type { CyberEmployee } from '../types.js'
import { Avatar } from './Avatar.js'

interface GroupConversationDialogProps {
  employees: CyberEmployee[]
  creating?: boolean
  onClose(): void
  onCreate(input: { title: string; employeeIds: string[] }): Promise<void>
}

export function GroupConversationDialog({ employees, creating = false, onClose, onCreate }: GroupConversationDialogProps) {
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
      if (event.key === 'Escape' && !creating) onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      previous?.focus()
    }
  }, [creating, onClose])

  const toggle = (employeeId: string) => {
    setSelectedIds((current) => current.includes(employeeId)
      ? current.filter((id) => id !== employeeId)
      : [...current, employeeId])
  }

  return (
    <div className="modal-backdrop group-dialog-backdrop" onMouseDown={(event) => { if (!creating && event.target === event.currentTarget) onClose() }}>
      <section className="group-dialog" role="dialog" aria-modal="true" aria-labelledby="group-dialog-title">
        <header className="group-dialog__header">
          <div>
            <span><UsersThree size={16} weight="fill" /> 当前世界</span>
            <h2 id="group-dialog-title">创建群聊</h2>
            <p>选择至少两名角色，创建后立即出现在左侧会话列表。</p>
          </div>
          <button className="icon-button" type="button" aria-label="关闭创建群聊" disabled={creating} onClick={onClose}><X size={18} /></button>
        </header>

        <div className="group-dialog__body">
          <label className="group-dialog__search">
            <MagnifyingGlass size={17} />
            <input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索角色或职责" aria-label="搜索群聊成员" />
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
                  <input type="checkbox" checked={selected} disabled={creating} onChange={() => toggle(employee.id)} />
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
            <button className="secondary-button" type="button" disabled={creating} onClick={onClose}>取消</button>
            <button className="primary-button" type="button" disabled={creating || selectedIds.length < 2} onClick={() => void onCreate({
              title: title.trim() || selectedIds.map((id) => employees.find((employee) => employee.id === id)?.displayName).filter((name): name is string => name !== undefined).join('、'),
              employeeIds: selectedIds,
            })}>{creating ? '正在创建…' : '创建群聊'}</button>
          </div>
        </footer>
      </section>
    </div>
  )
}

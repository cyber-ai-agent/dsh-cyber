import {
  AddressBook,
  ChatsCircle,
  ClipboardText,
  Robot,
  UsersThree,
  Wrench,
  X,
} from '@phosphor-icons/react'
import type { WorldRuntimeObjectState, WorldThemeInteractableManifest } from '@dsh-cyber/contracts'

import type { CyberEmployee } from '../../types.js'
import { Avatar } from '../../components/Avatar.js'

interface EmployeeMenuProps {
  employee: CyberEmployee
  onClose(): void
  onTalk(): void
  onAssignTask(): void
  onMeeting(): void
  onDossier?(): void
}

export function EmployeeInteractionMenu({ employee, onClose, onTalk, onAssignTask, onMeeting, onDossier }: EmployeeMenuProps) {
  return (
    <aside className="world-context-menu" aria-label={`${employee.displayName}情境操作`}>
      <header>
        <Avatar index={employee.avatarIndex} size="lg" label={employee.displayName} />
        <div><span><i className={`status-pip status-pip--${employee.status}`} />独立角色</span><strong>{employee.displayName}</strong><small>{employee.role} · {employee.currentActivity}</small></div>
        <button type="button" aria-label="关闭操作菜单" onClick={onClose}><X size={16} /></button>
      </header>
      <div className="world-context-menu__actions">
        <button type="button" onClick={onTalk}><ChatsCircle size={18} /><span><strong>直接对话</strong><small>进入这名角色的独立会话</small></span></button>
        <button type="button" onClick={onAssignTask}><ClipboardText size={18} /><span><strong>安排任务</strong><small>让角色前往可用工作区域执行</small></span></button>
        <button type="button" onClick={onMeeting}><UsersThree size={18} /><span><strong>邀请协作</strong><small>与其他角色发起一次协作</small></span></button>
        {onDossier === undefined ? null : <button type="button" onClick={onDossier}><AddressBook size={18} /><span><strong>角色档案</strong><small>成长、技能、日志与事迹</small></span></button>}
      </div>
    </aside>
  )
}

interface ObjectMenuProps {
  object: WorldRuntimeObjectState
  manifest: WorldThemeInteractableManifest
  selectedEmployee?: CyberEmployee
  onClose(): void
  onAction(actionId: WorldThemeInteractableManifest['actions'][number]['id']): void
}

export function ObjectInteractionMenu({ object, manifest, selectedEmployee, onClose, onAction }: ObjectMenuProps) {
  return (
    <aside className="world-context-menu world-context-menu--object" aria-label={`${object.displayName}情境操作`}>
      <header>
        <span className="world-context-menu__object-icon">{manifest.kind === 'meeting-table' ? <UsersThree size={23} /> : manifest.kind === 'workstation' ? <Robot size={23} /> : <Wrench size={23} />}</span>
        <div><span>场景设施 · {object.state === 'active' ? '使用中' : '可用'}</span><strong>{object.displayName}</strong><small>{selectedEmployee === undefined ? '先选择一名角色，或直接查看设施' : `${selectedEmployee.displayName} 已准备执行`}</small></div>
        <button type="button" aria-label="关闭操作菜单" onClick={onClose}><X size={16} /></button>
      </header>
      <div className="world-context-menu__actions">
        {manifest.actions.map((action) => (
          <button key={action.id} type="button" onClick={() => onAction(action.id)}>
            {action.id === 'start-meeting' ? <UsersThree size={18} /> : action.id === 'assign-task' ? <ClipboardText size={18} /> : <Wrench size={18} />}
            <span><strong>{action.label}</strong><small>{selectedEmployee === undefined ? '执行后将记录为世界事件' : `由 ${selectedEmployee.displayName} 执行`}</small></span>
          </button>
        ))}
      </div>
    </aside>
  )
}

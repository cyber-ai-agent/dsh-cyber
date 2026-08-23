import { AddressBook, ChatsCircle, ClipboardText, Robot, UsersThree, Wrench } from '@phosphor-icons/react'
import type { WorldRuntimeObjectState, WorldThemeInteractableManifest } from '@dsh-cyber/contracts'

import { ContextMenu, type ContextMenuPosition } from '../../components/ContextMenu.js'
import type { CyberEmployee } from '../../types.js'

interface EmployeeMenuProps {
  employee: CyberEmployee
  position?: ContextMenuPosition
  onClose(): void
  onTalk(): void
  onAssignTask(): void
  onMeeting(): void
  onPeerCollaboration?(): void
  onDossier?(): void
}

export function EmployeeInteractionMenu({ employee, position, onClose, onTalk, onAssignTask, onMeeting, onPeerCollaboration, onDossier }: EmployeeMenuProps) {
  if (position === undefined) return null
  return <ContextMenu label={`${employee.displayName}情境操作`} position={position} onClose={onClose} items={[
    { id: 'talk', label: '直接对话', description: `打开与${employee.displayName}的私聊`, icon: <ChatsCircle size={18} />, onSelect: onTalk },
    { id: 'task', label: '安排任务', description: '提交消息后才会开始执行', icon: <ClipboardText size={18} />, onSelect: onAssignTask },
    ...(onPeerCollaboration === undefined ? [] : [{ id: 'peer', label: '让他去沟通', description: '选择其他角色发起真实讨论', icon: <UsersThree size={18} />, onSelect: onPeerCollaboration }]),
    { id: 'meeting', label: '发起多人协作', description: '创建包含你的群聊', icon: <UsersThree size={18} />, onSelect: onMeeting },
    ...(onDossier === undefined ? [] : [{ id: 'dossier', label: '查看角色档案', description: '身份、能力与成长记录', icon: <AddressBook size={18} />, onSelect: onDossier }]),
  ]} />
}

interface ObjectMenuProps {
  object: WorldRuntimeObjectState
  manifest: WorldThemeInteractableManifest
  selectedEmployee?: CyberEmployee
  position?: ContextMenuPosition
  onClose(): void
  onAction(actionId: WorldThemeInteractableManifest['actions'][number]['id']): void
}

export function ObjectInteractionMenu({ object, manifest, selectedEmployee, position, onClose, onAction }: ObjectMenuProps) {
  if (position === undefined) return null
  return <ContextMenu label={`${object.displayName}设施操作`} position={position} onClose={onClose} items={manifest.actions.map((action) => ({
    id: action.id,
    label: action.label,
    description: selectedEmployee === undefined ? '选择角色后执行' : `由${selectedEmployee.displayName}执行`,
    icon: action.id === 'start-meeting' ? <UsersThree size={18} /> : action.id === 'assign-task' ? <ClipboardText size={18} /> : manifest.kind === 'workstation' ? <Robot size={18} /> : <Wrench size={18} />,
    onSelect: () => onAction(action.id),
  }))} />
}

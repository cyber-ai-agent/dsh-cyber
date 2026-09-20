import { ArrowUp, Clock, DotsThree, PencilSimple, Trash } from '@phosphor-icons/react'
import { useState } from 'react'
import type { PendingChatTurn } from '../chat-realtime.js'
import { ContextMenu, type ContextMenuPosition } from './ContextMenu.js'

export function ChatQueuePanel({ turns, running, saturated, onEdit, onPromote, onCancel }: {
  turns: PendingChatTurn[]
  running: boolean
  saturated: boolean
  onEdit?: ((id: string) => Promise<void>) | undefined
  onPromote?: ((id: string) => Promise<void>) | undefined
  onCancel?: ((id: string) => Promise<void>) | undefined
}) {
  const [menu, setMenu] = useState<{ turn: PendingChatTurn; position: ContextMenuPosition }>()
  if (turns.length === 0) return null
  return <section className="chat-queue" aria-label="待处理消息">
    <header><Clock size={16} /><strong>待处理 {turns.length}</strong><span>{saturated ? '角色通道可用后继续' : running ? '当前回复结束后依次处理' : '等待角色处理'}</span></header>
    <div className="chat-queue__items">{turns.map((turn) => <div className="chat-queue__row" key={turn.id}>
      <p title={turn.content ?? turn.title}>{turn.content ?? turn.title}</p>
      <small>已接收</small>
      <button type="button" aria-label={`排队消息操作：${turn.content ?? turn.title}`} aria-haspopup="menu" onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setMenu({ turn, position: { x: rect.right - 220, y: rect.bottom + 6 } }) }}><DotsThree size={21} weight="bold" /></button>
    </div>)}</div>
    {menu === undefined || !turns.some((turn) => turn.id === menu.turn.id) ? null : <ContextMenu label="排队消息操作" position={menu.position} onClose={() => setMenu(undefined)} items={[
      ...(onEdit === undefined ? [] : [{ id: 'edit', label: '编辑排队消息', icon: <PencilSimple size={17} />, onSelect: () => void onEdit(menu.turn.id) }]),
      ...(onPromote === undefined ? [] : [{ id: 'priority', label: '优先处理', icon: <ArrowUp size={17} />, onSelect: () => void onPromote(menu.turn.id) }]),
      ...(onCancel === undefined ? [] : [{ id: 'cancel', label: '取消排队消息', icon: <Trash size={17} />, danger: true, onSelect: () => void onCancel(menu.turn.id) }]),
    ]} />}
  </section>
}

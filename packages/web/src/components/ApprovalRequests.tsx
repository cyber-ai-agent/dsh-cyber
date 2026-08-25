import { useState } from 'react'

import type { ApprovalRequestView, ApprovalScope } from '@dsh-cyber/contracts'

export interface ApprovalRequestsProps {
  items: ApprovalRequestView[]
  onDecide: (approvalId: string, decision: 'approved' | 'rejected', scope: ApprovalScope) => Promise<void>
}

const RISK_LABEL: Record<string, string> = {
  'external-side-effect': '会影响真实世界',
  'workspace-write': '会修改本地文件',
  'read-only': '只读取信息',
}

/**
 * The decision surface of the approval gate.
 *
 * The gate refuses to execute anything a person has not approved, which makes
 * this component the only way an external action can ever happen. It therefore
 * shows the concrete call — adapter, action, target, parameters — rather than a
 * one-line summary: consenting to "关闭厨房灯" is not the same as consenting to
 * whatever that label happens to be attached to.
 */
export function ApprovalRequests({ items, onDecide }: ApprovalRequestsProps) {
  const [busyId, setBusyId] = useState<string>()
  const [error, setError] = useState<string>()

  if (items.length === 0) return null

  const decide = async (approvalId: string, decision: 'approved' | 'rejected', scope: ApprovalScope) => {
    setBusyId(approvalId)
    setError(undefined)
    try {
      await onDecide(approvalId, decision, scope)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '审批失败，请重试')
    } finally {
      setBusyId(undefined)
    }
  }

  return (
    <section className="approval-requests" aria-label="等待你批准的真实动作">
      {items.map((item) => {
        const subject = item.subject
        const busy = busyId === item.request.id
        const parameters = Object.entries(subject?.parameters ?? {})
        return (
          <article key={item.request.id} className="approval-request">
            <header>
              <span className="approval-request__risk">{RISK_LABEL[item.request.risk] ?? item.request.risk}</span>
              <strong>{subject?.label ?? item.request.summary}</strong>
            </header>
            <p className="approval-request__who">
              {item.characterName ?? '角色'} 请求执行一个不会自动发生的动作。批准之前不会有任何外部效果。
            </p>
            {subject === undefined ? null : (
              <dl className="approval-request__facts">
                <div><dt>适配器</dt><dd><code>{subject.adapterId}</code></dd></div>
                <div><dt>技能</dt><dd><code>{subject.skillId}</code></dd></div>
                <div><dt>调用</dt><dd><code>{subject.action}</code></dd></div>
                <div><dt>目标</dt><dd><code>{subject.target}</code></dd></div>
                {subject.scheduledFor === undefined ? null : (
                  <div><dt>计划时间</dt><dd>{new Date(subject.scheduledFor).toLocaleString()}</dd></div>
                )}
                {parameters.length === 0 ? null : (
                  <div className="approval-request__parameters">
                    <dt>参数</dt>
                    <dd>
                      {parameters.map(([key, value]) => (
                        <code key={key}>{key}={typeof value === 'string' ? value : JSON.stringify(value)}</code>
                      ))}
                    </dd>
                  </div>
                )}
              </dl>
            )}
            {error === undefined || !busy ? null : <p className="approval-request__error" role="alert">{error}</p>}
            <footer>
              <button type="button" className="primary-button" disabled={busy} onClick={() => void decide(item.request.id, 'approved', 'once')}>
                本次允许
              </button>
              <button type="button" className="text-button" disabled={busy} onClick={() => void decide(item.request.id, 'approved', 'world')}>
                一直允许
              </button>
              <button type="button" className="text-button" disabled={busy} onClick={() => void decide(item.request.id, 'rejected', 'once')}>
                拒绝
              </button>
              <span className="approval-request__expiry">
                {new Date(item.request.expiresAt).toLocaleTimeString()} 前未决定将自动拒绝
              </span>
            </footer>
          </article>
        )
      })}
      {error === undefined || busyId !== undefined ? null : <p className="approval-request__error" role="alert">{error}</p>}
    </section>
  )
}

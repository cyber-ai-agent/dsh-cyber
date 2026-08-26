import { useState } from 'react'

import type { ApprovalRequestView, ApprovalScope } from '@dsh-cyber/contracts'

export interface ApprovalRequestsProps {
  items: ApprovalRequestView[]
  onDecide: (approvalId: string, decision: 'approved' | 'rejected', scope: ApprovalScope) => Promise<void>
}

const RISK_LABEL: Record<string, string> = {
  'external-side-effect': '会影响真实世界',
  'write-local': '会修改本地文件',
  'high-risk': '需要提升操作权限',
  read: '只读取信息',
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
    <section className="approval-requests" aria-label="等待你批准的操作">
      {items.map((item) => {
        const subject = item.subject
        const busy = busyId === item.request.id
        // The server is authoritative. The fallback keeps older snapshots
        // safe while the API rolls out allowedScopes.
        const allowedScopes = item.allowedScopes ?? ['once']
        const hasPersistentScope = allowedScopes.includes('character') || allowedScopes.includes('world')
        const parameters = Object.entries(subject?.parameters ?? {})
        const riskLabel = subject?.action.startsWith('browser.')
          ? '将访问公开网页'
          : RISK_LABEL[item.request.risk] ?? item.request.risk
        const requestDescriptionId = `approval-description-${item.request.id}`
        const requestRiskId = `approval-risk-${item.request.id}`
        const requestScopeId = `approval-scope-${item.request.id}`
        return (
          <article key={item.request.id} className="approval-request" aria-describedby={`${requestRiskId} ${requestDescriptionId}${hasPersistentScope ? '' : ` ${requestScopeId}`}`}>
            <header>
              <span id={requestRiskId} className="approval-request__risk">{riskLabel}</span>
              <strong>{subject?.label ?? item.request.summary}</strong>
            </header>
            <p id={requestDescriptionId} className="approval-request__who">
              {item.characterName ?? '角色'} 请求继续执行当前操作。请核对操作与目标后决定。
            </p>
            {subject === undefined ? null : (
              <dl className="approval-request__facts">
                <div><dt>操作</dt><dd>{subject.label}</dd></div>
                <div><dt>目标</dt><dd><code>{subject.target}</code></dd></div>
                {subject.scheduledFor === undefined ? null : (
                  <div><dt>计划时间</dt><dd>{new Date(subject.scheduledFor).toLocaleString()}</dd></div>
                )}
              </dl>
            )}
            {subject === undefined ? null : <details className="approval-request__technical"><summary>查看技术详情</summary><dl className="approval-request__facts">
              <div><dt>能力标识</dt><dd><code>{subject.skillId}</code></dd></div>
              <div><dt>执行组件</dt><dd><code>{subject.adapterId}</code></dd></div>
              <div><dt>调用</dt><dd><code>{subject.action}</code></dd></div>
              {parameters.length === 0 ? null : <div className="approval-request__parameters"><dt>参数</dt><dd>{parameters.map(([key, value]) => <code key={key}>{key}={typeof value === 'string' ? value : JSON.stringify(value)}</code>)}</dd></div>}
            </dl></details>}
            {error === undefined || !busy ? null : <p className="approval-request__error" role="alert">{error}</p>}
            <footer>
              {allowedScopes.includes('once') ? <button type="button" className="primary-button" disabled={busy} onClick={() => void decide(item.request.id, 'approved', 'once')}>
                本次允许
              </button> : null}
              {!hasPersistentScope ? <span id={requestScopeId} className="approval-request__scope-note" role="note">当前仅支持本次批准</span> : null}
              {allowedScopes.includes('character') ? <button type="button" className="text-button" disabled={busy} onClick={() => void decide(item.request.id, 'approved', 'character')}>本角色持续允许</button> : null}
              {allowedScopes.includes('world') ? <button type="button" className="text-button" disabled={busy} onClick={() => void decide(item.request.id, 'approved', 'world')}>本世界持续允许</button> : null}
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

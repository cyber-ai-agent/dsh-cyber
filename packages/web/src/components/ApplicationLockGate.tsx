import { ArrowLeft, ArrowRight, CheckCircle, Cube, LockKey } from '@phosphor-icons/react'
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'

import { api } from '../api.js'

export interface ApplicationAccessSummary { passwordEnabled: boolean; unlocked: boolean; recoveryConfigured: boolean }
interface ApplicationAccessMutation extends ApplicationAccessSummary { recoveryCode?: string }

export function ApplicationLockGate({ children }: { children: ReactNode }) {
  const [access, setAccess] = useState<ApplicationAccessSummary>()
  const [password, setPassword] = useState('')
  const [recoveryCode, setRecoveryCode] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [mode, setMode] = useState<'unlock' | 'recover'>('unlock')
  const [newRecoveryCode, setNewRecoveryCode] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    let cancelled = false
    void api<{ access: ApplicationAccessSummary }>('/api/application-access')
      .then((result) => { if (!cancelled) setAccess(result.access) })
      .catch((cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : '无法读取应用锁状态') })
    const timer = window.setInterval(() => setNow(new Date()), 30_000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [])

  if (access?.unlocked && newRecoveryCode === undefined) return <>{children}</>

  const unlock = async () => {
    if (!password || busy) return
    setBusy(true); setError(undefined)
    try {
      const result = await api<{ access: ApplicationAccessMutation }>('/api/application-access/unlock', { method: 'POST', body: JSON.stringify({ password }) })
      setPassword('')
      setAccess(result.access)
      setNewRecoveryCode(result.access.recoveryCode)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '解锁失败')
    } finally {
      setBusy(false)
    }
  }

  const recover = async () => {
    if (!recoveryCode.trim() || newPassword.length < 6 || newPassword !== confirmation || busy) return
    setBusy(true); setError(undefined); setNewRecoveryCode(undefined)
    try {
      const result = await api<{ access: ApplicationAccessMutation }>('/api/application-access/recover', { method: 'POST', body: JSON.stringify({ recoveryCode: recoveryCode.trim(), password: newPassword }) })
      setAccess(result.access)
      setRecoveryCode('')
      setNewPassword('')
      setConfirmation('')
      setNewRecoveryCode(result.access.recoveryCode)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '密码恢复失败')
    } finally {
      setBusy(false)
    }
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    void (mode === 'unlock' ? unlock() : recover())
  }

  return <main className="application-lock-screen">
    <div className="application-lock-wallpaper" aria-hidden="true"><i/><i/><i/></div>
    <div className="application-lock-brand"><Cube size={24}/><strong>DSH Cyber</strong></div>
    <div className="application-lock-clock" aria-hidden="true"><time>{now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}</time><span>{now.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })}</span></div>
    <section className="application-lock-panel" aria-labelledby="application-lock-title">
      <span className="application-lock-panel__icon"><LockKey size={24}/></span>
      <h1 id="application-lock-title">欢迎回来</h1>
      <p>{access === undefined && error === undefined ? '正在检查本机访问状态…' : mode === 'recover' ? '使用恢复码设置新的应用密码' : '输入密码进入你的本地工作台'}</p>
      <form className="application-lock-form" onSubmit={submit}>
        {mode === 'unlock' && access?.passwordEnabled ? (
          <label><span className="sr-only">应用访问密码</span><input autoFocus type="password" autoComplete="current-password" value={password} placeholder="密码" onChange={(event) => setPassword(event.target.value)} /><button type="submit" aria-label="解锁应用" disabled={!password || busy}><ArrowRight size={19}/></button></label>
        ) : mode === 'unlock' ? <div className="application-lock-recovery-unavailable" role="status">正在检查本机访问状态…</div>
        : access?.recoveryConfigured ? (
          <div className="application-lock-recovery-fields">
            <label><span>恢复码</span><input autoFocus type="text" autoComplete="one-time-code" spellCheck={false} value={recoveryCode} placeholder="例如 DSH-…" onChange={(event) => setRecoveryCode(event.target.value)} /></label>
            <label><span>新密码</span><input type="password" autoComplete="new-password" value={newPassword} placeholder="至少 6 个字符" onChange={(event) => setNewPassword(event.target.value)} /></label>
            <label><span>再次输入新密码</span><input type="password" autoComplete="new-password" value={confirmation} placeholder="重复输入新密码" onChange={(event) => setConfirmation(event.target.value)} /></label>
            <button className="primary-button" type="submit" disabled={!recoveryCode.trim() || newPassword.length < 6 || newPassword !== confirmation || busy}>{busy ? '正在恢复…' : '重置密码并进入'}</button>
          </div>
        ) : <div className="application-lock-recovery-unavailable" role="status">这个应用锁没有配置恢复码。请联系本机管理员处理本地访问凭据。</div>}
      </form>
      {newRecoveryCode ? <div className="application-lock-recovery-result" role="status"><CheckCircle size={17}/><span><strong>密码已重置，新的恢复码</strong><code>{newRecoveryCode}</code><small>请立即复制并保存在安全位置。它只会显示这一次。</small><div><button className="secondary-button" type="button" onClick={() => void navigator.clipboard?.writeText(newRecoveryCode)}>复制恢复码</button><button className="primary-button" type="button" onClick={() => setNewRecoveryCode(undefined)}>进入工作台</button></div></span></div> : null}
      {error ? <div className="application-lock-error" role="alert">{error}</div> : null}
      {mode === 'unlock' && access?.passwordEnabled ? <button className="application-lock-link" type="button" onClick={() => { setMode('recover'); setError(undefined) }}>忘记密码？使用恢复码</button> : mode === 'recover' ? <button className="application-lock-link" type="button" onClick={() => { setMode('unlock'); setError(undefined) }}><ArrowLeft size={15}/>返回输入密码</button> : null}
    </section>
  </main>
}

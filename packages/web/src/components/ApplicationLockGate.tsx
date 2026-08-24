import { ArrowRight, Cube, LockKey } from '@phosphor-icons/react'
import { useEffect, useState, type ReactNode } from 'react'

import { api } from '../api.js'

export interface ApplicationAccessSummary { passwordEnabled: boolean; unlocked: boolean }

export function ApplicationLockGate({ children }: { children: ReactNode }) {
  const [access, setAccess] = useState<ApplicationAccessSummary>()
  const [password, setPassword] = useState('')
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

  if (access?.unlocked) return <>{children}</>

  const unlock = async () => {
    if (!password || busy) return
    setBusy(true); setError(undefined)
    try {
      const result = await api<{ access: ApplicationAccessSummary }>('/api/application-access/unlock', { method: 'POST', body: JSON.stringify({ password }) })
      setPassword('')
      setAccess(result.access)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '解锁失败')
    } finally {
      setBusy(false)
    }
  }

  return <main className="application-lock-screen">
    <div className="application-lock-wallpaper" aria-hidden="true"><i/><i/><i/></div>
    <div className="application-lock-brand"><Cube size={24}/><strong>DSH Cyber</strong></div>
    <div className="application-lock-clock" aria-hidden="true"><time>{now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}</time><span>{now.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })}</span></div>
    <section className="application-lock-panel" aria-labelledby="application-lock-title">
      <span className="application-lock-panel__icon"><LockKey size={24}/></span>
      <h1 id="application-lock-title">欢迎回来</h1>
      <p>{access === undefined && error === undefined ? '正在检查本机访问状态…' : '输入密码进入你的本地工作台'}</p>
      {access?.passwordEnabled ? <label><span className="sr-only">应用访问密码</span><input autoFocus type="password" autoComplete="current-password" value={password} placeholder="密码" onChange={(event) => setPassword(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void unlock() }}/><button type="button" aria-label="解锁应用" disabled={!password || busy} onClick={() => void unlock()}><ArrowRight size={19}/></button></label> : null}
      {error ? <div className="application-lock-error" role="alert">{error}</div> : null}
    </section>
  </main>
}

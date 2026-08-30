import { ArrowClockwise, DownloadSimple, X } from '@phosphor-icons/react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { EmployeeVoiceProfile, VoiceModelDescriptor } from '@dsh-cyber/contracts'

import { api } from '../../api.js'

interface VoiceModelPackPickerProps {
  value: EmployeeVoiceProfile['provider']
  onActivate(provider: Exclude<EmployeeVoiceProfile['provider'], 'auto'>): void
}

export function VoiceModelPackPicker({ value, onActivate }: VoiceModelPackPickerProps) {
  const [models, setModels] = useState<VoiceModelDescriptor[]>([])
  const [selectedId, setSelectedId] = useState('moss-tts-nano-100m-onnx')
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const result = await api<{ models: VoiceModelDescriptor[] }>('/api/local-tts/models')
      setModels(result.models)
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '语音模型目录加载失败')
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    const active = models.find((model) => model.provider === (value === 'auto' ? 'moss' : value))
    if (active !== undefined) setSelectedId(active.id)
  }, [models, value])
  const hasActiveOperation = models.some((model) => model.state === 'downloading' || model.state === 'verifying')
  useEffect(() => {
    if (!hasActiveOperation) return
    const timer = window.setInterval(() => { void refresh() }, 700)
    return () => window.clearInterval(timer)
  }, [hasActiveOperation, refresh])

  const selected = useMemo(() => models.find((model) => model.id === selectedId), [models, selectedId])
  const selectedTtsProvider = selected !== undefined && isTtsProvider(selected.provider) ? selected.provider : undefined
  const install = async () => {
    if (selected === undefined || busy) return
    setBusy(true); setError(undefined)
    try {
      await api(`/api/local-tts/models/${encodeURIComponent(selected.id)}/install`, { method: 'POST', body: '{}' })
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '语音模型安装失败')
    } finally { setBusy(false) }
  }
  const cancel = async () => {
    if (selected === undefined) return
    await api(`/api/local-tts/models/${encodeURIComponent(selected.id)}/cancel`, { method: 'POST', body: '{}' }).catch(() => undefined)
    await refresh()
  }

  return <section className="voice-model-picker" aria-label="语音模型包">
    <label><span>语音引擎</span><select aria-label="语音引擎" value={selectedId} onChange={(event) => {
      setSelectedId(event.target.value)
    }}>{models.map((model) => <option key={model.id} value={model.id}>{model.displayName}{model.recommended ? ' · 推荐' : ''}{model.state === 'ready' ? ' · 可用' : model.state === 'installed' ? ' · 已安装' : ''}</option>)}</select></label>
    {selected === undefined ? <div className="voice-model-picker__loading" role="status">正在读取语音模型…</div> : <div className="voice-model-picker__detail" data-state={selected.state}>
      <span><strong>{selected.displayName}</strong><small>{selected.summary}</small></span>
      <dl><div><dt>模型大小</dt><dd>{selected.byteLength > 0 ? formatBytes(selected.byteLength) : '由高级运行环境决定'}</dd></div><div><dt>运行方式</dt><dd>{runtimeLabel(selected.runtime)}</dd></div></dl>
      {selected.state === 'not-installed' ? <button type="button" className="voice-model-picker__install" disabled={busy} onClick={() => void install()}><DownloadSimple size={16} aria-hidden="true" />{busy ? '正在准备下载…' : '下载并安装'}</button> : null}
      {selected.state === 'downloading' || selected.state === 'verifying' ? <div className="voice-model-picker__progress" role="status" aria-live="polite"><progress max={selected.progress?.totalBytes ?? selected.byteLength} value={selected.progress?.completedBytes ?? 0} /><span><strong>{selected.state === 'verifying' ? '正在校验' : '正在下载'}</strong><small>{formatBytes(selected.progress?.completedBytes ?? 0)} / {formatBytes(selected.progress?.totalBytes ?? selected.byteLength)}</small></span><button type="button" aria-label="取消语音模型下载" onClick={() => void cancel()}><X size={15} /></button></div> : null}
      {selected.state === 'installed' ? <button type="button" className="voice-model-picker__activate" disabled>已安装，正在接入运行时</button> : null}
      {selected.state === 'ready' && selectedTtsProvider !== undefined ? <button type="button" className="voice-model-picker__activate" onClick={() => onActivate(selectedTtsProvider)}>使用这个引擎</button> : null}
      {selected.state === 'unavailable' ? <div className="voice-model-picker__unavailable"><span>高级模型</span><small>{selected.requirements?.join(' · ') ?? '需要独立运行环境'}</small></div> : null}
      {selected.state === 'error' ? <button type="button" className="voice-model-picker__retry" onClick={() => void install()}><ArrowClockwise size={15} />重试安装</button> : null}
    </div>}
    {error === undefined ? null : <small className="voice-model-picker__error" role="alert">{error}</small>}
  </section>
}

function isTtsProvider(value: VoiceModelDescriptor['provider']): value is Exclude<EmployeeVoiceProfile['provider'], 'auto'> {
  return value === 'system' || value === 'kokoro' || value === 'moss' || value === 'qwen-tts' || value === 'dots-tts' || value === 'cosyvoice'
}

function runtimeLabel(runtime: VoiceModelDescriptor['runtime']): string {
  return ({ system: '系统声音', 'onnx-cpu': '本地 CPU', 'python-cuda': '本地 GPU', external: '外部服务' } as const)[runtime ?? 'external']
}

function formatBytes(value: number): string {
  if (value < 1024 * 1024) return `${Math.max(0, Math.round(value / 1024))} KB`
  return `${(value / 1024 / 1024).toFixed(value >= 100 * 1024 * 1024 ? 0 : 1)} MB`
}
